/**
 * ensure-deps.js — يعمل تلقائيًا قبل npm start (prestart).
 * يتأكد أن كل الاعتماديات موجودة، ويثبت الناقص منها:
 *  1. ffmpeg + ffprobe (محاولة winget، وإلا رسالة تثبيت يدوي)
 *  2. python + مكتبة gtts (pip install تلقائي)
 *  3. node_modules لمكتبة الواتساب (npm install تلقائي)
 *  4. إنشاء فولدرات database / tts / logs
 * بدون أي مكتبات خارجية — Node خام فقط.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
let failed = false;

function check(cmd, args) {
    try {
        execFileSync(cmd, args, { stdio: 'ignore', timeout: 20000 });
        return true;
    } catch { return false; }
}
function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, timeout: 600000, ...opts });
    return r.status === 0;
}
function step(name) { console.log(`\n[deps] ${name}...`); }
function ok(msg) { console.log(`[deps] OK: ${msg}`); }
function warn(msg) { console.log(`[deps] WARN: ${msg}`); }

// ---------- 1. ffmpeg + ffprobe ----------
step('checking ffmpeg/ffprobe');
const hasFfmpeg = check('ffmpeg', ['-version']);
const hasFfprobe = check('ffprobe', ['-version']);
if (hasFfmpeg && hasFfprobe) {
    ok('ffmpeg + ffprobe found');
} else {
    warn('ffmpeg/ffprobe missing — trying winget install (Gyan.FFmpeg)...');
    const installed = run('winget', ['install', '-e', '--id', 'Gyan.FFmpeg', '--accept-source-agreements', '--accept-package-agreements']);
    if (installed && check('ffmpeg', ['-version'])) {
        ok('ffmpeg installed via winget (restart terminal if not in PATH yet)');
    } else {
        console.log('[deps] ERROR: ffmpeg is required for voice calls.');
        console.log('[deps] Install manually: winget install Gyan.FFmpeg');
        console.log('[deps] Or download from https://www.gyan.dev/ffmpeg/builds/ and add bin/ to PATH.');
        failed = true;
    }
}

// ---------- 2. python + gtts ----------
step('checking python + gtts');
const PY = process.env.PYTHON_CMD || 'python';
if (!check(PY, ['--version'])) {
    console.log(`[deps] ERROR: python not found (tried "${PY}"). Install Python 3 from https://www.python.org/downloads/`);
    failed = true;
} else if (check(PY, ['-c', 'import gtts'])) {
    ok('python + gtts found');
} else {
    warn('gtts missing — installing with pip...');
    if (run(PY, ['-m', 'pip', 'install', 'gtts']) && check(PY, ['-c', 'import gtts'])) {
        ok('gtts installed');
    } else {
        console.log('[deps] ERROR: could not install gtts. Run manually: pip install gtts');
        failed = true;
    }
}

// ---------- 3. node baileys lib ----------
step('checking node_modules (@innovatorssoft/baileys)');
if (fs.existsSync(path.join(ROOT, 'node_modules', '@innovatorssoft', 'baileys', 'package.json'))) {
    ok('baileys lib found');
} else {
    warn('baileys lib missing — running npm install (takes a few minutes)...');
    if (run('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT })) {
        ok('npm install done');
    } else {
        console.log('[deps] ERROR: npm install failed. Run it manually.');
        failed = true;
    }
}

// ---------- 4. folders ----------
for (const d of ['database', 'tts', 'logs']) {
    const p = path.join(ROOT, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
for (const f of ['database/reminders.json', 'database/prayer_reminders.json']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '[]');
}
ok('folders ready');

if (failed) {
    console.log('\n[deps] Some dependencies are missing — fix the errors above then run again.');
    process.exit(1);
}
console.log('\n[deps] All dependencies ready.\n');
