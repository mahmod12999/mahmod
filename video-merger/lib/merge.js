// محرك الدمج — ffmpeg/ffprobe داخل الدالة نفسها، جودة عالية CRF 18 + AAC
// تقدّم الترميز يُقرأ من -progress pipe:1 ويُخزَّن في القاعدة (0-40 سحب، 40-90 ترميز، 100 اكتمال)
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { createWriteStream, createReadStream } = require("fs");

const env = require("./env");
const db = require("./db");
const storage = require("./storage");

// ffprobe الثابت من ffprobe-static (كائن {path})
const ffprobeStatic = require("ffprobe-static");
const ffmpegStatic = require("ffmpeg-static");

// ffmpeg قد يفقد صلاحية التنفيذ في الاستضافة — نسخة إلى /tmp بصلاحية 755 عند الحاجة
const execCache = {};
function ensureExecutable(binPath) {
  if (execCache[binPath]) return execCache[binPath];
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    execCache[binPath] = binPath;
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), "merger-bins");
    fs.mkdirSync(tmp, { recursive: true });
    const dest = path.join(tmp, path.basename(binPath));
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(binPath, dest);
      fs.chmodSync(dest, 0o755);
    }
    execCache[binPath] = dest;
    return dest;
  }
}

function ffmpegPath() {
  return ensureExecutable(ffmpegStatic);
}
function ffprobePath() {
  return ensureExecutable(ffprobeStatic.path);
}

// تشغيل أمر جمع المخرجات
function runCmd(bin, args, { onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";
    p.stdout.on("data", (d) => {
      const text = d.toString();
      if (onStdoutLine) {
        buf += text;
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const l of lines) onStdoutLine(l.trim());
      } else {
        stdout += text;
      }
    });
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(bin)} خرج برمز ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

// فحص ملف فيديو: الدقة، معدل الإطارات، المدة، وجود صوت
async function probeFile(filePath) {
  const { stdout } = await runCmd(ffprobePath(), [
    "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath,
  ]);
  const meta = JSON.parse(stdout);
  const v = meta.streams?.find((s) => s.codec_type === "video");
  const a = meta.streams?.find((s) => s.codec_type === "audio");
  const duration = parseFloat(meta.format?.duration || v?.duration || "0") || 0;
  const fpsParts = String(v?.avg_frame_rate || "0/1").split("/");
  const fps = fpsParts.length === 2 && Number(fpsParts[1])
    ? Number(fpsParts[0]) / Number(fpsParts[1]) : 0;
  return {
    width: v?.width || 0,
    height: v?.height || 0,
    duration,
    fps: Math.round(fps * 1000) / 1000,
    has_audio: a ? 1 : 0,
  };
}

// تنزيل رابط مباشر إلى ملف مؤقت مع حد حجم ومتابعة تقدّم
async function downloadToFile(url, dest, maxBytes, onBytes) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    const err = new Error(`فشل تنزيل المصدر (HTTP ${res.status}) — تأكد أن الرابط مباشر وعام`);
    err.final = true; // فشل حتمي: المصدر يرفض التحميل، التكرار لا يفيد
    throw err;
  }
  const nodeStream = Readable.fromWeb(res.body);
  let bytes = 0;
  nodeStream.on("data", (c) => {
    bytes += c.length;
    if (bytes > maxBytes) {
      const err = new Error(`حجم المصدر يتجاوز الحد (${env.SOURCE_MAX_MB}MB)`);
      err.status = 413;
      nodeStream.destroy(err);
    }
    if (onBytes) onBytes(bytes);
  });
  await pipeline(nodeStream, createWriteStream(dest));
  return fs.statSync(dest).size;
}

// تحديد هدف الدقة: أكبر دقة بين المدخلات بحد 1920×1080 وأبعاد زوجية
function computeTarget(probes) {
  const maxW = Math.max(...probes.map((p) => p.width || 0));
  const maxH = Math.max(...probes.map((p) => p.height || 0));
  let w = Math.min(maxW || 1280, 1920);
  let h = Math.min(maxH || 720, 1080);
  if (w % 2) w -= 1;
  if (h % 2) h -= 1;
  return { w: Math.max(w, 2), h: Math.max(h, 2) };
}

