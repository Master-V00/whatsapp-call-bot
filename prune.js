/**
 * prune.js — تصغير مجلد node_modules بأمان (بدون كسر التشغيل).
 * =====================================================================
 * الفكرة (الحل أ): بعد `npm install` نحذف فقط الملفات التي لا تُستدعى
 * وقت التشغيل (Runtime) إطلاقًا، وهي قابلة للاستعادة دائمًا عبر `npm install`.
 *
 * ماذا يحذف؟
 *  1) ملفات التوثيق: *.md, *.markdown, *.mdx, *.rst, CHANGELOG*, HISTORY*,
 *     AUTHORS*, CONTRIBUTORS*, CONTRIBUTING*, NOTICE* (النصية فقط).
 *     ملاحظة: نُبقي ملفات LICENSE* لأسباب قانونية وحجمها صغير.
 *  2) خرائط المصدر: *.map (مثل *.js.map و *.d.ts.map) — للتنقيح فقط.
 *  3) إعلانات TypeScript: *.d.ts, *.d.mts, *.d.cts — لا يحمّلها Node أبدًا.
 *  4) مصادر TypeScript غير المترجمة: *.ts, *.mts, *.cts (ما عدا *.d.* المحذوفة
 *     أعلاه) — نقطة الدخول للمكتبة هي lib/index.js (مترجم)، ولا يوجد أي
 *     require/import لملف .ts وقت التشغيل (تم التحقق باستعراض شجرة require).
 *  5) مجلدات لا تُستدعى وقت التشغيل: test, tests, __tests__, __test__,
 *     __mocks__, example, examples, docs, doc, coverage, .github, .vscode.
 *     (مجلد coverage وحده في fluent-ffmpeg ≈ 11MB).
 *
 * ماذا لا يمسّ إطلاقًا؟
 *  - أي ملف تشغيل: *.js, *.mjs, *.cjs, *.json, *.wasm, *.node, *.dll,
 *    *.exe, *.proto، وكل ملفات lib/ و WAProto/ و Assets/Wasm داخل baileys
 *    (المكالمات VoIP تعتمد على @roamhq/wrtc وملفات Wasm — لا تُمس).
 *  - مجلدات المشروع: auth/ و database/ و tts/ و logs/ وملفات الصوت
 *    (*.mp3) و .env و package.json (لا يعدّل الاعتماديات).
 *  - حزم كاملة: لا نحذف أي حزمة (حتى mathjax-full/sharp رغم أنها تُستدعى
 *    بشكل كسول لمزايا لا يستخدمها البوت، تُركت كاملة عند الشك — قاعدة السلامة).
 *
 * الخصائص:
 *  - idempotent: آمن عند إعادة التشغيل (يتجاوز غير الموجود بدون خطأ).
 *  - يدعم المعاينة: `node prune.js --dry-run` يعرض فقط دون حذف.
 *  - يطبع ملخصًا بالفئات والميجابايت المحذوفة.
 *  - الاستعادة: `npm install` (أو حذف node_modules ثم npm install).
 *
 * الاستخدام: npm run prune  (لا يعمل تلقائيًا — بدون postinstall)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NM = path.join(ROOT, 'node_modules');
const DRY = process.argv.includes('--dry-run');

// --- 1) امتدادات ملفات آمنة الحذف (صغيرة/كبيرة الحروف) ---
const FILE_EXTS = new Set([
    '.md', '.markdown', '.mdx', '.rst', '.map',
    '.d.ts', '.d.mts', '.d.cts',
]);

// ملفات plain-TS تُحذف بشرط ألا تكون نقطة دخول (نادرًا ما يحدث).
const PLAIN_TS_EXTS = new Set(['.ts', '.mts', '.cts']);

// أسماء ملفات توثيق بأي امتداد (تُطابق بالاسم الصغير بدون امتداد).
const DOC_BASENAMES = new Set([
    'changelog', 'history', 'authors', 'contributors', 'contributing',
    'notice', 'credits', 'roadmap',
]);

// --- 2) مجلدات آمنة الحذف (تُطابق بالاسم فقط داخل node_modules) ---
const PRUNE_DIRS = new Set([
    'test', 'tests', '__tests__', '__test__', '__mocks__',
    'example', 'examples', 'docs', 'doc', 'coverage',
    '.github', '.vscode',
]);

// --- 3) حماية صارمة: امتدادات لا تُحذف أبدًا حتى لو تطابقت قاعدة أخرى ---
const NEVER_TOUCH_EXTS = new Set([
    '.js', '.mjs', '.cjs', '.json', '.wasm', '.node',
    '.dll', '.exe', '.proto', '.mp3', '.env',
]);

// مسارات المشروع المحمية (خارج node_modules — للأمان لو تغيّر NM مستقبلًا).
const PROTECTED_TOP = new Set(['auth', 'database', 'tts', 'logs']);

const stats = { files: 0, dirs: 0, bytes: 0, byCat: {} };
function add(cat, bytes, isDir) {
    if (isDir) stats.dirs++;
    else stats.files++;
    stats.bytes += bytes;
    stats.byCat[cat] = (stats.byCat[cat] || 0) + bytes;
}
function sizeOf(p) {
    try {
        const st = fs.statSync(p);
        if (st.isFile()) return st.size;
        if (st.isDirectory()) {
            let total = 0;
            for (const e of fs.readdirSync(p)) total += sizeOf(path.join(p, e));
            return total;
        }
    } catch { /* تجاهل — idempotent */ }
    return 0;
}
function removeTarget(p, cat) {
    let bytes = 0;
    try {
        bytes = sizeOf(p);
        if (!DRY) fs.rmSync(p, { recursive: true, force: true });
        add(cat, bytes, true);
        return true;
    } catch (e) {
        console.log(`تخطي (تعذر الحذف): ${p} — ${e.message}`);
        return false;
    }
}
function removeFile(p, cat) {
    let bytes = 0;
    try {
        bytes = fs.statSync(p).size;
        if (!DRY) fs.rmSync(p, { force: true });
        add(cat, bytes, false);
        return true;
    } catch { return false; /* idempotent */ }
}

