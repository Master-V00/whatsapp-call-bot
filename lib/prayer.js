/**
 * lib/prayer.js — تذكير مواقيت الصلاة (القاهرة) بمكالمة فيها الأذان كامل + رسالة
 * الحفظ: database/prayer_reminders.json — الفاحص كل 10 ثواني
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');
const { placeCall } = require('./call');
const { normalizeAr, L } = require('./text');

const DB_PATH = path.resolve(process.cwd(), 'database', 'prayer_reminders.json');
const CHECK_MS = 10000;
const TZ = 'Africa/Cairo';
const PRAYER_API = 'https://api.aladhan.com/v1/timingsByCity?city=Cairo&country=EG&method=5';
const PRAYER_NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const PRAYER_AR = { Fajr: 'الفجر', Dhuhr: 'الظهر', Asr: 'العصر', Maghrib: 'المغرب', Isha: 'العشاء' };
const PRAYER_EN = { Fajr: 'Fajr', Dhuhr: 'Dhuhr', Asr: 'Asr', Maghrib: 'Maghrib', Isha: 'Isha' };
const ADHAN_FILE = path.resolve(process.cwd(), process.env.ADHAN_FILE || './adhan.mp3');
const LATE_SKIP_MS = 15 * 60000; // لو فاتت الصلاة بأكتر من 15 دقيقة منرنش (نعلّمها بس)

// ---------- store ----------
function ensureDB() {
    try {
        const dir = path.dirname(DB_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify([], null, 2));
    } catch {}
}
function loadPrayer() {
    ensureDB();
    try {
        const arr = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function savePrayer(arr) {
    ensureDB();
    try { fs.writeFileSync(DB_PATH, JSON.stringify(arr, null, 2)); } catch {}
}

// ---------- توقيت القاهرة (منقول من ذكرني.js) ----------
function getCairoDateStr(date = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    } catch {
        const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
}
function getCairoPartsFromUTC(utcDate) {
    try {
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
        const parts = fmt.formatToParts(utcDate);
        const map = {};
        for (const p of parts) map[p.type] = p.value;
        return { year: parseInt(map.year, 10), month: parseInt(map.month, 10), day: parseInt(map.day, 10), hour: parseInt(map.hour, 10), minute: parseInt(map.minute, 10) };
    } catch { return { year: utcDate.getUTCFullYear(), month: utcDate.getUTCMonth() + 1, day: utcDate.getUTCDate(), hour: utcDate.getUTCHours(), minute: utcDate.getUTCMinutes() }; }
}
function cairoWallToUTC(y, m, d, h, mi) {
    let utcMs = Date.UTC(y, m - 1, d, h, mi, 0, 0);
    for (let i = 0; i < 4; i++) {
        const parts = getCairoPartsFromUTC(new Date(utcMs));
        const desiredDays = Date.UTC(y, m - 1, d) / 86400000;
        const guessedDays = Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000;
        const minDiff = (guessedDays - desiredDays) * 1440 + (parts.hour - h) * 60 + (parts.minute - mi);
        if (Math.abs(minDiff) < 0.5) break;
        utcMs -= minDiff * 60000;
    }
    return new Date(utcMs);
}
function parseCairoDateTime(cairoDateStr, timeStr) {
    const clean = String(timeStr).split(' ')[0].trim();
    const [y, mo, d] = cairoDateStr.split('-').map(Number);
    const [h, mi] = clean.split(':').map(Number);
    return cairoWallToUTC(y, mo, d, h, mi);
}
function formatPrayerTime(d, lang) {
    try {
        return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'ar-EG', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
    } catch { return d.toLocaleString(); }
}

// ---------- API المواقيت ----------
async function fetchCairoTimings() {
    try {
        const res = await fetch(PRAYER_API, { signal: AbortSignal.timeout(15000) });
        const json = await res.json();
        const t = json?.data?.timings;
        if (!t) return null;
        const out = {};
        for (const n of PRAYER_NAMES) if (t[n]) out[n] = String(t[n]).split(' ')[0];
        return out.Fajr ? out : null;
    } catch (e) {
        logger.error(`prayer API failed: ${e.message}`);
        return null;
    }
}

// ---------- مدة الأذان (مرة واحدة) ----------
const { probeDurationMs } = require('./tts');
let adhanMsCache = null;
async function getAdhanDurationMs() {
    if (adhanMsCache) return adhanMsCache;
    const ms = await probeDurationMs(ADHAN_FILE);
    adhanMsCache = ms || 200000; // fallback ~3:20 لو الفحص فشل
    logger.info(`adhan duration: ${adhanMsCache}ms`);
    return adhanMsCache;
}

// ---------- التنفيذ: رسالة + مكالمة فيها الأذان كامل ----------
let sockRef = null;
function setSock(s) { sockRef = s; }

async function firePrayer(entry, prayerEn, target) {
    const lang = entry.lang || 'ar';
    const name = L(lang, PRAYER_AR[prayerEn], PRAYER_EN[prayerEn]);
    try {
        await sockRef.sendMessage(entry.jid, {
            text: L(lang,
                `🕌 حان الآن موعد صلاة *${name}* في القاهرة\n⏰ ${formatPrayerTime(target, lang)}\n📞 هرن عليك بالأذان كامل...`,
                `🕌 It's time for *${name}* prayer in Cairo\n⏰ ${formatPrayerTime(target, lang)}\n📞 Calling you with the full adhan...`),
            mentions: entry.sender ? [entry.sender] : [],
        }).catch(() => {});
    } catch {}
    try {
        if (!fs.existsSync(ADHAN_FILE)) {
            await sockRef.sendMessage(entry.jid, { text: L(lang, '❌ ملف الأذان مش موجود (adhan.mp3)', '❌ Adhan file missing (adhan.mp3)') }).catch(() => {});
            return;
        }
        const adhanMs = await getAdhanDurationMs();
        await placeCall(sockRef, entry.jid, {
            audioPath: ADHAN_FILE,
            audioDurationMs: adhanMs, // placeCall يضيف مهلة الرن (~60s) + ذيل تلقائيًا
            repeatAudio: false,
            preMsg: null, // الرسالة اتبعتت فوق
            endMsg: L(lang, '✅ تقبل الله. فعل التذكير شغال لباقي الصلوات 🕌', '✅ Prayer done. Reminder active for other prayers 🕌'),
        });
    } catch (e) {
        logger.error(`prayer call failed: ${e.message}`);
    }
}

// ---------- الفاحص كل 10 ثواني ----------
let checkerStarted = false;
async function tick() {
    try {
        const list = loadPrayer();
        if (!list.length || !sockRef) return;
        const now = new Date();
        const todayStr = getCairoDateStr(now);
        for (const e of list) {
            if (!e.enabled) continue;
            // حدّث المواقيت لو يوم جديد
            if (e.date !== todayStr || !e.timings) {
                const t = await fetchCairoTimings();
                if (t) {
                    e.timings = t; e.date = todayStr; e.fired = {};
                    savePrayer(list);
                    logger.info(`prayer timings refreshed for ${todayStr}`);
                } else continue;
            }
            e.fired = e.fired || {};
            for (const n of PRAYER_NAMES) {
                const timeStr = e.timings?.[n];
                if (!timeStr) continue;
                if (e.fired[n] === todayStr) continue; // اتعملت النهاردة خلاص
                const target = parseCairoDateTime(todayStr, timeStr);
                const diff = now.getTime() - target.getTime();
                if (diff >= 0) {
                    e.fired[n] = todayStr; // علّم منفذ الأول عشان ميتكررش
                    savePrayer(list);
                    if (diff <= LATE_SKIP_MS) {
                        logger.info(`firing prayer ${n} for ${e.jid}`);
                        firePrayer(e, n, target).catch((er) => logger.error(er.message));
                    } else {
                        logger.info(`skipped late prayer ${n} for ${e.jid} (late ${Math.round(diff / 60000)}m)`);
                    }
                }
            }
        }
    } catch (e) { logger.error(`prayer tick: ${e.message}`); }
}
function startPrayerChecker() {
    if (checkerStarted) return;
    checkerStarted = true;
    getAdhanDurationMs().catch(() => {});
    setInterval(() => { tick().catch(() => {}); }, CHECK_MS);
    logger.info(`prayer checker started (every ${CHECK_MS / 1000}s)`);
}

// ---------- أوامر ----------
async function handlePrayer(sock, jid, sender, raw, lang, quoted) {
    setSock(sock);
    const sub = normalizeAr(raw.trim().toLowerCase());
    const isEnable = /تفعيل|تفع|تشغيل|on|enable/.test(sub);
    const isDisable = /الغاء|إلغاء|الغا|off|disable|cancel/.test(sub);
    const isStatus = /حاله|حالة|عرض|status|list/.test(sub);

    if (isEnable && !isDisable) {
        await sock.sendMessage(jid, { text: L(lang, '⏳ جاري جلب مواقيت الصلاة للقاهرة...', '⏳ Fetching Cairo prayer times...') }, { quoted }).catch(() => {});
        const timings = await fetchCairoTimings();
        if (!timings) {
            await sock.sendMessage(jid, { text: L(lang, '❌ تعذر جلب المواقيت الآن، حاول بعد دقيقة.', '❌ Could not fetch times, try in a minute.') }, { quoted }).catch(() => {});
            return;
        }
        const todayStr = getCairoDateStr(new Date());
        const arr = loadPrayer();
        let entry = arr.find((e) => e.jid === jid);
        if (entry) Object.assign(entry, { sender, enabled: true, lang, city: 'Cairo', timings, date: todayStr, fired: {} });
        else { entry = { jid, sender, enabled: true, lang, city: 'Cairo', timings, date: todayStr, fired: {} }; arr.push(entry); }
        savePrayer(arr);
        let txt = L(lang, '✅ تم تفعيل تذكير الصلاة للقاهرة 📞+🕌\n\nهرن عليك وقت كل صلاة وأشغل الأذان كامل في المكالمة:\n\n',
            '✅ Cairo prayer reminder ON 📞+🕌\n\nI will call you at each prayer with the full adhan:\n\n');
        for (const n of PRAYER_NAMES) txt += `• ${L(lang, PRAYER_AR[n], PRAYER_EN[n])}: ${timings[n]}\n`;
        await sock.sendMessage(jid, { text: txt }, { quoted }).catch(() => {});
        return;
    }
    if (isDisable) {
        const arr = loadPrayer();
        const idx = arr.findIndex((e) => e.jid === jid);
        if (idx === -1 || !arr[idx].enabled) {
            await sock.sendMessage(jid, { text: L(lang, '📭 تذكير الصلاة غير مفعل.', '📭 Prayer reminder is not active.') }, { quoted }).catch(() => {});
            return;
        }
        arr.splice(idx, 1);
        savePrayer(arr);
        await sock.sendMessage(jid, { text: L(lang, '❌ تم إلغاء تذكير الصلاة.', '❌ Prayer reminder cancelled.') }, { quoted }).catch(() => {});
        return;
    }
    // status أو قائمة
    const entry = loadPrayer().find((e) => e.jid === jid);
    if (!entry || !entry.enabled) {
        await sock.sendMessage(jid, {
            text: L(lang,
                `🕌 *تذكير الصلاة — القاهرة*\n\nللتفعيل: صلاة تفعيل\nللإلغاء: صلاة الغاء\nللعرض: صلاة حالة`,
                `🕌 *Prayer reminder — Cairo*\n\nEnable: prayer on\nDisable: prayer off\nStatus: prayer status`),
        }, { quoted }).catch(() => {});
        return;
    }
    let txt = L(lang, '📋 *تذكير الصلاة — القاهرة* ✅\n\n', '📋 *Prayer reminder — Cairo* ✅\n\n');
    for (const n of PRAYER_NAMES) txt += `• ${L(lang, PRAYER_AR[n], PRAYER_EN[n])}: ${entry.timings?.[n] || '-'}${entry.fired?.[n] === entry.date ? ' ✔' : ''}\n`;
    await sock.sendMessage(jid, { text: txt }, { quoted }).catch(() => {});
}

module.exports = { handlePrayer, startPrayerChecker, setSock, loadPrayer, fetchCairoTimings };
