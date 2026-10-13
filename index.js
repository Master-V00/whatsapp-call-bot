/**
 * whatsapp-call-bot 📞🔊 (عربي + English)
 * ------------------------------------------------
 *  1. رن عليا / call me → مكالمة فيها audio.mp3
 *  2. اتصل وقول "..." / call and say "..." → TTS (ElevenLabs ثم gTTS) + مكالمة
 *  3. ذكرني ... / remind me ... → تذكير برسالة و/أو مكالمة (بمكالمة/with a call)
 *  4. صلاة ... / prayer ... → تذكير الصلوات بمكالمة فيها الأذان كامل
 *  5. مساعدة / help → كل الأوامر
 *
 * المكتبة: @innovatorssoft/baileys v7.4.9 (تدعم المكالمات initiateCall)
 * الربط: Pairing Code (MASTERVO افتراضيًا — من .env)
 */
require('dotenv').config();
const fs = require('fs');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
} = require('@innovatorssoft/baileys');

const { placeCall, isBusy } = require('./lib/call');
const { logger } = require('./lib/logger');
const { normalizeAr, L, escapeReg } = require('./lib/text');
const { generateTtsAudio, probeDurationMs, TTS_MAX_CHARS } = require('./lib/tts');
const { handleRemind, startReminderChecker, setSock: setRemindSock } = require('./lib/reminders');
const { handlePrayer, startPrayerChecker, setSock: setPrayerSock } = require('./lib/prayer');

// ---------- الإعدادات ----------
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/\D/g, '');
const TRIGGER_WORDS = (process.env.TRIGGER_WORDS || 'رن عليا,رن عليا,call me,call,اتصل,اتصل بيا,رن')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const PAIRING_CODE = (process.env.PAIRING_CODE || 'MASTERVO').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MASTERVO';

