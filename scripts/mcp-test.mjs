// اختبار MCP عبر Streamable HTTP — initialize / tools/list / tools/call
// التشغيل: node scripts/mcp-test.mjs [BASE=http://localhost:3000]
const BASE = process.argv[2] || "http://localhost:3000";

// نداء JSON-RPC عبر SSE — يقرأ الدفق ويعيد أول نتيجة مطابقة للمعرّف
async function mcpCall(id, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text();
  // الاستجابة SSE: أسطر "data: {...}" — استخرج أول JSON يطابق id
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const msg = JSON.parse(line.slice(5).trim());
      if (msg.id === id) return msg;
      if (msg.result && !msg.id) continue; // إشعار
    } catch { /* سطر غير JSON */ }
  }
  throw new Error(`لا استجابة للمعرّف ${id}: ${text.slice(0, 300)}`);
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || "التأكيد فشل"); }

console.log(`\n=== اختبار MCP على ${BASE}/mcp ===\n`);

await test("initialize يرد بـ serverInfo الصحيح وinstructions", async () => {
  const r = await mcpCall(1, "initialize", {
    protocolVersion: "2025-03-26", capabilities: {},
    clientInfo: { name: "curl-test", version: "1.0" },
  });
  assert(r.result?.serverInfo?.name === "media-generator-mcp", `serverInfo ${JSON.stringify(r.result?.serverInfo)}`);
  assert(r.result?.serverInfo?.version === "1.2.0", "الإصدار ليس 1.2.0");
  assert((r.result?.instructions || "").includes("automatically switches API keys"), "instructions مفقودة");
});

await test("notifications/initialized يقبل بـ 202", async () => {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert(res.status === 202 || res.status === 200, `الحالة ${res.status}`);
});

let tools = [];
await test("tools/list يعرض الأدوات الخمس بمخططات صحيحة", async () => {
  const r = await mcpCall(2, "tools/list", {});
  tools = r.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  assert(names.length === 5, `عدد الأدوات ${names.length}: ${names}`);
  for (const n of ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"]) {
    assert(names.includes(n), `الأداة ${n} مفقودة`);
  }
  // merge_videos: بدون resolution/fps وبحد 10 وminItems 2
  const merge = tools.find((t) => t.name === "merge_videos");
  const props = merge.inputSchema?.properties ?? {};
  assert(!props.resolution && !props.fps, "merge_videos لا يجب أن يحتوي resolution/fps");
  assert(props.urls?.maxItems === 10 && props.urls?.minItems === 2, "حدود urls يجب أن تكون 2..10");
  assert(props.task_ids?.maxItems === 10, "حدود task_ids يجب أن تكون 10");
  // وصف الدمج يتضمن التحذير الحرفي
  assert((merge.description || "").includes("~24 hours"), "التحذير اللفظي للدمج مفقود من الوصف");
  // generate_image schema
  const gi = tools.find((t) => t.name === "generate_image");
  const giProps = gi.inputSchema?.properties ?? {};
  assert(giProps.aspect_ratio?.enum?.length === 16, "aspect_ratio للصورة يجب أن يكون 16 خيارًا");
  assert(giProps.resolution?.enum?.join() === "1K,2K,4K", "دقة الصورة غير صحيحة");
  assert(giProps.wait_seconds?.default === 90, "wait_seconds الافتراضي للصورة 90");
  // generate_video schema
  const gv = tools.find((t) => t.name === "generate_video");
  const gvProps = gv.inputSchema?.properties ?? {};
  assert(gvProps.duration?.maximum === 15 && gvProps.duration?.minimum === 1, "مدة الفيديو 1..15");
  assert(gvProps.resolution?.enum?.join() === "480p,720p,1080p", "دقة الفيديو غير صحيحة");
  assert(gvProps.wait_seconds?.default === 25, "wait_seconds الافتراضي للفيديو 25");
  // get_task/list_media
  assert(tools.find((t) => t.name === "get_task").inputSchema?.required?.includes("task_id"), "get_task يتطلب task_id");
  const lm = tools.find((t) => t.name === "list_media");
  assert(lm.inputSchema?.properties?.limit?.maximum === 50, "حد list_media 50");
});

await test("tools/call list_media يعيد صياغة عربية", async () => {
  const r = await mcpCall(3, "tools/call", { name: "list_media", arguments: { limit: 5 } });
  const text = r.result?.content?.[0]?.text ?? "";
  assert(!r.result?.isError, `isError: ${text.slice(0, 200)}`);
  assert(/[\u0600-\u06FF]/.test(text), `ليست عربية: ${text.slice(0, 200)}`);
  console.log(`     → ${text.split("\n")[0].slice(0, 80)}`);
});

await test("tools/call get_task بمعرّف غير موجود → خطأ عربي isError", async () => {
  const r = await mcpCall(4, "tools/call", { name: "get_task", arguments: { task_id: "no_such_task" } });
  const text = r.result?.content?.[0]?.text ?? "";
  assert(r.result?.isError === true, "يجب أن يكون isError");
  assert(text.includes("لا توجد مهمة"), `الرسالة: ${text}`);
});

await test("أداة مجهولة → رسالة عربية بأسماء المتاح", async () => {
  const r = await mcpCall(5, "tools/call", { name: "unknown_tool", arguments: {} });
  const text = r.result?.content?.[0]?.text ?? "";
  assert(r.result?.isError === true, "يجب أن يكون isError");
  assert(text.includes("أداة غير معروفة") && text.includes("generate_image"), `الرسالة: ${text}`);
});

await test("merge_videos بـ task_ids غير صالحة → رفض عربي «مقطعَين على الأقل» مع تفاصيل كل معرّف", async () => {
  const r = await mcpCall(6, "tools/call", {
    name: "merge_videos",
    arguments: { task_ids: ["bogus_task_1", "bogus_task_2"], wait_seconds: 0 },
  });
  const text = r.result?.content?.[0]?.text ?? "";
  assert(r.result?.isError === true, "يجب أن يكون isError");
  assert(text.includes("مقطعَين على الأقل"), `الرسالة: ${text.slice(0, 300)}`);
  assert(text.includes("bogus_task_1") && text.includes("تفاصيل المعرّفات"), `التفاصيل: ${text.slice(0, 300)}`);
});

await test("merge_videos بـ urls خارج الحدود → رفض عربي (حد المخطط 2..10)", async () => {
  const r1 = await mcpCall(7, "tools/call", {
    name: "merge_videos",
    arguments: { urls: Array.from({ length: 11 }, (_, i) => `https://example.com/v${i}.mp4`), wait_seconds: 0 },
  });
  const t1 = r1.result?.content?.[0]?.text ?? "";
  assert(r1.result?.isError === true, "يجب أن يكون isError");
  assert(/أقصى عدد مقاطع|معطيات غير صالحة/.test(t1), `الرسالة: ${t1.slice(0, 200)}`);
});

await test("DELETE على /mcp يرد دون خطأ", async () => {
  const res = await fetch(`${BASE}/mcp`, { method: "DELETE" });
  assert(res.status < 500, `الحالة ${res.status}`);
});

console.log(`\n=== النتيجة: ${pass}/${pass + fail} ناجح ===\n`);
process.exit(fail ? 1 : 0);
