/**
 * lib/reminders.js — تذكيرات برسالة و/أو مكالمة صوتية (عربي + إنجليزي)
 * الحفظ: database/reminders.json — الفاحص يعمل كل 10 ثواني ويعلّم المنفذ done
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { generateTtsAudio, probeDurationMs } = require('./tts');
const { placeCall } = require('./call');
const { normalizeAr, L } = require('./text');

const DB_PATH = path.resolve(process.cwd(), 'database', 'reminders.json');
const CHECK_MS = 10000;
const PRUNE_DAYS = 7;

// ---------- store ----------
function ensureDB() {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
    } catch {}
}
function loadReminders() {
    ensureDB();
    try {
        const arr = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function saveReminders(arr) {
    ensureDB();
    try { fs.writeFileSync(DB_PATH, JSON.stringify(arr, null, 2)); } catch {}
}

// ---------- helpers (منقول من ذكرني.js + إنجليزي) ----------
function normalizeDigits(s) {
    return String(s || '')
        .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
        .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString());
}
function formatDuration(ms, lang = 'ar') {
    const sec = Math.round(ms / 1000);
    if (lang === 'en') {
        if (sec < 60) return `${sec}s`;
        const min = Math.round(sec / 60);
        if (min < 60) return `${min}m`;
        const h = Math.floor(min / 60), m = min % 60;
        if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
        const d = Math.floor(h / 24), rh = h % 24;
        return rh ? `${d}d ${rh}h` : `${d}d`;
    }
    if (sec < 60) return `${sec} ثانية`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} دقيقة`;
    const h = Math.floor(min / 60), m = min % 60;
    if (h < 24) return m ? `${h} ساعة و ${m} دقيقة` : `${h} ساعة`;
    const d = Math.floor(h / 24), rh = h % 24;
    return rh ? `${d} يوم و ${rh} ساعة` : `${d} يوم`;
}
function formatTriggerDate(d, lang = 'ar') {
    try {
        return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG', {
            timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long',
            year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
        }).format(d);
    } catch { return d.toLocaleString(); }
}

// ---------- parse الوقت (عربي منقول + إنجليزي مضاف) ----------
function parseTrigger(rawInput, now = new Date()) {
    // توحيد الأرقام والحروف أولًا (أ=ا، ة=ه، ى=ي...) — الأنماط تحت مكتوبة بالصيغة الموحدة
    const input = normalizeAr(normalizeDigits(rawInput)).trim();
    if (!input) return null;

    // ===== إنجليزي =====
    // in 10 seconds/minutes/hours/days/weeks | in a minute/an hour/a day
    let m = input.match(/\bin\s+(?:(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|days?|weeks?)|a\s+(second|minute|hour|day|week)|an\s+(hour|minute))\b/i);
    if (m) {
        let ms = 0;
        if (m[1]) {
            const num = parseInt(m[1], 10), u = m[2].toLowerCase();
            if (u.startsWith('sec') || u === 's') ms = num * 1000;
            else if (u.startsWith('min') || u === 'm') ms = num * 60000;
            else if (u.startsWith('hour') || u === 'h') ms = num * 3600000;
            else if (u.startsWith('day') || u === 'd') ms = num * 86400000;
            else if (u.startsWith('week')) ms = num * 7 * 86400000;
        } else {
            const u = (m[3] || m[4]).toLowerCase();
            ms = u.startsWith('sec') ? 1000 : u.startsWith('min') ? 60000 : u.startsWith('hour') ? 3600000 : u.startsWith('day') ? 86400000 : 7 * 86400000;
        }
        if (ms > 0) {
            return { at: new Date(now.getTime() + ms), remaining: input.replace(m[0], '').trim(), match: m[0] };
        }
    }
    // tomorrow [at] 9[:30] [am/pm]
    m = input.match(/\btomorrow\b(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (m) {
        let hh = parseInt(m[1], 10); const mm = m[2] ? parseInt(m[2], 10) : 0;
        const ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && hh < 12) hh += 12;
        if (ap === 'am' && hh === 12) hh = 0;
        const at = new Date(now); at.setDate(at.getDate() + 1); at.setHours(hh, mm, 0, 0);
        return { at, remaining: input.replace(m[0], '').trim(), match: m[0] };
    }
    if (/\btomorrow\b/i.test(input)) {
        const at = new Date(now); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0);
        return { at, remaining: input.replace(/\btomorrow\b/i, '').trim(), match: 'tomorrow' };
    }
    // at 22:30 / at 9pm
    m = input.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (m) {
        let hh = parseInt(m[1], 10); const mm = m[2] ? parseInt(m[2], 10) : 0;
        const ap = (m[3] || '').toLowerCase();
        if (ap === 'pm' && hh < 12) hh += 12;
        if (ap === 'am' && hh === 12) hh = 0;
        if (hh <= 23 && mm <= 59) {
            const at = new Date(now); at.setSeconds(0, 0); at.setHours(hh, mm, 0, 0);
            if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
            return { at, remaining: input.replace(m[0], '').trim(), match: m[0] };
        }
    }

    // ===== عربي (منقول من ذكرني.js) =====
    // 1) تاريخ كامل 2026-09-11 15:00
    const absMatch = input.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (absMatch) {
        const y = parseInt(absMatch[1], 10), mo = parseInt(absMatch[2], 10), da = parseInt(absMatch[3], 10);
        const hh = absMatch[4] != null ? parseInt(absMatch[4], 10) : 0;
        const mm = absMatch[5] != null ? parseInt(absMatch[5], 10) : 0;
        const at = new Date(y, mo - 1, da, hh, mm, 0, 0);
        if (!isNaN(at.getTime()) && at.getTime() > now.getTime() - 60000) {
            const remaining = input.replace(absMatch[0], '').trim().replace(/^[،,:\-]+\s*/, '').trim();
            return { at, remaining, match: absMatch[0] };
        }
    }
    // 2) بعد بكرة / بكرة
    if (/بعد\s*بكرة/.test(input)) {
        const mb = input.match(/بعد\s*بكرة(?:\s+(\d{1,2})(?::(\d{2}))?\s*(الصبح|صباحا|صباحاً|الظهر|العصر|المغرب|بالليل|مساءا|مساءً|م|ص|am|pm)?)?/i);
        let hh = 9, mm = 0;
        if (mb && mb[1]) {
            hh = parseInt(mb[1], 10); mm = mb[2] ? parseInt(mb[2], 10) : 0;
            const suffix = (mb[3] || '').toLowerCase();
            if (suffix.includes('مساء') || suffix.includes('بالليل') || suffix.includes('م')) { if (hh < 12) hh += 12; }
            if (suffix.includes('am') && hh === 12) hh = 0;
            if (suffix.includes('pm') && hh < 12) hh += 12;
        }
        const at = new Date(now); at.setDate(at.getDate() + 2); at.setHours(hh, mm, 0, 0);
        const remaining = input.replace(mb ? mb[0] : 'بعد بكرة', '').trim();
        return { at, remaining, match: mb ? mb[0] : 'بعد بكرة' };
    }
    const bakraMatch = input.match(/بكرة\s+(\d{1,2})(?::(\d{2}))?\s*(الصبح|صباحا|صباحاً|الظهر|العصر|المغرب|بالليل|مساءا|مساءً|م|ص|am|pm)?/i);
    if (bakraMatch) {
        let hh = parseInt(bakraMatch[1], 10), mm = bakraMatch[2] ? parseInt(bakraMatch[2], 10) : 0;
        const suffix = (bakraMatch[3] || '').toLowerCase();
        if (suffix.includes('مساء') || suffix.includes('بالليل') || suffix.includes('م')) { if (hh < 12) hh += 12; }
        else if (suffix.includes('الظهر') && hh < 12) { hh += 12; }
        if (suffix.includes('pm') && hh < 12) hh += 12;
        if (suffix.includes('am') && hh === 12) hh = 0;
        const at = new Date(now); at.setDate(at.getDate() + 1); at.setHours(hh, mm, 0, 0);
        const remaining = input.replace(bakraMatch[0], '').trim();
        return { at, remaining, match: bakraMatch[0] };
    }
    if (input.includes('بكرة')) {
        const at = new Date(now); at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0);
        const remaining = input.replace(/بكرة/, '').trim();
        return { at, remaining, match: 'بكرة' };
    }
    // 3) بعد <رقم> <وحدة> / بعد ساعة / بعد ساعتين ...
    const noNumMap = [
        { re: /بعد\s+ساعتين/, ms: 2 * 3600000 }, { re: /بعد\s+ساعه/, ms: 3600000 },
        { re: /بعد\s+يومين/, ms: 2 * 86400000 },
        { re: /بعد\s+يوم/, ms: 86400000 }, { re: /بعد\s+دقيقه/, ms: 60000 },
        { re: /بعد\s+دقائق/, ms: 60000 },
        { re: /بعد\s+دقايق/, ms: 60000 }, { re: /بعد\s+ثانيه/, ms: 1000 },
        { re: /بعد\s+اسبوع/, ms: 7 * 86400000 },
    ];
    for (const { re, ms } of noNumMap) {
        const mm2 = input.match(re);
        if (mm2) {
            return { at: new Date(now.getTime() + ms), remaining: input.replace(mm2[0], '').trim(), match: mm2[0] };
        }
    }
    const arabicAfter = input.match(/بعد\s+(\d+)\s*(ثانيه|ثواني|دقيقه|دقائق|دقايق|ساعه|ساعات|يوم|ايام|اسبوع|شهر|شهور|سنه|عام)(?=\s|$|،|,)/i);
    if (arabicAfter) {
        const num = parseInt(arabicAfter[1], 10), unit = arabicAfter[2].toLowerCase();
        let ms = 0;
        if (/ثانيه|ثواني/.test(unit)) ms = num * 1000;
        else if (/دقيقه|دقائق|دقايق/.test(unit)) ms = num * 60000;
        else if (/ساعه|ساعات/.test(unit)) ms = num * 3600000;
        else if (/يوم|ايام/.test(unit)) ms = num * 86400000;
        else if (/اسبوع/.test(unit)) ms = num * 7 * 86400000;
        else if (/شهر|شهور/.test(unit)) ms = num * 30 * 86400000;
        else if (/سنه|عام/.test(unit)) ms = num * 365 * 86400000;
        return { at: new Date(now.getTime() + ms), remaining: input.replace(arabicAfter[0], '').trim(), match: arabicAfter[0] };
    }
    // 4) 10m / 30s لوحدها
    const shortBare = input.match(/(?:^|\s)(\d+)\s*(s|m|h|d)\b/i);
    if (shortBare) {
        const num = parseInt(shortBare[1], 10), u = shortBare[2].toLowerCase();
        let ms = 0;
        if (u === 's') ms = num * 1000;
        else if (u === 'm') ms = num * 60000;
        else if (u === 'h') ms = num * 3600000;
        else if (u === 'd') ms = num * 86400000;
        if (ms > 0 && ms <= 365 * 86400000) {
            return { at: new Date(now.getTime() + ms), remaining: input.replace(shortBare[0], '').trim(), match: shortBare[0].trim() };
        }
    }
    // 5) الساعه 22:30
    const clockMatch = input.match(/(?:الساعه\s*)?(\d{1,2}):(\d{2})(?:\s*(ص|صباحا|صباحاً|م|مساءا|مساءً|am|pm))?/i);
    if (clockMatch) {
        let hh = parseInt(clockMatch[1], 10), mm = parseInt(clockMatch[2], 10);
        const suffix = (clockMatch[3] || '').toLowerCase();
        if (suffix) {
            const isPM = suffix.includes('م') || suffix.includes('مساء') || suffix.includes('pm');
            const isAM = suffix.includes('ص') || suffix.includes('صباح') || suffix.includes('am');
            if (isPM && hh < 12) hh += 12;
            if (isAM && hh === 12) hh = 0;
        }
        if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
            const at = new Date(now); at.setSeconds(0, 0); at.setHours(hh, mm, 0, 0);
            if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
            return { at, remaining: input.replace(clockMatch[0], '').trim(), match: clockMatch[0] };
        }
    }
    return null;
}

