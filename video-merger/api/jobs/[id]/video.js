// GET /api/jobs/:id/video — بث الناتج مع دعم Range (206) ليعمل التقديم/الترجيع، و?download=1 للتحميل
const db = require("../../../lib/db");
const storage = require("../../../lib/storage");
const { handleOptions, buildBaseUrl } = require("../../../lib/httpx");

module.exports.config = { maxDuration: 300 };

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return handleOptions(res);
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end();
  }
  const jobId = String(req.query.id || "");
  if (!jobId) {
    res.statusCode = 400;
    return res.end();
  }
  try {
    await db.ensureSchema();
    const job = await db.getJob(jobId);
    if (!job) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: "المهمة غير موجودة" }));
    }
    if (job.status !== "done") {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: `النتيجة غير جاهزة — الحالة الحالية: ${job.status}` }));
    }

    const total = Number(job.video_size || 0) || (await storage.outputStoredBytes(jobId));
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "no-store");
    const isDownload = req.query.download === "1" || req.query.download === "true";
    if (isDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="merged-${jobId}.mp4"`);
    }
    // رابط النتيجة البديل إن لم يتوفر أي شيء آخر
    res.setHeader("X-Job-Id", jobId);

    // تحليل ترويسة Range — bytes=start-end (end اختياري، قد يكون أب من النهاية)
    const range = req.headers.range;
    let start = 0;
    let end = total - 1;
    if (range) {
      const m = String(range).match(/^bytes=(\d*)-(\d*)$/);
      if (!m || (m[1] === "" && m[2] === "")) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
      if (m[1] === "") {
        // لاحقة: آخر N بايت
        const suffix = Number(m[2]);
        start = Math.max(0, total - suffix);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] !== "" ? Math.min(Number(m[2]), total - 1) : total - 1;
      }
      if (start > end || start >= total) {
        res.statusCode = 416;
        res.setHeader("Content-Range", `bytes */${total}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    } else {
      res.statusCode = 200;
    }
    const length = end - start + 1;
    res.setHeader("Content-Length", String(length));

    if (req.method === "HEAD") return res.end();

    // حوّل صفوف الـ Blobs إلى stream مع تقليم أول/آخر جزء حسب المدى
    const stream = storage.outputBlobStream(jobId, start, end);
    stream.pipe(res);
    stream.on("error", () => { try { res.destroy(); } catch {} });
  } catch {
    try { res.statusCode = 500; res.end(); } catch {}
  }
};
