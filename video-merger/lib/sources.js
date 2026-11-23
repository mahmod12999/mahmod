// التحقق من مصادر الدمج وتنظيفها — روابط مباشرة عامة أو ملفات مرفوعة
const env = require("./env");
const { SOURCE_MAX_MB, MAX_SOURCES } = env;

// رفض النطاقات الداخلية/الخاصة — المصادر يجب أن تكون روابط عامة
function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h.endsWith(".localhost")) return true;
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0 || a === 169) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true; // multicast/reserved
  }
  return false;
}

function validateUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "الرابط غير صالح";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "الرابط يجب أن يكون http/https مباشرًا";
  }
  if (isPrivateHost(u.hostname)) {
    return "الرابط يشير إلى نطاق داخلي غير عام — غير مسموح";
  }
  return null;
}

// تطبيع جسم الطلب: {"videos":[...]} أو {"sources":[{kind,url|name,size,mime}]}
function normalizeSources(body) {
  const list = [];
  if (Array.isArray(body?.videos)) {
    for (const v of body.videos) {
      if (typeof v !== "string") return { error: "عنصر غير صالح داخل videos — المتوقع روابط نصية" };
      list.push({ kind: "url", url: v });
    }
  } else if (Array.isArray(body?.sources)) {
    for (const s of body.sources) {
      if (!s || typeof s !== "object") return { error: "عنصر غير صالح داخل sources" };
      if (s.kind === "url") {
        list.push({ kind: "url", url: String(s.url || "") });
      } else if (s.kind === "file") {
        const size = Number(s.size);
        if (!s.name || !Number.isFinite(size) || size <= 0) {
          return { error: "المصدر file يحتاج name وsize صالحين" };
        }
        if (size > SOURCE_MAX_MB * 1024 * 1024) {
          const err = new Error(`حجم الملف «${s.name}» يتجاوز الحد (${SOURCE_MAX_MB}MB)`);
          err.status = 413;
          return { error: err.message, status: 413 };
        }
        list.push({
          kind: "file",
          name: String(s.name).slice(0, 200),
          size: Math.floor(size),
          mime: String(s.mime || "video/mp4").slice(0, 100),
        });
      } else {
        return { error: "kind يجب أن يكون url أو file" };
      }
    }
  } else {
    return { error: "الجسم يجب أن يحتوي videos (روابط) أو sources (مصفوفة مصادر)" };
  }

  if (list.length === 0) {
    return { error: "قائمة المصادر فارغة — مرّر مقطعين على الأقل للدمج" };
  }
  if (list.length < 2) {
    return { error: "الدمج يحتاج مقطعين على الأقل — أضف مقطعًا آخر" };
  }
  if (list.length > MAX_SOURCES) {
    return { error: `أقصى عدد مقاطع للدمج هو ${MAX_SOURCES}` };
  }
  // تحقق الروابط
  for (const s of list) {
    if (s.kind === "url") {
      const err = validateUrl(s.url);
      if (err) return { error: `رابط غير صالح (${s.url.slice(0, 60)}): ${err}` };
    }
  }
  return { sources: list };
}

module.exports = { validateUrl, isPrivateHost, normalizeSources };