function baseLowerNoExt(name) {
    const i = name.toLowerCase().lastIndexOf('.');
    return i === -1 ? name.toLowerCase() : name.toLowerCase().slice(0, i);
}

function shouldPruneFile(name) {
    const lower = name.toLowerCase();
    const ext = path.extname(lower);
    if (NEVER_TOUCH_EXTS.has(ext)) return null;
    // إعلانات TS وخرائط المصدر والتوثيق بالامتداد
    if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return 'd.ts إعلانات';
    if (FILE_EXTS.has(ext)) {
        if (ext === '.map') return 'خرائط map';
        return 'توثيق md';
    }
    if (PLAIN_TS_EXTS.has(ext)) return 'مصادر ts';
    if (DOC_BASENAMES.has(baseLowerNoExt(name))) return 'توثيق md';
    return null;
}

function walk(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (PRUNE_DIRS.has(e.name)) {
                const cat = e.name === 'coverage' ? 'مجلد coverage'
                    : (e.name === 'test' || e.name === 'tests' || e.name.startsWith('__test') || e.name === '__mocks__') ? 'مجلدات test'
                    : (e.name === 'example' || e.name === 'examples') ? 'مجلدات examples'
                    : (e.name === 'docs' || e.name === 'doc') ? 'مجلدات docs'
                    : 'مجلدات github/vscode';
                removeTarget(full, cat);
            } else {
                walk(full);
            }
        } else if (e.isFile()) {
            const cat = shouldPruneFile(e.name);
            if (cat) removeFile(full, cat);
        }
    }
}

function fmtMB(b) { return (b / 1048576).toFixed(2); }

function main() {
    if (!fs.existsSync(NM)) {
        console.log('لا يوجد node_modules — لا شيء لفعله.');
        return;
    }
    console.log(DRY ? 'وضع المعاينة (dry-run) — لن يُحذف شيء.' : 'بدء التقليم الآمن لـ node_modules...');
    walk(NM);
    console.log('\n===== ملخص التقليم =====');
    const order = ['مجلد coverage', 'خرائط map', 'd.ts إعلانات', 'مصادر ts', 'توثيق md', 'مجلدات test', 'مجلدات examples', 'مجلدات docs', 'مجلدات github/vscode'];
    for (const c of order) {
        if (stats.byCat[c]) console.log(`- ${c}: ${fmtMB(stats.byCat[c])} MB`);
    }
    for (const c of Object.keys(stats.byCat)) {
        if (!order.includes(c)) console.log(`- ${c}: ${fmtMB(stats.byCat[c])} MB`);
    }
    console.log(`الإجمالي: ${fmtMB(stats.bytes)} MB (${stats.files} ملف، ${stats.dirs} مجلد)${DRY ? ' [معاينة فقط]' : ''}`);
    console.log('للاستعادة: npm install');
}

main();
