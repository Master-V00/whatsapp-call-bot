/**
 * lib/tts.js — توليد الصوت من النص
 * المحرك الافتراضي: ElevenLabs API — وعند أي خطأ (مفتاح ناقص/حدود خلصت/ايرور)
 * يقع تلقائيًا على مكتبة بايثون gTTS. (تم إلغاء edge-tts نهائيًا)
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { logger } = require('./logger');


const PYTHON_CMD = process.env.PYTHON_CMD || 'python';
const TTS_LANG = process.env.TTS_LANG || 'ar';
const TTS_MAX_CHARS = parseInt(process.env.TTS_MAX_CHARS || '500', 10);
// eleven (افتراضي) | gtts (تخطي ElevenLabs تمامًا)
const TTS_ENGINE = (process.env.TTS_ENGINE || 'eleven').toLowerCase();
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel — صوت جاهز يدعم العربي مع multilingual
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

const TTS_DIR = path.resolve(__dirname, '..', process.env.TTS_DIR || './tts');
if (!fs.existsSync(TTS_DIR)) fs.mkdirSync(TTS_DIR, { recursive: true });
// امسح ملفات tts المؤقتة القديمة عند التشغيل
for (const f of fs.readdirSync(TTS_DIR)) {
    if (f.endsWith('.mp3')) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
}

// ---------- ElevenLabs ----------
function generateElevenAudio(text, outFile) {
    return new Promise(async (resolve, reject) => {
        if (!ELEVEN_KEY) return reject(new Error('no ELEVENLABS_API_KEY'));
        try {
            const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE}`, {
                method: 'POST',
                headers: {
                    'xi-api-key': ELEVEN_KEY,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                body: JSON.stringify({
                    text,
                    model_id: ELEVEN_MODEL,
                    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return reject(new Error(`ElevenLabs ${res.status}: ${body.slice(0, 200)}`));
            }
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 1024) return reject(new Error('ElevenLabs: empty audio'));
            fs.writeFileSync(outFile, buf);
            trackUsage(text.length);
            resolve(outFile);
        } catch (e) {
            reject(new Error(`ElevenLabs failed: ${e.message}`));
        }
    });
}

// ---------- gTTS (بايثون) ----------
function generateGttsAudio(text, outFile) {
    return new Promise((resolve, reject) => {
        const pyCode = "from gtts import gTTS; import sys; gTTS(sys.argv[1], lang=sys.argv[2]).save(sys.argv[3])";
        execFile(PYTHON_CMD, ['-c', pyCode, text, TTS_LANG, outFile], { timeout: 60000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(`gTTS failed: ${String(stderr || err.message).slice(0, 200)}`));
            if (!fs.existsSync(outFile)) return reject(new Error('gTTS failed: no output file'));
            resolve(outFile);
        });
    });
}

// ---------- الدالة الرئيسية: eleven أولًا ثم gTTS ----------
async function generateTtsAudio(text) {
    if (!text || !text.trim()) throw new Error('empty text');
    if (text.length > TTS_MAX_CHARS) throw new Error(`text too long (${text.length}/${TTS_MAX_CHARS})`);
    const outFile = path.join(TTS_DIR, `tts-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp3`);

    if (TTS_ENGINE === 'eleven') {
        try {
            await generateElevenAudio(text, outFile);
            logger.info('TTS engine used: elevenlabs');
            return { file: outFile, engine: 'elevenlabs' };
        } catch (e) {
            logger.warn(`${e.message} — falling back to gTTS`);
        }
    }
    await generateGttsAudio(text, outFile);
    logger.info('TTS engine used: gtts');
    return { file: outFile, engine: 'gtts' };
}

// ---------- مدة ملف صوتي (ffprobe) ----------
function probeDurationMs(file) {
    return new Promise((resolve) => {
        execFile('ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
            { timeout: 15000 },
            (err, stdout) => {
                if (err) return resolve(null);
                const s = parseFloat(String(stdout).trim());
                resolve(Number.isFinite(s) ? Math.round(s * 1000) : null);
            });
    });
}

// ---------- تتبع استهلاك ElevenLabs الشهري (10k حرف مجاني) ----------
const USAGE_PATH = path.resolve(__dirname, '..', 'database', 'tts_usage.json');
function monthKey(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function trackUsage(chars) {
    try {
        const dir = path.dirname(USAGE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        let data = {};
        try { data = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8')); } catch {}
        const mk = monthKey();
        if (data.month !== mk) data = { month: mk, elevenChars: 0 };
        data.elevenChars = (data.elevenChars || 0) + chars;
        fs.writeFileSync(USAGE_PATH, JSON.stringify(data, null, 2));
    } catch {}
}
function getUsage() {
    try {
        const data = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf-8'));
        if (data.month !== monthKey()) return { month: monthKey(), elevenChars: 0 };
        return data;
    } catch { return { month: monthKey(), elevenChars: 0 }; }
}

module.exports = { generateTtsAudio, generateElevenAudio, generateGttsAudio, probeDurationMs, getUsage, TTS_MAX_CHARS, TTS_ENGINE };