const formatCode = (code) => {
    const c = String(code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : String(code);
};
// لغة الرد: إنجليزي لو الرسالة لاتينية فقط، غير كده عربي
const guessLang = (text) => (/[\u0600-\u06FF]/.test(text || '') ? 'ar' : 'en');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(msg) {
    const m = msg.message;
    if (!m) return '';
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    return '';
}
function isTrigger(text) {
    // الأمر لازم يكون في أول الجملة (عشان كلمات زي "الفرن" متفعلش البوت)
    // ملحوظة: \b لا يعمل مع العربي، نستخدم (?:\s|$) بدلًا منه
    const t = normalizeAr((text || '').trim().toLowerCase());
    return TRIGGER_RE.test(t);
}
// كلمات التريجر بعد التوحيد، الأطول أولًا (عشان "رن عليا" تتطابق قبل "رن")
const TRIGGER_RE = new RegExp('^(' + TRIGGER_WORDS.map((w) => normalizeAr(w)).map(escapeReg)
    .sort((a, b) => b.length - a.length).join('|') + ')(?:\\s|$)');

// أمر: اتصل وقول "..." / call and say "..." → يرجع {text, lang} أو null
// المطابقة على النص الموحد، والاستخراج من النص الأصلي بنفس الفهارس (التوحيد 1:1)
function parseSayCommand(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const nt = normalizeAr(t);
    const m = /^(اتصل\s+وقول|call\s+and\s+say)\s*[:：]?\s*/is.exec(nt);
    if (!m) return null;
    const body = t.slice(m[0].length).trim().replace(/[""“”]/g, '').trim();
    return { text: body, lang: /^call/i.test(m[1]) ? 'en' : 'ar' };
}

// تصنيف الرسالة لأمر (الأمر لازم يكون في أول الجملة، والمطابقة على النص الموحد)
// الاستخراج من النص الأصلي بنفس الفهارس (التوحيد 1:1). ترجع null لو مش أمر → تجاهل صامت
function classify(text) {
    const t = (text || '').trim();
    if (!t) return null;
    const nt = normalizeAr(t);
    let m = /^(صلاه|صلوات|مواقيت|salah|prayer)(?:\s|$)/is.exec(nt);
    if (m) return { cmd: 'prayer', arg: t.slice(m[0].length).trim(), lang: /^prayer/i.test(nt) ? 'en' : 'ar' };
    m = /^(ذكرني|ذكرتي|تذكير|remind(?:\s+me)?)(?:\s|$)/is.exec(nt);
    if (m) return { cmd: 'remind', arg: t.slice(m[0].length).trim(), lang: /^remind/i.test(nt) ? 'en' : 'ar' };
    const say = parseSayCommand(t);
    if (say) return { cmd: 'say', arg: say.text, lang: say.lang };
    if (/^(مساعده|help|الاوامر|commands)(?:\s|$)/i.test(nt)) return { cmd: 'help', arg: '', lang: guessLang(t) };
    if (isTrigger(t)) return { cmd: 'trigger', arg: '', lang: guessLang(t) };
    return null;
}

// أمر "اتصل وقول": TTS ثم مكالمة
async function handleSayCall(sock, jid, text, lang, quoted) {
    if (isBusy(jid)) {
        await sock.sendMessage(jid, { text: L(lang, '⏳ في مكالمة شغالة، استنى تخلص.', '⏳ A call is in progress, please wait.') }, { quoted }).catch(() => {});
        return;
    }
    if (!text) {
        await sock.sendMessage(jid, { text: L(lang, '✍️ اكتب كده: اتصل وقول "النص اللي عايز تسمعه"', '✍️ Write like: call and say "text to hear"') }, { quoted }).catch(() => {});
        return;
    }
    if (text.length > TTS_MAX_CHARS) {
        await sock.sendMessage(jid, { text: L(lang, `❌ النص طويل (${text.length}). الأقصى ${TTS_MAX_CHARS}.`, `❌ Text too long (${text.length}). Max ${TTS_MAX_CHARS}.`) }, { quoted }).catch(() => {});
        return;
    }
    try {
        await sock.sendMessage(jid, { text: L(lang, `🎙️ بحضّر الصوت...`, `🎙️ Preparing audio...`) }, { quoted }).catch(() => {});
        const { file } = await generateTtsAudio(text);
        const clipMs = await probeDurationMs(file);
        await placeCall(sock, jid, {
            audioPath: file,
            audioDurationMs: (clipMs || 15000), // placeCall يضيف مهلة الرن + ذيل تلقائيًا
            repeatAudio: false,
            preMsg: L(lang, '📞 هرن عليك دلوقتي وأقولك الرسالة... رد 🔊', '📞 Calling you with the message... pick up 🔊'),
            endMsg: L(lang, '✅ خلصت. ابعت "اتصل وقول ..." تاني في أي وقت 🔊', '✅ Done. Send "call and say ..." anytime 🔊'),
            cleanupFile: true,
        });
    } catch (err) {
        logger.error(`say-call failed: ${err?.message || err}`);
        await sock.sendMessage(jid, { text: L(lang, `❌ مقدرتش أحضر الصوت: ${err?.message || err}`, `❌ Could not prepare audio: ${err?.message || err}`) }, { quoted }).catch(() => {});
    }
}

function helpMessage(lang) {
    return L(lang,
        `*قائمة الأوامر*\n` +
        `━━━━━━━━━━━━\n` +
        `*مكالمات:*\n` +
        `1) رن عليا\n` +
        `— أرن عليك وأشغل مقطع audio.mp3\n` +
        `(تنفع: call me / اتصل / رن)\n\n` +
        `2) اتصل وقول "النص"\n` +
        `— أحول النص لصوت وأقوله لك في مكالمة\n` +
        `(تنفع: call and say "text")\n\n` +
        `*تذكير:*\n` +
        `3) ذكرني بعد [الوقت] [النص]\n` +
        `— مثال: ذكرني بعد 10 دقائق الاجتماع\n` +
        `— (تنفع: remind me in 10 minutes meeting)\n\n` +
        `4) ذكرني بعد [الوقت] بمكالمة وقول "نص"\n` +
        `— مثال: ذكرني بعد ساعة بمكالمة وقول "يلا"\n` +
        `— رسالة + مكالمة (لو مفيش وقول، أنطق نص التذكير)\n\n` +
        `5) ذكرني قائمة — عرض التذكيرات النشطة\n` +
        `6) ذكرني الغاء [رقم] — إلغاء تذكير\n\n` +
        `*صلاة (القاهرة):*\n` +
        `7) صلاة تفعيل — مكالمة بالأذان كامل + رسالة عند كل صلاة\n` +
        `8) صلاة حالة — عرض المواقيت\n` +
        `9) صلاة الغاء — إلغاء التذكير\n` +
        `━━━━━━━━━━━━\n` +
        `الوقت: بعد ساعة / بكرة 9 الصبح / 22:30 / 2026-12-25`,
        `*Command List*\n` +
        `━━━━━━━━━━━━\n` +
        `*Calls:*\n` +
        `1) call me\n` +
        `— calls you playing audio.mp3\n` +
        `(also: رن عليا / اتصل / رن)\n\n` +
        `2) call and say "text"\n` +
        `— converts text to speech in a call\n` +
        `(also: اتصل وقول "النص")\n\n` +
        `*Reminders:*\n` +
        `3) remind me in [time] [text]\n` +
        `— example: remind me in 10 minutes meeting\n` +
        `— (also: ذكرني بعد 10 دقائق الاجتماع)\n\n` +
        `4) remind me in [time] with a call saying "text"\n` +
        `— example: remind me in 1 hour with a call saying "go"\n` +
        `— message + call (without saying: speaks the reminder)\n\n` +
        `5) remind list — show active reminders\n` +
        `6) remind cancel [n] — cancel one\n\n` +
        `*Prayer (Cairo):*\n` +
        `7) prayer on — call with full adhan + message\n` +
        `8) prayer status — show times\n` +
        `9) prayer off — disable\n` +
        `━━━━━━━━━━━━\n` +
        `Time: in 1 hour / tomorrow at 9 / at 22:30 / 2026-12-25`);
}

// ---------- الربط Pairing Code ----------
let pairingRequested = false;
let currentRun = 0;
let consecutive401 = 0;

async function requestPairingCodeFlow(sock, runId) {
    if (pairingRequested || sock.authState.creds.registered) return;
    if (!PHONE_NUMBER || PHONE_NUMBER.length < 10) {
        logger.error('Invalid number - set PHONE_NUMBER=2010xxxxxxxx in .env (no +)');
        return;
    }
    pairingRequested = true;
    try {
        await sleep(2500); // important delay, avoids 428/400
        if (runId !== currentRun) return;
        const code = await sock.requestPairingCode(PHONE_NUMBER, PAIRING_CODE);
        console.log('\n' + '='.repeat(50));
        console.log(`Pairing code: ${formatCode(code)}`);
        console.log(`Bot number: ${PHONE_NUMBER}`);
        console.log('Phone: WhatsApp > Settings > Linked devices > Link device');
        console.log('   > "Link with phone number" > enter number then code');
        console.log('Valid ~40s only. A new code appears automatically if it expires.');
        console.log('='.repeat(50) + '\n');
        setTimeout(() => {
            pairingRequested = false;
            console.log('Code expired - a new one will appear automatically...');
        }, 35000);
    } catch (e) {
        pairingRequested = false;
        const msg = e?.message || e?.toString() || '';
        logger.error(`Pairing code request failed: ${msg.slice(0, 200)}`);
        if (msg.includes('429') || msg.includes('rate-overlimit')) logger.error('Temporary rate-limit 15-40 min - wait and retry');
        else if (msg.includes('428') || msg.includes('Connection Closed')) logger.warn('Socket not ready - will retry on next QR');
    }
}

async function start() {
    const runId = ++currentRun;
    const { state, saveCreds } = await useMultiFileAuthState('./auth');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        voip: { maxConcurrentCalls: 3, onLimit: 'reject' },
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered && !PHONE_NUMBER) {
        logger.error('PHONE_NUMBER missing in .env - example: PHONE_NUMBER=2010xxxxxxxx (no +)');
        process.exit(1);
    }

    // الفاحصات الخلفية (تذكيرات + صلاة) كل 10 ثواني
    startReminderChecker();
    startPrayerChecker();

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !sock.authState.creds.registered) {
            requestPairingCodeFlow(sock, runId);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output?.statusCode
                : lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || '';
            logger.info(`connection closed (${statusCode} | ${reason})`);
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                consecutive401++;
                if (consecutive401 > 5) {
                    logger.error('Repeated 401 failures - delete auth folder, check number/network, restart.');
                    return;
                }
                logger.error('401 - removing bad session and retrying...');
                try { fs.rmSync('./auth', { recursive: true, force: true }); } catch {}
                pairingRequested = false;
                setTimeout(() => { if (runId === currentRun) start().catch((e) => logger.error(e)); }, 3000);
            } else {
                consecutive401 = 0;
                setTimeout(() => { if (runId === currentRun) start().catch((e) => logger.error(e)); }, 5000);
            }
        } else if (connection === 'open') {
            consecutive401 = 0;
            setRemindSock(sock);
            setPrayerSock(sock);
            logger.info('Connected - bot is online.');
            console.log('Bot online. Send "help" to see commands.');
        }
    });

    // ---- الراوتر ----
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (msg.key.fromMe || !msg.message) continue;
                const jid = msg.key.remoteJid;
                // خاص فقط: تجاهل الجروبات والقنوات (newsletter) والبرودكاست والحالات
                if (!jid || (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid'))) continue;
                setRemindSock(sock);
                setPrayerSock(sock);

                const text = extractText(msg);
                if (!text.trim()) continue;
                const sender = msg.key.participant || jid;
                const t = text.trim();
                const r = classify(t);
                logger.info(`incoming from ${jid} (${t.length} chars) route=${r ? r.cmd : 'ignore'}`);
                if (!r) continue; // مش أمر → تجاهل صامت

                if (r.cmd === 'prayer') {
                    await handlePrayer(sock, jid, sender, r.arg, r.lang, msg);
                    continue;
                }
                if (r.cmd === 'remind') {
                    await handleRemind(sock, jid, sender, r.arg, r.lang, msg);
                    continue;
                }
                if (r.cmd === 'say') {
                    await handleSayCall(sock, jid, r.arg, r.lang, msg);
                    continue;
                }
                if (r.cmd === 'help') {
                    await sock.sendMessage(jid, { text: helpMessage(r.lang) }, { quoted: msg }).catch(() => {});
                    continue;
                }
                if (r.cmd === 'trigger') {
                    await placeCall(sock, jid, {
                        preMsg: L(r.lang, '📞 هرن عليك دلوقتي وأشغل المقطع الصوتي... رد 🔊', '📞 Calling you with the audio clip... pick up 🔊'),
                        endMsg: L(r.lang, '✅ المكالمة خلصت. ابعت "الاوامر" لعرض كل الأوامر.', '✅ Call ended. Send "commands" for all commands.'),
                    });
                    continue;
                }
            } catch (err) {
                logger.error(`messages.upsert error: ${err?.message || err}`);
            }
        }
    });

    sock.ev.on('call.incoming', async (session) => {
        logger.info(`Incoming call from ${session.peerJid} (callId=${session.callId}) - logged only.`);
    });

    return sock;
}

// وضع اختبار الصوت فقط: node index.js --test-tts "نص" (من غير واتساب)
if (require.main === module) {
    if (process.argv.includes('--test-tts')) {
    const argIdx = process.argv.indexOf('--test-tts');
    const testText = process.argv[argIdx + 1] || 'أهلا بيك، ده اختبار الصوت';
    (async () => {
        const { file, engine } = await generateTtsAudio(testText);
        const ms = await probeDurationMs(file);
        console.log(`OK [${engine}]: ${file} (${ms}ms)`);
        process.exit(0);
    })().catch((e) => {
        console.error('FAIL:', e.message);
        process.exit(1);
    });
    } else {
        start().catch((err) => {
            logger.error(err);
            process.exit(1);
        });
    }
}

// للاختبارات: دوال نقية بدون تشغيل البوت
module.exports = { parseSayCommand, isTrigger, classify, helpMessage, guessLang, normalizeAr };