// ---------- اكتشاف خيار المكالمة + نص النطق ----------
const CALL_MARK_RE = /بمكالمة|بمكالمه|مكالمة|مكالمه|واتصل بي|اتصل بي|with\s+(a\s+)?call|call\s+me/i;
function detectWithCall(raw) { return CALL_MARK_RE.test(raw); }
function extractSayText(raw) {
    const q = '"\u201C\u201D\u201E\u201F\u00AB\u00BB';
    let m = raw.match(new RegExp(`(?:وقول|saying|say)\\s*[:\\uFF1A]?\\s*[${q}](.+?)[${q}]`, 'is'));
    if (m) return m[1].trim();
    m = raw.match(/(?:وقول|saying|say)\s*[:\uFF1A]?\s*(.+?)(?=\s*(بمكالمة|بمكالمه|مكالمة|مكالمه|with\s+(a\s+)?call|call\s+me)\s*$|\s*$)/is);
    if (m && m[1].trim()) return m[1].trim().replace(new RegExp(`[${q}]`, 'g'), '').trim();
    return null;
}
function cleanReminderText(remaining) {
    return remaining
        .replace(new RegExp(`(?:وقول|saying|say)\\s*[:\\uFF1A]?\\s*["\\u201C\\u201D\\u201E\\u201F\\u00AB\\u00BB]?.*?["\\u201C\\u201D\\u201E\\u201F\\u00AB\\u00BB]?\\s*$`, 'is'), '')
        .replace(CALL_MARK_RE, '')
        .replace(/^[-–—:،,]+\s*/, '').replace(/\s+/g, ' ').trim();
}

