// GET/DELETE /api/jobs/:id — حالة المهمة + التقدم، أو حذف شامل فوري
const db = require("../../lib/db");
const { sendJson, handleOptions, buildBaseUrl } = require("../../lib/httpx");

module.exports.config = { maxDuration: 300 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  const jobId = String(req.query.id || "");
  if (!jobId) return sendJson(res, 400, { error: "معرّف المهمة مفقود" });

  try {
    await db.ensureSchema();
    const job = await db.getJob(jobId);
    if (!job) return sendJson(res, 404, { error: "المهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" });

    if (req.method === "DELETE") {
      await db.deleteJobRows(jobId);
      return sendJson(res, 200, { ok: true, deleted: jobId });
    }
    if (req.method !== "GET") {
      return sendJson(res, 405, { error: "الطريقة غير مسموحة — استخدم GET أو DELETE" });
    }

    const base = buildBaseUrl(req);
    const out = {
      jobId,
      status: job.status,
      progress: Number(job.progress || 0),
      expiresAt: job.expires_at,
    };
    if (job.status === "done") {
      out.videoUrl = `${base}/api/jobs/${jobId}/video`;
      out.downloadUrl = `${base}/api/jobs/${jobId}/video?download=1`;
      out.size = Number(job.video_size || 0);
      out.duration = Number(job.video_duration || 0);
      out.resolution = job.video_resolution;
    }
    if (job.error) out.error = job.error;
    return sendJson(res, 200, out);
  } catch (e) {
    return sendJson(res, 500, { error: `خطأ داخلي: ${e.message}` });
  }
};
