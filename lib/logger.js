/**
 * lib/logger.js — لوج موحد: الترمينال + ملف logs/bot-YYYY-MM-DD.log
 * أي require لهذا الملف يجعل console.log/error/warn تُكتب في الملف أيضًا.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');
const pino = require('pino');

const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function dayKey(d = new Date()) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}
const LOG_FILE = path.join(LOG_DIR, `bot-${dayKey()}.log`);

const logger = pino(
    { level: process.env.LOG_LEVEL || 'info' },
    pino.multistream([
        { stream: process.stdout },
        { stream: pino.destination({ dest: LOG_FILE, sync: false }) },
    ])
);

// غلاف للـ console يكتب في الملف أيضًا (إنجليزي فقط حسب سياسة المشروع)
function toFileLine(args) {
    return `[${new Date().toISOString()}] ${util.format(...args)}\n`;
}
for (const fn of ['log', 'warn', 'error']) {
    const orig = console[fn].bind(console);
    console[fn] = (...args) => {
        orig(...args);
        try { fs.appendFileSync(LOG_FILE, toFileLine(args)); } catch {}
    };
}

logger.info(`log file: ${LOG_FILE}`);
module.exports = { logger, LOG_FILE, LOG_DIR };
