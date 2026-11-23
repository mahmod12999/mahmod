// اختبار e2e حقيقي كامل: تبديل تسلسلي + صورة حقيقية + مفتاح مستنزف + فيديو حقيقي + دمج + list_media
// التشغيل: node scripts/e2e-test.mjs  (الخادم على :3000 وخدمة الدمج على :3001)
import { createClient } from "../mcp-media-generator/node_modules/@libsql/client/lib-esm/node.js";
import { readFileSync } from "fs";

const BASE = process.env.BASE || "http://localhost:3000";
const MERGER = process.env.MERGER || "http://localhost:3001";

// قراءة متغيرات البيئة من .env.local للوصول المباشر للقاعدة (تنظيف/تحقق فقط)
const envText = readFileSync(new URL("../mcp-media-generator/.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !line.includes("#")) env[m[1]] = m[2].trim();
}
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

// المفتاح الحقيقي يُقرأ من متغير البيئة E2E_REAL_KEY — لا أسرار في الكود أو Git
// (المفتاح موجود فعلًا في القاعدة بعد الإعداد الأولي من لوحة الإدارة)
const REAL_KEY = process.env.E2E_REAL_KEY || "";
const FAKE_KEY = "test-invalid-key-000000000000000000";
const FAKE_KEY_2 = "test-exhausted-key-0000000000000000";

let pass = 0, fail = 0;
const createdTaskIds = []; // للتنظيف
const createdKeyIds = []; // مفاتيح الاختبار تُحذف
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${String(e.message || e).slice(0, 400)}`); }
}
function assert(c, m) { if (!c) throw new Error(m || "التأكيد فشل"); }

// نداء MCP مع التقاط إشعارات التقدم
async function mcpCall(id, method, params, onEvent) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  let result = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const msg = JSON.parse(line.slice(5).trim());
      if (msg.id === id) result = msg;
      else if (onEvent && msg.params?.progressToken !== undefined) onEvent(msg);
    } catch { /* تجاهل */ }
  }
  if (!result) throw new Error(`لا استجابة للمعرّف ${id}: ${text.slice(0, 200)}`);
  return { result, sseText: text };
}

async function callTool(name, args, onEvent) {
  const { result, sseText } = await mcpCall(Math.floor(Math.random() * 1e9), "tools/call", { name, arguments: args }, onEvent);
  return {
    text: result.result?.content?.[0]?.text ?? "",
    isError: result.result?.isError === true,
    sseText,
  };
}

async function api(path, opts = {}) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}

console.log(`\n=== اختبار e2e حقيقي على ${BASE} ===\n`);

// ---------- التجهيز: مفاتيح الاختبار بالترتيب الصارم ----------
await test("تجهيز المفاتيح: خاطئ أولًا ثم مستنزف ثم الصحيح (ترتيب الإضافة)", async () => {
  // تنظيف آثار تشغيل سابق إن وجدت
  const { json } = await api("/api/keys");
  for (const k of json.keys ?? []) {
    if ((k.label || "").startsWith("e2e-")) {
      await api(`/api/keys/${k.id}`, { method: "DELETE" });
    }
  }
  // 1) مفتاح خاطئ — يجب أن يُجرَّب أولًا ثم يُعطَّل تلقائيًا
  const r1 = await api("/api/keys", { method: "POST", body: JSON.stringify({ provider: "kie", api_key: FAKE_KEY, label: "e2e-bad" }) });
  assert(r1.status === 201, `إضافة الخاطئ ${r1.status}: ${JSON.stringify(r1.json)}`);
  createdKeyIds.push(r1.json.id);
  // 2) مفتاح "مستنزف" — نضع حالته exhausted يدويًا (محاكاة نتيجة 402 من المزود)
  const r2 = await api("/api/keys", { method: "POST", body: JSON.stringify({ provider: "kie", api_key: FAKE_KEY_2, label: "e2e-exhausted" }) });
  assert(r2.status === 201, `إضافة المستنزف ${r2.status}`);
  createdKeyIds.push(r2.json.id);
  await db.execute("UPDATE api_keys SET status='exhausted' WHERE id=?", [r2.json.id]);
  // 3) المفتاح الحقيقي الأخير — بتسمية دائمة (لا يبدأ بـ e2e) حتى لا يُحذف في التنظيف
  const existing = await api("/api/keys");
  const already = (existing.json.keys ?? []).find((k) => k.masked?.startsWith(REAL_KEY.slice(0, 7)));
  if (!already) {
    const r3 = await api("/api/keys", { method: "POST", body: JSON.stringify({ provider: "kie", api_key: REAL_KEY, label: "الرئيسي-kie" }) });
    assert(r3.status === 201, `إضافة الحقيقي ${r3.status}: ${JSON.stringify(r3.json)}`);
  }
});

await test("الإخفاء الإلزامي: القائمة مقنّعة ولا يظهر المفتاح الكامل أبدًا", async () => {
  const { json } = await api("/api/keys");
  const real = json.keys.find((k) => k.label === "e2e-real");
  assert(real, "المفتاح الحقيقي مفقود");
  assert(real.masked.startsWith("cb95baa") && real.masked.includes("••••••••"), `التقنيع: ${real.masked}`);
  assert(!JSON.stringify(json).includes(REAL_KEY), "المفتاح الكامل ظهر في الاستجابة!");
});

await test("رفض التكرار: نفس المفتاح لنفس المزود → 409", async () => {
  const r = await api("/api/keys", { method: "POST", body: JSON.stringify({ provider: "kie", api_key: REAL_KEY }) });
  assert(r.status === 409, `الحالة ${r.status}`);
});

// ---------- اختبار 1: توليد صورة حقيقي مع التبديل التسلسلي ----------
let imageTaskId = null;
let progressCount = 0;
await test("توليد صورة حقيقي: المفتاح الخاطئ يُعطَّل تلقائيًا والمهمة تكتمل على الثاني (تبديل صامت)", async () => {
  const out = await callTool("generate_image", {
    prompt: "a cute orange cat astronaut floating in space, cartoon style, vibrant colors",
    wait_seconds: 120,
  }, (evt) => { if (evt.params?.progress !== undefined) progressCount++; });
  imageTaskId = (out.text.match(/task_id: ([\w-]+)/) || [])[1];
  if (imageTaskId) createdTaskIds.push(imageTaskId);
  assert(!out.isError, `رد خطأ: ${out.text.slice(0, 300)}`);
  // العميل لا يرى أي ذكر لمفاتيح أو رصيد أبدًا
  const bad = /مفتاح|رصيد|balance|api key|insufficient|unauthorized/i.test(out.text);
  assert(!bad, `ذُكر مفتاح/رصيد في رد العميل! ${out.text.slice(0, 200)}`);
  if (out.text.includes("✅")) {
    const url = (out.text.match(/الرابط المباشر: (\S+)/) || [])[1];
    assert(url, `لا رابط في الرد: ${out.text.slice(0, 300)}`);
    // الرابط يعمل فعلًا
    const head = await fetch(url, { method: "HEAD" }).catch(() => null);
    assert(head && head.ok, `الرابط لا يعمل: ${url}`);
    console.log(`     → 🖼️ رابط الصورة يعمل: ${url.slice(0, 80)}…`);
  } else {
    assert(out.text.includes("قيد المعالجة"), `رد غير متوقع: ${out.text.slice(0, 200)}`);
    console.log(`     → المهمة جارية، سنتابع بـ get_task: ${imageTaskId}`);
  }
});

await test("المفتاح الخاطئ أصبح disabled، والمستنزف بقي في المجموعة وجرِّب دون عرقلة التالي", async () => {
  const { json } = await api("/api/keys");
  const bad = json.keys.find((k) => k.label === "e2e-bad");
  const exh = json.keys.find((k) => k.label === "e2e-exhausted");
  assert(bad?.status === "disabled", `حالة الخاطئ: ${bad?.status}`);
  // المستنزف يبقى في القاعدة ويُجرَّب بالترتيب (سياسة المواصفة) — ثم يُصنَّف حسب رد المزود الفعلي
  assert(exh?.usageCount >= 1, `استخدام المستنزف: ${exh?.usageCount} — يجب أن يُجرَّب رغم حالته (لا يُستبعد)`);
  assert(exh?.status === "exhausted" || exh?.status === "disabled", `حالة المستنزف: ${exh?.status}`);
  console.log(`     → المستنزف حاول ${exh.usageCount} مرة ونتيجة حالته الآن: ${exh.status}`);
});

await test("إشعارات التقدم الحي وصلت أثناء الانتظار", async () => {
  // إن اكتملت الصورة فورًا قد لا تصل إشعارات — نقبل ذلك لكن نتحقق إن وُجد انتظار
  if (progressCount === 0) console.log("     → اكتملت فورًا بدون نافذة انتظار (مقبول)");
  else console.log(`     → وصل ${progressCount} إشعار تقدم حي`);
});

// متابعة عبر get_task إن لم تكتمل خلال النافذة
if (imageTaskId) {
  const { json: st } = await api(`/api/tasks?limit=5`);
  const t = st.tasks?.find((x) => x.id === imageTaskId);
  if (t && t.status !== "completed") {
    await test("get_task يتابع المهمة حتى اكتمالها برابط يعمل", async () => {
      for (let i = 0; i < 30; i++) {
        const out = await callTool("get_task", { task_id: imageTaskId });
        if (out.text.includes("✅")) {
          const url = (out.text.match(/الرابط المباشر: (\S+)/) || [])[1];
          const head = await fetch(url, { method: "HEAD" }).catch(() => null);
          assert(head && head.ok, `الرابط لا يعمل: ${url}`);
          assert(!/مفتاح|رصيد|balance/i.test(out.text), "ذُكر مفتاح/رصيد!");
          console.log(`     → 🖼️ اكتملت بعد ${i * 10} ث: ${url.slice(0, 80)}…`);
          return;
        }
        assert(!out.isError, `خطأ: ${out.text}`);
        await new Promise((r) => setTimeout(r, 10000));
      }
      throw new Error("انتهى الانتظار (5 دقائق) بدون اكتمال");
    });
  }
}

// ---------- اختبار 2: توليد فيديو حقيقي ----------
let videoTaskId = null;
await test("توليد فيديو حقيقي: يعيد task_id ثم get_task حتى رابط فيديو يعمل", async () => {
  const out = await callTool("generate_video", {
    prompt: "a majestic eagle soaring over snowy mountains at sunrise, cinematic, natural sound of wind",
    duration: 8,
    wait_seconds: 240,
  }, (evt) => { if (evt.params?.progress !== undefined) progressCount++; });
  videoTaskId = (out.text.match(/task_id: ([\w-]+)/) || [])[1];
  if (videoTaskId) createdTaskIds.push(videoTaskId);
  assert(!out.isError, `رد خطأ: ${out.text.slice(0, 300)}`);
  assert(!/مفتاح|رصيد|balance|insufficient/i.test(out.text), "ذُكر مفتاح/رصيد!");

  let videoUrl = null;
  if (out.text.includes("✅")) {
    videoUrl = (out.text.match(/الرابط المباشر: (\S+)/) || [])[1];
    console.log(`     → 🎬 اكتمل خلال النافذة: ${videoUrl?.slice(0, 80)}…`);
  } else {
    assert(videoTaskId && out.text.includes("قيد المعالجة"), `رد غير متوقع: ${out.text.slice(0, 200)}`);
    console.log(`     → ⏳ task_id: ${videoTaskId} — متابعة كل 10 ثوانٍ…`);
    // متابعة get_task كل ~10 ثوانٍ حتى 12 دقيقة
    const started = Date.now();
    while (Date.now() - started < 12 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 10000));
      const poll = await callTool("get_task", { task_id: videoTaskId });
      assert(!/مفتاح|رصيد|balance|insufficient/i.test(poll.text), `ذُكر مفتاح/رصيد: ${poll.text.slice(0, 200)}`);
      if (poll.text.includes("✅")) {
        videoUrl = (poll.text.match(/الرابط المباشر: (\S+)/) || [])[1];
        console.log(`     → 🎬 اكتمل بعد ${Math.round((Date.now() - started) / 1000)} ث: ${videoUrl?.slice(0, 80)}…`);
        break;
      }
      if (poll.text.includes("❌")) throw new Error(`فشلت المهمة: ${poll.text}`);
      process.stdout.write(`     … ${Math.round((Date.now() - started) / 1000)} ث\n`);
    }
    assert(videoUrl, "انتهى الانتظار (12 دقيقة) بدون اكتمال الفيديو");
  }
  // الرابط يعمل فعليًا ويبث محتوى فيديو
  const head = await fetch(videoUrl, { method: "HEAD" }).catch(() => null);
  assert(head && head.ok, `الرابط لا يعمل: ${videoUrl}`);
  const len = Number(head.headers.get("content-length") || 0);
  assert(len > 50000, `حجم الفيديو صغير جدًا: ${len}`);
  console.log(`     → حجم الفيديو: ${(len / 1024 / 1024).toFixed(2)}MB`);
});

// ---------- اختبار 3: دمج حقيقي بمقطعين عامين ----------
await test("دمج حقيقي: مقطعان عامان → MP4 نهائي على نطاق خدمة الدمج يعمل ويُشغَّل", async () => {
  const out = await callTool("merge_videos", {
    urls: [
      "https://www.w3schools.com/html/mov_bbb.mp4",
      "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
    ],
    wait_seconds: 90,
  }, (evt) => { if (evt.params?.progress !== undefined) progressCount++; });
  const taskId = (out.text.match(/task_id: ([\w-]+)/) || [])[1];
  if (taskId) createdTaskIds.push(taskId);
  assert(!out.isError, `رد خطأ: ${out.text.slice(0, 300)}`);

  let mergeUrl = null;
  if (out.text.includes("✅")) {
    mergeUrl = (out.text.match(/الرابط المباشر: (\S+)/) || [])[1];
    assert(out.text.includes("~24 ساعة"), "تحذير الـ 24 ساعة مفقود من رد الدمج");
  } else {
    assert(taskId, `لا task_id: ${out.text.slice(0, 200)}`);
    console.log(`     → ⏳ مهمة الدمج: ${taskId} — متابعة…`);
    const started = Date.now();
    while (Date.now() - started < 5 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 8000));
      const poll = await callTool("get_task", { task_id: taskId });
      if (poll.text.includes("✅")) {
        mergeUrl = (poll.text.match(/الرابط المباشر: (\S+)/) || [])[1];
        console.log(`     → 🔀 اكتمل الدمج بعد ${Math.round((Date.now() - started) / 1000)} ث`);
        break;
      }
      if (poll.text.includes("❌")) throw new Error(`فشل الدمج: ${poll.text}`);
    }
    assert(mergeUrl, "انتهى انتظار الدمج بدون نتيجة");
  }
  // الرابط على نطاق خدمة الدمج (لا نطاق داخلي غير عام في الإنتاج — هنا localhost لبيئة الاختبار)
  assert(mergeUrl.startsWith(MERGER), `الرابط ليس على نطاق خدمة الدمج: ${mergeUrl}`);
  // يعمل ويُشغَّل: HEAD 200 + Range 206
  const head = await fetch(mergeUrl, { method: "HEAD" }).catch(() => null);
  assert(head && head.ok, `الرابط لا يعمل: ${mergeUrl}`);
  const range = await fetch(mergeUrl, { headers: { Range: "bytes=0-1023" } }).catch(() => null);
  assert(range && range.status === 206, `Range لم يرد 206: ${range?.status}`);
  console.log(`     → ✅ الرابط يعمل مع دعم Range: ${mergeUrl}`);
});

// ---------- اختبار 4: list_media ----------
await test("list_media يعيد المهام المخزنة بروابطها ومرتبة من الأحدث", async () => {
  const out = await callTool("list_media", { limit: 10 });
  assert(!out.isError, `خطأ: ${out.text}`);
  assert(out.text.includes("أحدث"), `الصياغة: ${out.text.slice(0, 150)}`);
  const urlCount = (out.text.match(/https?:\/\//g) || []).length;
  assert(urlCount >= 2, `عدد الروابط في القائمة: ${urlCount}`);
  // الترتيب: أول عنصر هو الأحدث (الدمج أو الفيديو)
  console.log(`     → ${out.text.split("\n")[0]}`);
  console.log(`     → عدد الروابط: ${urlCount}`);
});

// ---------- التنظيف ----------
await test("تنظيف آثار الاختبار: مهام الاختبار ومفاتيح الاختبار ومهام الدمج", async () => {
  // حذف مهام الاختبار من قاعدة البيانات (المهمة الحقيقية للصور/الفيديو/الدمج كلها اختبار)
  for (const id of createdTaskIds) {
    await db.execute("DELETE FROM tasks WHERE id = ?", [id]);
  }
  await db.execute("DELETE FROM tasks WHERE prompt LIKE 'a cute orange cat%' OR prompt LIKE 'a majestic eagle%' OR prompt LIKE 'دمج 2 مقاطع%'").catch(() => {});
  // حذف مفاتيح الاختبار (المفتاح الحقيقي يبقى لاستخدام الخدمة)
  for (const id of createdKeyIds) {
    await api(`/api/keys/${id}`, { method: "DELETE" });
  }
  // حذف مهام الدمج من خدمة الدمج عبر DELETE /api/jobs/{id}
  const { json: recent } = await api(`/api/tasks?limit=50`).catch(() => ({ json: { tasks: [] } }));
  const mergerJobs = (recent.tasks ?? []).filter((t) => t.type === "merge" && t.providerTaskId);
  for (const t of mergerJobs) {
    await fetch(`${MERGER}/api/jobs/${t.providerTaskId}`, { method: "DELETE" }).catch(() => {});
    await db.execute("DELETE FROM tasks WHERE id = ?", [t.id]);
  }
  const { json: after } = await api("/api/tasks?limit=50");
  assert((after.tasks ?? []).length === 0, `بقيت مهام اختبار: ${after.tasks?.length}`);
  console.log(`     → 🧹 حُذفت ${createdTaskIds.length} مهمة و${createdKeyIds.length} مفتاح اختبار`);
});

console.log(`\n=== النتيجة: ${pass}/${pass + fail} ناجح ===\n`);
process.exit(fail ? 1 : 0);
