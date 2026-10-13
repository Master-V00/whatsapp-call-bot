/** lib/call.js — إجراء مكالمة صوتية وتشغيل ملف صوتي فيها */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');


const AUDIO_FILE = process.env.AUDIO_FILE || './audio.mp3';
const CALL_DURATION_MS = parseInt(process.env.CALL_DURATION_MS || '30000', 10);
// ميزانية وقت الرن: تايمر durationMs في المكتبة يبدأ من لحظة الاتصال (شامل الرن)،
// لذلك نضيف 60 ثانية افتراضيًا تسمح للمستقبل بالرد المتأخر قبل بدء احتساب مدة الصوت
const RING_BUDGET_MS = parseInt(process.env.RING_BUDGET_MS || '60000', 10);
const PRE_RINGING_MS = parseInt(process.env.PRE_RINGING_MS || '30000', 10);
const REPEAT_AUDIO = (process.env.REPEAT_AUDIO || 'true') === 'true';

// منع مكالمتين لنفس الرقم في نفس الوقت
const busyJids = new Set();
function isBusy(jid) { return busyJids.has(jid); }

async function placeCall(sock, jid, opts = {}) {
    if (busyJids.has(jid)) {
        await sock.sendMessage(jid, { text: opts.busyMsg || '⏳ في مكالمة شغالة ليك بالفعل، استنى تخلص. / A call is already in progress, please wait.' });
        return null;
    }

    const audioPath = opts.audioPath || path.resolve(process.cwd(), AUDIO_FILE);
    if (!fs.existsSync(audioPath)) {
        await sock.sendMessage(jid, { text: `❌ ملف الصوت مش موجود: ${audioPath}` });
        logger.error(`audio file missing: ${audioPath}`);
        return null;
    }

    // مدة المحتوى الصوتي المتوقعة (للملفات لمرة واحدة) — للوضع المكرر تُستخدم CALL_DURATION_MS
    const talkMs = opts.audioDurationMs || CALL_DURATION_MS;
    // الإجمالي = مهلة الرن + مدة الصوت + 5 ثواني ذيل (يغطي الرد المتأخر حتى ~60 ثانية)
    const totalMs = RING_BUDGET_MS + talkMs + 5000;

    busyJids.add(jid);
    try {
        if (opts.preMsg) await sock.sendMessage(jid, { text: opts.preMsg });

        logger.info(`placing call to ${jid} audio=${audioPath} talk=${talkMs}ms total=${totalMs}ms`);
        const call = await sock.initiateCall(jid, {
            audioSource: audioPath,
            durationMs: opts.durationMs || totalMs,
            repeatAudio: opts.repeatAudio !== undefined ? opts.repeatAudio : REPEAT_AUDIO,
            preRingingTimeoutMs: PRE_RINGING_MS,
        });

        const done = async (afterMsg) => {
            busyJids.delete(jid);
            if (opts.cleanupFile) { try { fs.unlinkSync(audioPath); } catch {} }
            if (afterMsg) await sock.sendMessage(jid, { text: afterMsg }).catch(() => {});
        };

        call.on('ringing', () => logger.info(`[${call.callId}] ringing...`));
        call.on('accepted', () => logger.info(`[${call.callId}] accepted!`));
        call.on('connected', () => logger.info(`[${call.callId}] connected!`));
        call.on('audioReady', () => logger.info(`[${call.callId}] audio pipeline ready!`));
        call.on('streaming', () => logger.info(`[${call.callId}] streaming audio...`));
        call.on('ended', async (reason) => {
            logger.info(`[${call.callId}] ended: ${reason}`);
            await done(opts.endMsg || null);
        });
        call.on('error', async (err) => {
            logger.error(`[${call.callId}] error: ${err?.message || err}`);
            await done(opts.errorMsg || `❌ المكالمة فشلت: ${err?.message || err} / Call failed.`);
        });
        return call;
    } catch (err) {
        busyJids.delete(jid);
        if (opts.cleanupFile) { try { fs.unlinkSync(audioPath); } catch {} }
        logger.error(`initiateCall failed: ${err?.message || err}`);
        await sock.sendMessage(jid, { text: `❌ مقدرتش أرن عليك: ${err?.message || err}` }).catch(() => {});
        return null;
    }
}

module.exports = { placeCall, isBusy };
