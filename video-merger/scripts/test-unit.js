// اختبار وحدات محرك الدمج والتخزين — يولّد فيديوهين مختلفين بـ ffmpeg ثم يدمجهما ويتحقق
// التشغيل: node scripts/test-unit.js
process.env.NODE_ENV = 'test';
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const db = require("../lib/db");
const storage = require("../lib/storage");
const merge = require("../lib/merge");
const sources = require("../lib/sources");

const results = [];
function pass(name) { results.push(["PASS", name]); console.log(`  ✅ ${name}`); }
function fail(name, err) {
  results.push(["FAIL", name]);
  const cause = err?.cause?.message || err?.cause || "";
  console.error(`  ❌ ${name}\n     ${err?.message || err}${cause ? `\n     السبب: ${cause}` : ""}`);
}
async function test(name, fn) {
  try { await fn(); pass(name); }
  catch (e) { fail(name, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "التأكيد فشل"); }

// توليد ملف فيديو اختباري بـ ffmpeg
function makeTestVideo(outPath, { w, h, dur, audio, color }) {
  const args = ["-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=25:duration=${dur}`];
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${dur}`);
  args.push("-pix_fmt", "yuv420p", "-r", "25");
  if (audio) args.push("-c:a", "aac", "-shortest");
  args.push(outPath);
  const r = spawnSync(merge.ffmpegPath(), args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`فشل توليد فيديو الاختبار: ${r.stderr.slice(-400)}`);
  return fs.statSync(outPath).size;
}

(async () => {
  console.log("\n=== اختبار وحدات خدمة الدمج ===\n");
  const TEST_JOB = `test_unit_${Date.now().toString(36)}`;
  await db.ensureSchema();

  // حذف أي آثار سابقة ثم التنظيف النهائي في النهاية
  await db.deleteJobRows(TEST_JOB).catch(() => {});

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-test-"));
  const clipA = path.join(tmp, "a.mp4"); // 320x240 — 3 ث — مع صوت
  const clipB = path.join(tmp, "b.mp4"); // 640x360 — 4 ث — بلا صوت
  const sizeA = makeTestVideo(clipA, { w: 320, h: 240, dur: 3, audio: true });
  const sizeB = makeTestVideo(clipB, { w: 640, h: 360, dur: 4, audio: false });
  console.log(`  📼 تم توليد المقاطع: a=${sizeA}B (320x240 صوت)، b=${sizeB}B (640x360 بلا صوت)`);

  await test("probeFile: يستخرج الدقة والمدة والصوت", async () => {
    const p = await merge.probeFile(clipA);
    assert(p.width === 320 && p.height === 240, `الدقة ${p.width}x${p.height}`);
    assert(Math.abs(p.duration - 3) < 0.5, `المدة ${p.duration}`);
    assert(p.has_audio === 1, "لا يوجد صوت في المقطع أ");
    const p2 = await merge.probeFile(clipB);
    assert(p2.has_audio === 0, "المقطع ب يجب أن يكون بلا صوت");
  });

  await test("التحقق من المصادر: يرفض مقطعًا واحدًا وأكثر من الحد والروابط الداخلية", async () => {
    const one = sources.normalizeSources({ videos: ["https://x.com/a.mp4"] });
    assert(one.error && one.error.includes("مقطعين"), `رفض مصدر واحد: ${one.error}`);
    const empty = sources.normalizeSources({ videos: [] });
    assert(empty.error, "قائمة فارغة يجب رفضها");
    const many = sources.normalizeSources({ videos: Array(11).fill("https://x.com/a.mp4") });
    assert(many.error && many.error.includes("10"), `رفض 11 مصدرًا: ${many.error}`);
    const priv = sources.normalizeSources({ videos: ["http://localhost/a.mp4", "http://127.0.0.1/x.mp4"] });
    assert(priv.error && priv.error.includes("داخلي"), `رفض نطاق داخلي: ${priv.error}`);
    const bad = sources.normalizeSources({ videos: ["ftp://x.com/a.mp4", "https://ok.com/b.mp4"] });
    assert(bad.error, "رفض بروتوكول غير http");
  });

  await test("التخزين: كتابة blob 5MB وقراءته بتطابق sha256", async () => {
    const buf = crypto.randomBytes(5 * 1024 * 1024 + 123);
    await storage.putOutputChunks(TEST_JOB, buf);
    const back = await storage.readSourceFile(TEST_JOB, 0).catch(() => null);
    // نقرأ من source_chunks — نكتب نسخة هناك للمقارنة
    await storage.putSourceChunks(TEST_JOB, 0, buf);
    const back2 = await storage.readSourceFile(TEST_JOB, 0);
    const h1 = crypto.createHash("sha256").update(buf).digest("hex");
    const h2 = crypto.createHash("sha256").update(back2).digest("hex");
    assert(h1 === h2, "عدم تطابق sha256 بعد الاسترجاع من Turso");
    assert(back2.length === buf.length, `طول مختلف: ${back2.length} != ${buf.length}`);
    await db.getDb().batch([
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [TEST_JOB] },
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [TEST_JOB] },
    ]);
  });

  await test("الرفع بالأجزاء: تجميع 3 أجزاء غير متساوية وحساب الحجم", async () => {
    const buf = crypto.randomBytes(7 * 1024 * 1024);
    const seq = 9; // تسلسل خاص بالاختبار
    const CHUNK = 3 * 1024 * 1024;
    // كل جزء مرفوع يُكتب في موقعه: فهرس البداية = رقم الجزء × عدد صفوف 2MB لكل جزء (2)
    const chunksPerPart = Math.ceil(CHUNK / storage.BLOB_CHUNK);
    let parts = 0;
    for (let i = 0; i * CHUNK < buf.length; i++) {
      const part = buf.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, buf.length));
      await storage.putSourceChunks(TEST_JOB, seq, part, i * chunksPerPart);
      parts++;
    }
    const stored = await storage.sourceStoredBytes(TEST_JOB, seq);
    assert(stored.bytes === buf.length, `الحجم المخزن ${stored.bytes} != ${buf.length}`);
    const back = await storage.readSourceFile(TEST_JOB, seq);
    assert(back.length === buf.length);
    const h1 = crypto.createHash("sha256").update(buf).digest("hex");
    const h2 = crypto.createHash("sha256").update(back).digest("hex");
    assert(h1 === h2, "عدم تطابق sha256 لملف مجمع من أجزاء");
    await db.getDb().execute("DELETE FROM source_chunks WHERE job_id = ? AND seq = ?", [TEST_JOB, seq]);
  });

  await test("الدمج الكامل من مصادر مرفوعة: الدقة=الأكبر، المدة≈المجموع، يوجد صوت", async () => {
    // مهمة اختبار حقيقية في القاعدة بمصدرين file
    await db.getDb().batch([
      { sql: "INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, 'queued', 0, ?)",
        args: [TEST_JOB, new Date(Date.now() + 3600e3).toISOString()] },
      { sql: "INSERT INTO sources (job_id, seq, kind, name, mime, size) VALUES (?, 0, 'file', 'a.mp4', 'video/mp4', ?)",
        args: [TEST_JOB, sizeA] },
      { sql: "INSERT INTO sources (job_id, seq, kind, name, mime, size) VALUES (?, 1, 'file', 'b.mp4', 'video/mp4', ?)",
        args: [TEST_JOB, sizeB] },
    ], "write");
    const bufA = fs.readFileSync(clipA);
    const bufB = fs.readFileSync(clipB);
    await storage.putSourceChunks(TEST_JOB, 0, bufA);
    await storage.putSourceChunks(TEST_JOB, 1, bufB);

    const progressSeen = [];
    const result = await merge.runMerge(TEST_JOB, { onProgress: (p) => progressSeen.push(p) });
    assert(result.status === "done", `الحالة ${result.status}`);

    const job = await db.getJob(TEST_JOB);
    assert(job.status === "done", `حالة المهمة ${job.status}`);
    assert(job.video_resolution === "640x360", `الدقة النهائية ${job.video_resolution} — المتوقع 640x360 (أكبر دقة مدخل)`);
    const durSum = 3 + 4;
    assert(Math.abs(Number(job.video_duration) - durSum) < 1.2, `المدة ${job.video_duration} ≈ ${durSum}`);
    assert(Number(job.video_size) === result.size && result.size > 10000, `حجم الناتج ${result.size}`);

    // تحقق من وجود صوت في الناتج (المقطع أ كان فيه صوت) — استخراج و ffprobe
    const stored = await storage.outputStoredBytes(TEST_JOB);
    assert(stored === result.size, `حجم مخزن ${stored} != ${result.size}`);
    const outBuf = await storage.readSourceFile(TEST_JOB, 0).catch(() => null); // source_chunks حُذفت بعد النجاح
    assert(!outBuf || outBuf.length === 0, "أجزاء المصادر يجب أن تُحذف بعد نجاح الدمج");

    // استخراج الناتج إلى ملف وفحصه
    const stream = storage.outputBlobStream(TEST_JOB, null, null);
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    const outFile = path.join(tmp, "out.mp4");
    fs.writeFileSync(outFile, Buffer.concat(chunks.map((c) => Buffer.from(c))));
    const probe = await merge.probeFile(outFile);
    assert(probe.width === 640 && probe.height === 360, `دقة الناتج ${probe.width}x${probe.height}`);
    assert(Math.abs(probe.duration - durSum) < 1.2, `مدة الناتج ${probe.duration}`);
    assert(probe.has_audio === 1, "الناتج يجب أن يحتوي مسار صوت (المقطع أ فيه صوت)");
    assert(progressSeen.some((p) => p >= 40) && progressSeen[progressSeen.length - 1] === 100,
      `تسلسل التقدم: ${progressSeen.slice(0, 3)}…${progressSeen.slice(-3)}`);
  });

  await test("Range stream: قراءة نطاق وسطي بالضبط", async () => {
    const stored = await storage.outputStoredBytes(TEST_JOB);
    const from = 1000, to = stored - 1001; // نطاق وسطي
    const stream = storage.outputBlobStream(TEST_JOB, from, to);
    const chunks = [];
    for await (const c of stream) chunks.push(Buffer.from(c));
    const got = Buffer.concat(chunks);
    assert(got.length === to - from + 1, `طول النطاق ${got.length} != ${to - from + 1}`);
    // مقارنة بأول 16 بايت من نفس الموضع عبر قراءة كاملة
    const full = [];
    for await (const c of storage.outputBlobStream(TEST_JOB, null, null)) full.push(Buffer.from(c));
    const fullBuf = Buffer.concat(full);
    assert(got.equals(fullBuf.subarray(from, to + 1)), "محتوى النطاق غير مطابق");
    assert(fullBuf.length === stored, "القراءة الكاملة غير مطابقة للحجم المخزن");
  });

  await test("الحذف الشامل: كل صفوف المهمة تُحذف من الجداول الأربعة", async () => {
    await db.deleteJobRows(TEST_JOB);
    const job = await db.getJob(TEST_JOB);
    assert(job === null, "المهمة ما تزال موجودة بعد الحذف");
    for (const t of ["sources", "source_chunks", "output_chunks"]) {
      const r = await db.getDb().execute(`SELECT count(*) AS c FROM ${t} WHERE job_id = ?`, [TEST_JOB]);
      assert(Number(r.rows[0].c) === 0, `صفوف متبقية في ${t}`);
    }
  });

  await test("حد حجم المصدر المعلن في normalizeSources (413)", async () => {
    const big = sources.normalizeSources({
      sources: [
        { kind: "url", url: "https://x.com/a.mp4" },
        { kind: "file", name: "big.mp4", size: 201 * 1024 * 1024 },
      ],
    });
    assert(big.error && big.error.includes("تجاوز الحد"), `رفض الحجم: ${big.error}`);
    assert(big.status === 413, `الحالة ${big.status}`);
  });

  fs.rmSync(tmp, { recursive: true, force: true });

  // تنظيف نهائي لأي آثار
  await db.deleteJobRows(TEST_JOB).catch(() => {});

  const passed = results.filter((r) => r[0] === "PASS").length;
  console.log(`\n=== النتيجة: ${passed}/${results.length} ناجح ===\n`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("خطأ عام:", e); process.exit(1); });
