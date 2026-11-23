// POST /api/jobs/:id/process — تنفيذ الدمج كاملًا (متزامن) وإرجاع رابط الفيديو النهائي
const db = require("../../../lib/db");
const storage = require("../../../lib/storage");
const merge = require("../../../lib/merge");
const { sendJson, handleOptions, buildBaseUrl, isHttpError } = require("../../../lib/httpx");

module.exports.config = { maxDuration: 300 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم POST" });
  }
  const jobId = String(req.query.id || "");
  if (!jobId) return sendJson(res, 400, { error: "معرّف المهمة مفقود" });

  try {
    await db.ensureSchema();
    await db.cleanupExpired().catch(() => {});
    const job = await db.getJob(jobId);
    if (!job) {
      return sendJson(res, 404, { error: "المهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" });
    }
    if (job.status === "done") {
      // النتيجة جاهزة سابقًا — أعدها كما هي
      const base = buildBaseUrl(req);
      return sendJson(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: Number(job.video_size || 0),
        duration: Number(job.video_duration || 0),
        resolution: job.video_resolution,
        expiresAt: job.expires_at,
      });
    }
    if (job.status === "processing") {
      return sendJson(res, 202, { status: "processing", progress: Number(job.progress || 0) });
    }
    if (job.status === "failed") {
      return sendJson(res, 409, { error: `المهمة فشلت سابقًا: ${job.error || "سبب غير معروف"}` });
    }

    // تحقق: المصادر المرفوعة يجب أن تكون مكتملة قبل الدمج
    const sources = await db.getSources(jobId);
    for (const s of sources) {
      if (s.kind === "file") {
        const stored = await storage.sourceStoredBytes(jobId, Number(s.seq));
        if (stored.bytes < Number(s.size || 0)) {
          await db.updateJob(jobId, { status: "failed", error: "المصادر المرفوعة غير مكتملة" });
          return sendJson(res, 409, {
            error: `المصدر المرفوع رقم ${Number(s.seq) + 1} غير مكتمل (وصل ${stored.bytes} من ${s.size} بايت) — ارفع الأجزاء أولًا`,
          });
        }
      }
    }

    await db.updateJob(jobId, { status: "processing", progress: 1, error: null });

    // تقدّم حقيقي يُكتب في القاعدة أثناء العمل (100 تُكتب عند الاكتمال النهائي فقط)
    let last = 0;
    const onProgress = (p) => {
      if (p >= 100) return; // لا تسبق كتابة الاكتمال النهائي
      if (p > last + 1) {
        last = p;
        db.updateJob(jobId, { progress: p }).catch(() => {});
      }
    };

    try {
      const result = await merge.runMerge(jobId, { onProgress });
      const base = buildBaseUrl(req);
      return sendJson(res, 200, {
        status: "done",
        videoUrl: `${base}/api/jobs/${jobId}/video`,
        downloadUrl: `${base}/api/jobs/${jobId}/video?download=1`,
        size: result.size,
        duration: result.duration,
        resolution: result.resolution,
        expiresAt: (await db.getJob(jobId))?.expires_at,
      });
    } catch (e) {
      // فشل واضح برسالة — وليس انهيارًا
      await db.updateJob(jobId, {
        status: "failed",
        error: (e.message || "خطأ غير معروف أثناء الدمج").slice(0, 500),
      }).catch(() => {});
      return sendJson(res, e.status || 500, { error: e.message || "فشل الدمج" });
    }
  } catch (e) {
    if (isHttpError(e)) return sendJson(res, e.status, { error: e.message });
    return sendJson(res, 500, { error: `خطأ داخلي: ${e.message}` });
  }
};
