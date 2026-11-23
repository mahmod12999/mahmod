// تحميل .env يدويًا (بدون تبعيات خارجية) — لا يُعاد تعريف متغيرات موجودة فعلًا
const fs = require("fs");
const path = require("path");

function loadEnvFile() {
  const p = path.join(__dirname, "..", ".env");
  try {
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // لا يوجد ملف .env (بيئة Vercel تستخدم متغيرات البيئة مباشرة)
  }
}
loadEnvFile();

function intEnv(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

module.exports = {
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL || "",
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN || "",
  // حدود الخدمة — كلها قابلة للضبط عبر متغيرات البيئة
  MAX_SOURCES: intEnv("MAX_SOURCES", 10),
  SOURCE_MAX_MB: intEnv("SOURCE_MAX_MB", 200),
  OUTPUT_MAX_MB: intEnv("OUTPUT_MAX_MB", 150),
  MAX_TOTAL_DURATION_SEC: intEnv("MAX_TOTAL_DURATION_SEC", 600),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
  PORT: intEnv("PORT", 3001),
  VERSION: "1.0.0",
  // 24 ساعة بالمللي ثانية — عمر المهمة قبل حذفها تلقائيًا
  EXPIRE_MS: 24 * 60 * 60 * 1000,
};