// تنفيذ الدمج الكامل لمهمة — يُنفَّذ من /api/jobs/:id/process
async function runMerge(jobId, { onProgress } = {}) {
  await db.ensureSchema();
  const job = await db.getJob(jobId);
  if (!job) throw Object.assign(new Error("المهمة غير موجودة"), { status: 404 });
  const sources = await db.getSources(jobId);
  if (sources.length < 2) {
    throw Object.assign(new Error("الدمج يحتاج مقطعين على الأقل"), { status: 400 });
  }

  const setP = (p) => { if (onProgress) onProgress(p); };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-${jobId.slice(0, 8)}-`));
  const files = [];
  try {
    // 1) تجهيز الملفات المحلية: تنزيل الروابط أو استخراج الملفات المرفوعة (تقدّم 0..40)
    const n = sources.length;
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src_${i}.bin`);
      if (s.kind === "url") {
        await downloadToFile(s.url, dest, env.SOURCE_MAX_MB * 1024 * 1024);
      } else {
        const buf = await db.withRetry(() => storage.readSourceFile(jobId, Number(s.seq)));
        fs.writeFileSync(dest, buf);
      }
      files.push(dest);
      // توزيع تقدّم السحب على عدد المصادر
      setP(Math.round(((i + 1) / n) * 40));
    }

    // 2) فحص كل مصدر بـ ffprobe وتخزين الخصائص
    const probes = [];
    for (let i = 0; i < n; i++) {
      const p = await probeFile(files[i]);
      if (!p.width || !p.height) {
        throw new Error(`المصدر ${i + 1} ليس ملف فيديو صالحًا أو تالف`);
      }
      probes.push(p);
      await db.getDb().execute(
        "UPDATE sources SET duration = ?, width = ?, height = ?, has_audio = ? WHERE job_id = ? AND seq = ?",
        [p.duration, p.width, p.height, p.has_audio, jobId, Number(sources[i].seq)]
      );
    }
    const totalDuration = probes.reduce((s, p) => s + p.duration, 0);
    if (totalDuration > env.MAX_TOTAL_DURATION_SEC) {
      throw new Error(`مجموع مدد المقاطع (${Math.round(totalDuration)} ثانية) يتجاوز الحد (${env.MAX_TOTAL_DURATION_SEC} ثانية)`);
    }

    // 3) بناء أمر ffmpeg: توحيد الدقة + fps + صوت لكل مصدر ثم concat
    const { w, h } = computeTarget(probes);
    const args = ["-y", "-hide_banner"];
    const filters = [];
    const segs = [];
    let extraShortest = false;
    for (let i = 0; i < n; i++) {
      args.push("-fflags", "+genpts", "-i", files[i]);
      filters.push(
        `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1,format=yuv420p[v${i}]`
      );
      if (probes[i].has_audio) {
        filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        const dur = probes[i].duration;
        if (dur > 0) {
          // مصدر بلا صوت — نولّد مسارًا صامتًا بنفس مدته بدل أن يفشل الدمج
          filters.push(`aevalsrc=0:c=stereo:s=44100:d=${dur.toFixed(3)}[a${i}]`);
        } else {
          // مدة غير معروفة — مدخل صامت مستمر مع -shortest
          args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
          const idx = args.filter((a) => a === "-i").length - 1;
          filters.push(`[${idx}:a]aresample=44100[a${i}]`);
          extraShortest = true;
        }
      }
      segs.push(`[v${i}][a${i}]`);
    }
    filters.push(`${segs.join("")}concat=n=${n}:v=1:a=1[vout][aout]`);
    const outPath = path.join(tmpDir, "out.mp4");
    args.push(
      "-filter_complex", filters.join(";"),
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", env.FFMPEG_PRESET, "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
      "-movflags", "+faststart"
    );
    if (extraShortest) args.push("-shortest");
    args.push("-progress", "pipe:1", "-nostats", outPath);

    // 4) تنفيذ مع قراءة التقدّم (40..90) من out_time_us
    await runCmd(ffmpegPath(), args, {
      onStdoutLine: (line) => {
        const m = line.match(/^out_time_us=(\d+)/);
        if (m && totalDuration > 0) {
          const t = Number(m[1]) / 1e6;
          const pct = 40 + Math.min((t / totalDuration) * 50, 50);
          setP(Math.round(pct));
        }
      },
    });

    // 5) فحص حجم الناتج ثم تخزينه في القاعدة (الناتج فقط هو المطلوب)
    const size = fs.statSync(outPath).size;
    if (size > env.OUTPUT_MAX_MB * 1024 * 1024) {
      throw Object.assign(
        new Error(`حجم الناتج (${(size / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد (${env.OUTPUT_MAX_MB}MB)`),
        { status: 413 }
      );
    }
    const buf = new Uint8Array(fs.readFileSync(outPath));
    await db.withRetry(() => storage.putOutputChunks(jobId, buf));
    // بعد نجاح الدمج نحذف أجزاء المصادر المرفوعة — الناتج فقط هو المطلوب
    await db.getDb().execute("DELETE FROM source_chunks WHERE job_id = ?", [jobId]);

    await db.updateJob(jobId, {
      status: "done",
      progress: 100,
      video_size: size,
      video_duration: Math.round(totalDuration * 100) / 100,
      video_resolution: `${w}x${h}`,
      error: null,
    });
    setP(100);
    return {
      status: "done",
      videoUrl: null, // تُبنى من buildBaseUrl في نقطة process
      size,
      duration: Math.round(totalDuration * 100) / 100,
      resolution: `${w}x${h}`,
    };
  } finally {
    // نظافة /tmp دائمًا — لا ملفات دائمة على القرص
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  runMerge,
  probeFile,
  ensureExecutable,
  ffmpegPath,
  ffprobePath,
  computeTarget,
  downloadToFile,
};
