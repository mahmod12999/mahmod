// POST /api/upload?job=&seq=&chunk= — رفع أجزاء ملفات المصادر (ثنائي ≤4MB، تجاوز حد Vercel 4.5MB)
const db = require("../lib/db");
const storage = require("../lib/storage");
const { sendJson, handleOptions, readRawBody, isHttpError } = require("../lib/httpx");

module.exports.config = { maxDuration: 300 };

const CHUNK_LIMIT = 4 * 1024 * 1024; // 4MB

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم POST ثنائي" });
  }
  try {
    await db.ensureSchema();
    const jobId = String(req.query.job || "");
    const seq = parseInt(String(req.query.seq ?? ""), 10);
    const chunkIndex = parseInt(String(req.query.chunk ?? ""), 10);
    if (!jobId || !Number.isFinite(seq) || seq < 0 || !Number.isFinite(chunkIndex) || chunkIndex < 0) {
      return sendJson(res, 400, { error: "معاملات الرفع غير صالحة — أرسل job وseq وchunk" });
    }
    const job = await db.getJob(jobId);
    if (!job) return sendJson(res, 404, { error: "المهمة غير موجودة" });
    if (job.status === "done" || job.status === "processing" || job.status === "failed") {
      return sendJson(res, 409, { error: `لا يمكن الرفع في حالة ${job.status}` });
    }
    const sources = await db.getSources(jobId);
    const src = sources.find((s) => Number(s.seq) === seq);
    if (!src || src.kind !== "file") {
      return sendJson(res, 400, { error: `لا يوجد مصدر ملف بالرقم ${seq} في هذه المهمة` });
    }

    // جسم ثنائي فقط ≤4MB — تجاوز الحد = 413
    const buf = await readRawBody(req, CHUNK_LIMIT);
    if (!buf.length) {
      return sendJson(res, 400, { error: "جسم الطلب فارغ — أرسل الجزء الثنائي كما هو" });
    }
    await storage.putSourceChunks(jobId, seq, buf, chunkIndex * Math.ceil(CHUNK_LIMIT / storage.BLOB_CHUNK));

    // الحالة تنتقل queued → uploading عند أول جزء
    if (job.status === "queued") {
      await db.updateJob(jobId, { status: "uploading" });
    }
    const stored = await storage.sourceStoredBytes(jobId, seq);
    return sendJson(res, 200, {
      ok: true,
      job: jobId,
      seq,
      chunk: chunkIndex,
      received: buf.length,
      totalReceived: stored.bytes,
      expected: Number(src.size || 0),
      complete: Number(src.size || 0) > 0 && stored.bytes >= Number(src.size || 0),
    });
  } catch (e) {
    if (isHttpError(e)) return sendJson(res, e.status, { error: e.message });
    return sendJson(res, 500, { error: `خطأ داخلي: ${e.message}` });
  }
};
