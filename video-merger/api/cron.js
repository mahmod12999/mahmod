// GET /api/cron — حذف المهام المنتهية (Cron يومي عبر vercel.json)
const db = require("../lib/db");
const { sendJson, handleOptions } = require("../lib/httpx");

module.exports.config = { maxDuration: 300 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم GET" });
  }
  try {
    await db.ensureSchema();
    const deleted = await db.cleanupExpired();
    return sendJson(res, 200, { ok: true, deleted, at: new Date().toISOString() });
  } catch (e) {
    return sendJson(res, 500, { error: `خطأ داخلي: ${e.message}` });
  }
};