// ---------- التنفيذ ----------
async function fireReminder(rem) {
    const sock = getSock();
    if (!sock) return;
    const lang = rem.lang || 'ar';
    try {
        const text = L(lang, `⏰ *تذكير*\n\n${rem.text}`, `⏰ *Reminder*\n\n${rem.text}`);
        await sock.sendMessage(rem.jid, { text }).catch(() => {});
    } catch {}
    if (rem.withCall) {
        try {
            const say = rem.sayText || rem.text;
            const { file } = await generateTtsAudio(say);
            const clipMs = await probeDurationMs(file);
            await placeCall(sock, rem.jid, {
                audioPath: file,
                audioDurationMs: (clipMs || 15000), // placeCall يضيف مهلة الرن + ذيل تلقائيًا
                repeatAudio: false,
                cleanupFile: true,
                preMsg: L(lang, '📞 مكالمة التذكير... رد 🔊', '📞 Reminder call... pick up 🔊'),
                endMsg: null,
                busyMsg: null,
            });
        } catch (e) {
            logger.error(`reminder call failed: ${e.message}`);
            await sock.sendMessage(rem.jid, { text: L(lang, '❌ مقدرتش أرن للتذكير', '❌ Could not place reminder call') }).catch(() => {});
        }
    }
}

// ---------- الفاحص كل 10 ثواني ----------
let sockRef = null;
let checkerStarted = false;
function setSock(s) { sockRef = s; }
function getSock() { return sockRef; }
function pruneDone(list) {
    const cutoff = Date.now() - PRUNE_DAYS * 86400000;
    return list.filter((r) => r.status !== 'done' || new Date(r.doneAt || 0).getTime() > cutoff);
}
async function tick() {
    try {
        let list = loadReminders();
        const pruned = pruneDone(list);
        if (pruned.length !== list.length) { saveReminders(pruned); list = pruned; }
        if (!sockRef) return;
        const now = Date.now();
        for (const r of list) {
            if (r.status === 'done') continue;
            if (new Date(r.triggerAt).getTime() <= now) {
                r.status = 'done'; // علّم منفذ الأول عشان ميتكررش
                r.doneAt = new Date().toISOString();
                saveReminders(list);
                logger.info(`firing reminder ${r.id} for ${r.jid}`);
                fireReminder(r).catch((e) => logger.error(e.message));
            }
        }
    } catch (e) { logger.error(`reminder tick: ${e.message}`); }
}
function startReminderChecker() {
    if (checkerStarted) return;
    checkerStarted = true;
    setInterval(() => { tick().catch(() => {}); }, CHECK_MS);
    logger.info(`reminder checker started (every ${CHECK_MS / 1000}s)`);
}

