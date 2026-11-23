// GET /api/config — الحدود العامة + version (تُستخدم لفحص جهوزية الخدمة)
const { sendJson, handleOptions } = require("../lib/httpx");
const env = require("../lib/env");

module.exports.config = { maxDuration: 300 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم GET" });
  }
  return sendJson(res, 200, {
    version: env.VERSION,
    limits: {
      maxSources: env.MAX_SOURCES,
      sourceMaxMB: env.SOURCE_MAX_MB,
      outputMaxMB: env.OUTPUT_MAX_MB,
      maxTotalDurationSec: env.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: 4 * 1024 * 1024,
      storageChunkBytes: 2 * 1024 * 1024,
      retentionHours: 24,
    },
    output: {
      format: "MP4 (H.264 + AAC)",
      quality: "CRF 18",
      note: "لا توجد معاملات resolution/fps — الناتج موحّد بأعلى دقة بين المدخلات حتى 1080p",
    },
    now: new Date().toISOString(),
  });
};
