// اختبار فيديو مركزي بنافذة متابعة طويلة (توليد grok-imagine قد يستغرق حتى ~15 دقيقة)
// التشغيل: node scripts/video-e2e.mjs
import { createClient } from "../mcp-media-generator/node_modules/@libsql/client/lib-esm/node.js";
import { readFileSync } from "fs";

const BASE = process.env.BASE || "http://localhost:3000";
const envText = readFileSync(new URL("../mcp-media-generator/.env.local", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !line.includes("#")) env[m[1]] = m[2].trim();
}
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });

async function callTool(name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const msg = JSON.parse(line.slice(5).trim());
      if (msg.result?.content) return { text: msg.result.content[0].text, isError: msg.result.isError === true };
    } catch {}
  }
  throw new Error(`لا استجابة: ${text.slice(0, 200)}`);
}

console.log("=== اختبار فيديو e2e بنافذة 25 دقيقة ===");

// ضمان وجود المفتاح الحقيقي — يُقرأ من متغير البيئة E2E_REAL_KEY (لا أسرار في الكود أو Git)
const REAL_KEY = process.env.E2E_REAL_KEY || "";
{
  const r = await fetch(`${BASE}/api/keys`);
  const j = await r.json();
  const found = (j.keys ?? []).some((k) => k.masked?.startsWith(REAL_KEY.slice(0, 7)));
  if (!found) {
    if (!REAL_KEY) {
      console.log("⚠️ المفتاح غير موجود في القاعدة — مرر E2E_REAL_KEY لإضافته تلقائيًا (أو أضفه من لوحة الإدارة)");
    } else {
      const add = await fetch(`${BASE}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "kie", api_key: REAL_KEY, label: "الرئيسي-kie" }),
      });
      console.log("أُضيف المفتاح الحقيقي:", add.status);
    }
  }
}

const started = Date.now();
const first = await callTool("generate_video", {
  prompt: "a small robot watering a flower pot on a sunny windowsill, soft natural light",
  duration: 5,
  resolution: "480p",
  wait_seconds: 240,
});
const taskId = (first.text.match(/task_id: ([\w-]+)/) || [])[1];
console.log(first.text.split("\n")[0]);
if (taskId) console.log(`task_id: ${taskId}`);

let videoUrl = null;
if (first.text.includes("✅")) {
  videoUrl = (first.text.match(/الرابط المباشر: (\S+)/) || [])[1];
} else {
  if (!taskId) throw new Error(`لا task_id ولا رابط: ${first.text.slice(0, 200)}`);
  const deadline = 25 * 60 * 1000;
  while (Date.now() - started < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const poll = await callTool("get_task", { task_id: taskId });
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (poll.text.includes("✅")) {
      videoUrl = (poll.text.match(/الرابط المباشر: (\S+)/) || [])[1];
      console.log(`✅ اكتمل بعد ${elapsed} ث`);
      break;
    }
    if (poll.text.includes("❌")) throw new Error(`فشلت المهمة: ${poll.text}`);
    console.log(`… ${elapsed} ث — قيد المعالجة`);
  }
  if (!videoUrl) throw new Error("انتهت نافذة 25 دقيقة بدون اكتمال");
}
function assert(c, m) { if (!c) throw new Error(m); }

// التحقق من الرابط
const head = await fetch(videoUrl, { method: "HEAD" });
console.log(`HEAD: ${head.status} · نوع: ${head.headers.get("content-type")} · الحجم: ${((Number(head.headers.get("content-length") || 0)) / 1024 / 1024).toFixed(2)}MB`);
if (!head.ok) throw new Error(`الرابط لا يعمل: ${videoUrl}`);
const len = Number(head.headers.get("content-length") || 0);
if (len < 50000) throw new Error(`حجم الفيديو صغير جدًا: ${len}`);
console.log(`\n✅ نجاح: رابط فيديو صالح يعمل — ${videoUrl}`);

// تنظيف: حذف مهمة الاختبار من القاعدة
if (taskId) {
  await db.execute("DELETE FROM tasks WHERE id = ?", [taskId]);
  console.log("🧹 حُذفت مهمة الاختبار من قاعدة البيانات");
}
process.exit(0);