// ---------- أوامر ----------
function helpText(lang) {
    return L(lang,
        `⏰ *ذكرني — كيف تستخدمه؟*\n\n` +
        `ذكرني بعد 10 دقائق الاجتماع\n` +
        `ذكرني بعد ساعة بمكالمة وقول "يلا الاجتماع بدأ"\n` +
        `ذكرني بكرة 9 الصبح موعد الدكتور\n` +
        `ذكرني 22:30 نام بدري\n` +
        `ذكرني 2026-12-25 15:00 عيد ميلاد\n\n` +
        `• لو كتبت *بمكالمة* هرن عليك وقت التذكير وأقول اللي بعد *وقول*\n` +
        `• لو مفيش *وقول* هنطق نص التذكير نفسه\n` +
        `ذكرني قائمة — عرض | ذكرني الغاء [رقم] — إلغاء`,
        `⏰ *Remind me — usage:*\n\n` +
        `remind me in 10 minutes meeting\n` +
        `remind me in 1 hour with a call saying "meeting started"\n` +
        `remind me tomorrow at 9 doctor\n` +
        `remind me at 22:30 sleep early\n` +
        `remind me 2026-12-25 15:00 birthday\n\n` +
        `• Add *with a call* and I'll call you at reminder time saying the *saying* text\n` +
        `• Without *saying*, I'll speak the reminder text itself\n` +
        `remind list — show | remind cancel [number] — cancel`);
}

