// اختبار HTTP كامل ضد خادم التطوير المحلي — يشغّل الخادم بنفسه إن لم يكن يعمل
// التشغيل: node scripts/test-http.js  (BASE افتراضي http://localhost:3001)
process.env.NODE_ENV = 'test';
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = process.env.BASE || "http://localhost:3001";
const results = [];
function pass(name) { results.push(["PASS", name]); console.log(`  ✅ ${name}`); }
function fail(name, err) { results.push(["FAIL", name]); console.error(`  ❌ ${name}\n     ${err?.message || err}`); }
async function test(name, fn) {
  try { await fn(); pass(name); }
  catch (e) { fail(name, e); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "التأكيد فشل"); }

// عملاء HTTP صغار
function request(method, url, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const { URL } = require("url");
    const u = new URL(url);
    const req = require("http").request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
async function jreq(method, url, body, headers) {
  const r = await request(method, url, {
    headers: { "Content-Type": "application/json", ...(headers || {}) },
    body: body !== undefined ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  return { status: r.status, json: r.buf.length ? JSON.parse(r.buf.toString("utf8")) : null, ...r };
}

// روابط اختبار عامة معروفة
const URL_A = "https://www.w3schools.com/html/mov_bbb.mp4";
const URL_B = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4";

const jobIds = []; // للتنظيف النهائي

(async () => {
  console.log(`\n=== اختبار HTTP ضد ${BASE} ===\n`);

  await test("GET /api/config — الحدود وversion", async () => {
    const r = await jreq("GET", `${BASE}/api/config`);
    assert(r.status === 200, `الحالة ${r.status}`);
    assert(r.json.limits && r.json.limits.maxSources === 10, "الحدود غير صحيحة");
    assert(r.json.version, "version مفقود");
  });

  await test("POST /api/jobs من روابط → 201 مع statusUrl/processUrl/expiresAt", async () => {
    const r = await jreq("POST", `${BASE}/api/jobs`, { videos: [URL_A, URL_B] });
    assert(r.status === 201, `الحالة ${r.status}: ${JSON.stringify(r.json)}`);
    assert(r.json.jobId && r.json.status === "queued", "الشكل غير صحيح");
    assert(r.json.statusUrl.includes(r.json.jobId) && r.json.processUrl.includes("/process"), "الروابط ناقصة");
    assert(r.json.expiresAt, "expiresAt مفقود");
    jobIds.push(r.json.jobId);
  });

  let doneJob = null;
  await test("دورة كاملة: إنشاء → process (متزامن) → done مع روابط", async () => {
    const cr = await jreq("POST", `${BASE}/api/jobs`, { videos: [URL_A, URL_B] });
    assert(cr.status === 201, `الإنشاء ${cr.status}`);
    const jobId = cr.json.jobId;
    jobIds.push(jobId);
    const pr = await jreq("POST", `${BASE}/api/jobs/${jobId}/process`);
    assert(pr.status === 200, `process ${pr.status}: ${JSON.stringify(pr.json)}`);
    assert(pr.json.status === "done", `الحالة ${pr.json.status}`);
    assert(pr.json.videoUrl.includes(`/api/jobs/${jobId}/video`), `videoUrl ${pr.json.videoUrl}`);
    assert(pr.json.downloadUrl.includes("download=1"), "downloadUrl ناقص");
    assert(pr.json.size > 10000 && pr.json.resolution && pr.json.duration > 0, "بيانات الناتج ناقصة");
    doneJob = jobId;
  });

  await test("GET /api/jobs/<id> — الحالة done مع التقدم 100", async () => {
    const r = await jreq("GET", `${BASE}/api/jobs/${doneJob}`);
    assert(r.status === 200 && r.json.status === "done" && r.json.progress === 100, JSON.stringify(r.json));
    assert(r.json.videoUrl && r.json.downloadUrl, "الروابط مفقودة في GET");
  });

  await test("بث الناتج مع Range → 206 و Content-Range صحيح", async () => {
    const r = await request("GET", `${BASE}/api/jobs/${doneJob}/video`, { headers: { Range: "bytes=0-1023" } });
    assert(r.status === 206, `الحالة ${r.status}`);
    assert((r.headers["content-range"] || "").startsWith("bytes 0-1023/"), `Content-Range ${r.headers["content-range"]}`);
    assert(Number(r.headers["content-length"]) === 1024, `الطول ${r.headers["content-length"]}`);
    assert((r.headers["content-type"] || "").includes("video/mp4"), "نوع المحتوى");
    assert(r.buf.length === 1024, `البايتات ${r.buf.length}`);
  });

  await test("Range بدون نهاية (bytes=100-) → 206 ويكمل للنهاية", async () => {
    const head = await request("GET", `${BASE}/api/jobs/${doneJob}/video`, { headers: { Range: "bytes=0-0" } });
    const total = Number((head.headers["content-range"] || "").split("/")[1]);
    const r = await request("GET", `${BASE}/api/jobs/${doneJob}/video`, { headers: { Range: "bytes=100-" } });
    assert(r.status === 206 && r.buf.length === total - 100, `الطول ${r.buf.length} != ${total - 100}`);
  });

  await test("?download=1 → Content-Disposition attachment", async () => {
    const r = await request("GET", `${BASE}/api/jobs/${doneJob}/video?download=1`);
    assert(r.status === 200, `الحالة ${r.status}`);
    assert((r.headers["content-disposition"] || "").includes("attachment"), "الترويسة مفقودة");
    assert((r.headers["accept-ranges"] || "") === "bytes", "Accept-Ranges مفقود");
  });

  await test("مهمة مختلطة: رابط + ملف مرفوع بالأجزاء → done", async () => {
    // ملف صغير مولد محليًا يُرفع كجزء واحد (<4MB)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "http-test-"));
    const small = path.join(tmp, "small.mp4");
    const { execFileSync } = require("child_process");
    const ffmpegStatic = require("../node_modules/ffmpeg-static");
    execFileSync(ffmpegStatic, ["-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=20:duration=2",
      "-pix_fmt", "yuv420p", small]);
    const fbuf = fs.readFileSync(small);
    const cr = await jreq("POST", `${BASE}/api/jobs`, {
      sources: [
        { kind: "url", url: URL_A },
        { kind: "file", name: "small.mp4", size: fbuf.length, mime: "video/mp4" },
      ],
    });
    assert(cr.status === 201, `الإنشاء ${cr.status}: ${JSON.stringify(cr.json)}`);
    assert(Array.isArray(cr.json.uploads) && cr.json.uploads.length === 1 && cr.json.uploads[0].seq === 1,
      "uploads غير صحيح");
    const jobId = cr.json.jobId;
    jobIds.push(jobId);
    // رفع الجزء
    const up = await request("POST", `${BASE}/api/upload?job=${jobId}&seq=1&chunk=0`,
      { headers: { "Content-Type": "application/octet-stream" }, body: fbuf });
    assert(up.status === 200, `الرفع ${up.status}: ${up.buf.toString().slice(0, 200)}`);
    // الدمج
    const pr = await jreq("POST", `${BASE}/api/jobs/${jobId}/process`);
    assert(pr.status === 200 && pr.json.status === "done", `process ${pr.status}: ${JSON.stringify(pr.json)}`);
    // التحقق من البث
    const v = await request("GET", `${BASE}/api/jobs/${jobId}/video`, { headers: { Range: "bytes=0-99" } });
    assert(v.status === 206 && v.buf.length === 100, "بث الناتج المختلط فشل");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await test("رفع جزء يتجاوز 4MB → 413", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024 + 100, 7);
    const cr = await jreq("POST", `${BASE}/api/jobs`, {
      sources: [{ kind: "url", url: URL_A }, { kind: "file", name: "x.mp4", size: big.length }],
    });
    const jobId = cr.json.jobId;
    jobIds.push(jobId);
    const up = await request("POST", `${BASE}/api/upload?job=${jobId}&seq=1&chunk=0`,
      { headers: { "Content-Type": "application/octet-stream" }, body: big });
    assert(up.status === 413, `الحالة ${up.status}`);
  });

  await test("رفع على مهمة غير موجودة → 404", async () => {
    const up = await request("POST", `${BASE}/api/upload?job=no_such_job&seq=0&chunk=0`,
      { headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("abc") });
    assert(up.status === 404, `الحالة ${up.status}`);
  });

  await test("DELETE ثم GET → 404", async () => {
    const cr = await jreq("POST", `${BASE}/api/jobs`, { videos: [URL_A, URL_B] });
    const jobId = cr.json.jobId;
    const d = await jreq("DELETE", `${BASE}/api/jobs/${jobId}`);
    assert(d.status === 200 && d.json.ok === true, `DELETE ${d.status}`);
    const g = await jreq("GET", `${BASE}/api/jobs/${jobId}`);
    assert(g.status === 404, `GET بعد الحذف ${g.status}`);
    const v = await request("GET", `${BASE}/api/jobs/${jobId}/video`);
    assert(v.status === 404, `video بعد الحذف ${v.status}`);
  });

  await test("JSON تالف → 400 برسالة عربية", async () => {
    const r = await jreq("POST", `${BASE}/api/jobs`, "{bad json!!");
    assert(r.status === 400, `الحالة ${r.status}`);
    assert(r.json.error && r.json.error.includes("JSON"), `الرسالة: ${r.json.error}`);
  });

  await test("قائمة فارغة → 400 برسالة عربية", async () => {
    const r = await jreq("POST", `${BASE}/api/jobs`, { videos: [] });
    assert(r.status === 400 && r.json.error.includes("فارغة"), JSON.stringify(r.json));
  });

  await test("مصدر واحد → 400، و11 مصدرًا → 400", async () => {
    const one = await jreq("POST", `${BASE}/api/jobs`, { videos: [URL_A] });
    assert(one.status === 400 && one.json.error.includes("مقطعين"), JSON.stringify(one.json));
    const many = await jreq("POST", `${BASE}/api/jobs`, { videos: Array(11).fill(URL_A) });
    assert(many.status === 400 && many.json.error.includes("10"), JSON.stringify(many.json));
  });

  await test("رابط داخلي (localhost) → 400", async () => {
    const r = await jreq("POST", `${BASE}/api/jobs`, { videos: ["http://localhost/x.mp4", "http://localhost/y.mp4"] });
    assert(r.status === 400 && r.json.error.includes("داخلي"), JSON.stringify(r.json));
  });

  await test("طريقة خاطئة → 405", async () => {
    const r = await jreq("GET", `${BASE}/api/jobs`, undefined);
    assert(r.status === 405, `الحالة ${r.status}`);
  });

  await test("process لمهمة غير موجودة → 404 برسالة عربية", async () => {
    const r = await jreq("POST", `${BASE}/api/jobs/no_such/process`);
    assert(r.status === 404, `الحالة ${r.status}`);
    assert(r.json.error.includes("غير موجودة"), JSON.stringify(r.json));
  });

  await test("GET /api/cron — يعمل ويعيد عدد المحذوف", async () => {
    const r = await jreq("GET", `${BASE}/api/cron`);
    assert(r.status === 200 && r.json.ok === true && Number.isFinite(r.json.deleted), JSON.stringify(r.json));
  });

  await test("الواجهة: GET / يعيد HTML عربي RTL", async () => {
    const r = await request("GET", `${BASE}/`);
    assert(r.status === 200, `الحالة ${r.status}`);
    const html = r.buf.toString("utf8");
    assert(html.includes('dir="rtl"') && html.includes('lang="ar"'), "الواجهة ليست RTL عربية");
    assert(html.includes("دمج"), "المحتوى العربي مفقود");
  });

  // التنظيف: حذف كل مهام الاختبار من الخدمة
  let cleaned = 0;
  for (const id of jobIds) {
    const d = await jreq("DELETE", `${BASE}/api/jobs/${id}`).catch(() => null);
    if (d && d.status === 200) cleaned++;
  }
  console.log(`\n  🧹 تم تنظيف ${cleaned}/${jobIds.length} مهام اختبار من الخدمة`);

  const passed = results.filter((r) => r[0] === "PASS").length;
  console.log(`\n=== النتيجة: ${passed}/${results.length} ناجح ===\n`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error("خطأ عام:", e); process.exit(1); });
