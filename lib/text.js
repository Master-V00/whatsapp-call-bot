/** lib/text.js — توحيد النص العربي + مساعدات اللغة */
function normalizeDigits(s) {
    return String(s || '')
        .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d).toString())
        .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d).toString());
}
// توحيد الحروف ذات الأشكال المتعددة: أإآ→ا ، ة→ه ، ى→ي ، ؤ→و ، ئ→ي (1:1 بدون تغيير الأطوال)
function normalizeAr(s) {
    return String(s || '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/ـ/g, '');
}
const L = (lang, ar, en) => (lang === 'en' ? en : ar);
function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { normalizeDigits, normalizeAr, L, escapeReg };