async function handleRemind(sock, jid, sender, raw, lang, quoted) {
    setSock(sock);
    const normRaw = normalizeAr(normalizeDigits(raw)).trim();

    const isList = /^(قايمه|القايمه|قائمه|القائمه|list|عرض)(\s|$)/i.test(normRaw);
    const isCancel = /^(الغاء|إلغاء|الغا|الغى|cancel|حذف|امسح)(\s|$)/i.test(normRaw);

    if (!normRaw) {
        await sock.sendMessage(jid, { text: helpText(lang) }, { quoted }).catch(() => {});
        return;
    }
    if (isList) {
        const mine = loadReminders().filter((r) => r.jid === jid && r.status !== 'done');
        if (!mine.length) {
            await sock.sendMessage(jid, { text: L(lang, '📭 لا يوجد تذكيرات نشطة.', '📭 No active reminders.') }, { quoted }).catch(() => {});
            return;
        }
        let txt = L(lang, `📋 *تذكيراتك النشطة (${mine.length}):*\n\n`, `📋 *Your active reminders (${mine.length}):*\n\n`);
        mine.forEach((r, i) => {
            const at = formatTriggerDate(new Date(r.triggerAt), lang);
            const remain = formatDuration(new Date(r.triggerAt).getTime() - Date.now(), lang);
            txt += L(lang,
                `${i + 1}. ⏰ ${at} (بعد ${remain})${r.withCall ? ' 📞+💬' : ''}\n   📝 ${r.text}\n\n`,
                `${i + 1}. ⏰ ${at} (in ${remain})${r.withCall ? ' 📞+💬' : ''}\n   📝 ${r.text}\n\n`);
        });
        await sock.sendMessage(jid, { text: txt.trim() }, { quoted }).catch(() => {});
        return;
    }
    if (isCancel) {
        const parts = normRaw.split(/\s+/);
        const list = loadReminders();
        const mine = list.filter((r) => r.jid === jid && r.status !== 'done');
        const num = parseInt(parts[1], 10);
        if (parts.length >= 2 && !isNaN(num) && mine[num - 1]) {
            const target = mine[num - 1];
            target.status = 'done'; target.doneAt = new Date().toISOString(); target.cancelled = true;
            saveReminders(list);
            await sock.sendMessage(jid, { text: L(lang, `✅ تم إلغاء التذكير رقم ${num}`, `✅ Reminder #${num} cancelled`) }, { quoted }).catch(() => {});
            return;
        }
        if (!mine.length) {
            await sock.sendMessage(jid, { text: L(lang, '📭 لا يوجد تذكيرات لإلغائها.', '📭 Nothing to cancel.') }, { quoted }).catch(() => {});
            return;
        }
        for (const r of mine) { r.status = 'done'; r.doneAt = new Date().toISOString(); r.cancelled = true; }
        saveReminders(list);
        await sock.sendMessage(jid, { text: L(lang, `✅ تم إلغاء ${mine.length} تذكير.`, `✅ Cancelled ${mine.length} reminder(s).`) }, { quoted }).catch(() => {});
        return;
    }

    // إنشاء جديد
    const parsed = parseTrigger(normRaw, new Date());
    if (!parsed) {
        await sock.sendMessage(jid, { text: L(lang, `❌ ما فهمتش الوقت.\n\n`, `❌ Could not understand the time.\n\n`) + helpText(lang) }, { quoted }).catch(() => {});
        return;
    }
    const withCall = detectWithCall(normRaw);
    const sayText = withCall ? extractSayText(normRaw) : null;
    let reminderText = cleanReminderText(parsed.remaining);
    if (!reminderText) reminderText = withCall && sayText ? sayText : L(lang, 'تذكير ⏰', 'Reminder ⏰');
    if (reminderText.length > 500) reminderText = reminderText.slice(0, 500);

    if (parsed.at.getTime() <= Date.now() + 3000) {
        await sock.sendMessage(jid, { text: L(lang, '❌ الوقت لازم يكون في المستقبل.', '❌ Time must be in the future.') }, { quoted }).catch(() => {});
        return;
    }
    if (parsed.at.getTime() - Date.now() > 365 * 86400000) {
        await sock.sendMessage(jid, { text: L(lang, '❌ أقصى مدة سنة واحدة.', '❌ Max reminder is 1 year.') }, { quoted }).catch(() => {});
        return;
    }

    const rec = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        jid, sender, text: reminderText,
        sayText: sayText || null, withCall,
        triggerAt: parsed.at.toISOString(), createdAt: new Date().toISOString(),
        status: 'pending', lang,
    };
    const arr = loadReminders();
    arr.push(rec);
    saveReminders(arr);

    const dur = formatDuration(parsed.at.getTime() - Date.now(), lang);
    const atStr = formatTriggerDate(parsed.at, lang);
    const mode = withCall
        ? L(lang, `\n📞+💬 هرن عليك وأقول: "${sayText || reminderText}"`, `\n📞+💬 I'll call you saying: "${sayText || reminderText}"`)
        : '';
    await sock.sendMessage(jid, {
        text: L(lang, `✅ تمام، هفكرك بعد *${dur}* ⏰\n📅 ${atStr}\n📝 ${reminderText}${mode}`,
            `✅ OK, I'll remind you in *${dur}* ⏰\n📅 ${atStr}\n📝 ${reminderText}${mode}`),
    }, { quoted }).catch(() => {});
}

module.exports = { handleRemind, startReminderChecker, setSock, parseTrigger, loadReminders };
