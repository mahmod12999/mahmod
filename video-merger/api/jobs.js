// POST /api/jobs — إنشاء مهمة دمج (روابط مباشرة أو مصادر ملفات تُرفع لاحقًا)
const db = require("../lib/db");
const { normalizeSources } = require("../lib/sources");
const { sendJson, handleOptions, readJsonBody, buildBaseUrl, isHttpError } = require("../lib/httpx");
const env = require("../lib/env");

module.exports.config = { maxDuration: 300 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم POST" });
  }
  try {
    await db.ensureSchema();
    // تنظيف كسول للمهام المنتهية (يُنفَّذ عند كل إنشاء)
    await db.cleanupExpired().catch(() => {});

    const body = await readJsonBody(req);
    const norm = normalizeSources(body);
    if (norm.error) {
      return sendJson(res, norm.status || 400, { error: norm.error });
    }

    const jobId = `mk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = new Date(Date.now() + env.EXPIRE_MS).toISOString();

    await db.getDb().batch([
      {
        sql: "INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, 'queued', 0, ?)",
        args: [jobId, expiresAt],
      },
      ...norm.sources.map((s, i) => ({
        sql: "INSERT INTO sources (job_id, seq, kind, url, name, mime, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
        args: [
          jobId, i, s.kind,
          s.kind === "url" ? s.url : null,
          s.kind === "file" ? s.name : null,
          s.kind === "file" ? s.mime : null,
          s.kind === "file" ? s.size : null,
        ],
      })),
    ], "write");

    const base = buildBaseUrl(req);
    const out = {
      jobId,
      status: "queued",
      statusUrl: `${base}/api/jobs/${jobId}`,
      processUrl: `${base}/api/jobs/${jobId}/process`,
      expiresAt,
    };
    // عند وجود ملفات: نعيد روابط رفع لكل مصدر + حجم الجزء المسموح
    const fileSources = norm.sources.map((s, i) => ({ s, i })).filter((x) => x.s.kind === "file");
    if (fileSources.length) {
      out.uploads = fileSources.map(({ s, i }) => ({
        seq: i,
        name: s.name,
        uploadUrl: `${base}/api/upload?job=${jobId}&seq=${i}&chunk=`,
        uploadChunkBytes: 4 * 1024 * 1024,
      }));
    }
    return sendJson(res, 201, out);
  } catch (e) {
    if (isHttpError(e)) return sendJson(res, e.status, { error: e.message });
    return sendJson(res, 500, { error: `خطأ داخلي: ${e.message}` });
  }
};
