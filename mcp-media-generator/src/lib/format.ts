// صياغة الردود العربية لأدوات MCP — كل رسائل الأدوات بالعربية
// (المصطلحات التقنية وأسماء الأدوات تبقى بالإنجليزية)
import type { Task } from "./turso";

// مهمة مكتملة صورة: ✅ ثم ![image](<الرابط>) ثم الرابط المباشر
export function formatCompleted(task: Task): string {
  if (task.type === "image") {
    const url = task.resultUrls[0];
    return [
      "✅ تم توليد الصورة بنجاح",
      "",
      `![image](<${url}>)`,
      "",
      `الرابط المباشر: ${url}`,
    ].join("\n");
  }
  const urls = task.resultUrls.map((u) => `- ${u}`).join("\n");
  if (task.type === "merge") {
    return [
      "✅ تم دمج المقاطع بنجاح",
      "",
      urls,
      "",
      "الرابط المباشر: " + (task.resultUrls[0] ?? ""),
      "",
      "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.",
    ].join("\n");
  }
  return ["✅ تم توليد الفيديو بنجاح", "", urls, "", "الرابط المباشر: " + (task.resultUrls[0] ?? "")].join("\n");
}

// مهمة جارية: task_id + تعليمات المتابعة (بلا أي ذكر لمفاتيح أو رصيد أبدًا)
export function formatProcessing(task: Task): string {
  return [
    `⏳ المهمة قيد المعالجة — task_id: ${task.id}`,
    "",
    "تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.",
  ].join("\n");
}

// مهمة فاشلة: السبب فقط — لا يخرج أي ذكر لمفاتيح أو رصيد للعميل أبدًا
export function formatFailed(task: Task): string {
  return `❌ فشلت المهمة: ${task.errorMessage ?? "سبب غير معروف"}`;
}

// صياغة أي مهمة حسب حالتها
export function formatTask(task: Task): string {
  if (task.status === "completed") return formatCompleted(task);
  if (task.status === "failed") return formatFailed(task);
  return formatProcessing(task);
}

// قائمة list_media — أحدث أولًا مع الروابط
export function formatTaskList(tasks: Task[]): string {
  if (!tasks.length) {
    return "📭 لا توجد مهام مخزنة مطابقة لهذا الفلتر بعد — استخدم generate_image أو generate_video أولًا.";
  }
  const lines = tasks.map((t, i) => {
    const kind = t.type === "image" ? "🖼️ صورة" : t.type === "video" ? "🎬 فيديو" : "🔀 دمج";
    const head = `${i + 1}. ${kind} — ${t.status === "completed" ? "✅ مكتملة" : t.status === "failed" ? "❌ فاشلة" : "⏳ جارية"} — task_id: ${t.id}`;
    const meta = `   الموديل: ${t.model} · أُنشئت: ${t.createdAt}`;
    const urls = t.status === "completed" && t.resultUrls.length
      ? "\n   الروابط:\n" + t.resultUrls.map((u) => `   - ${u}`).join("\n")
      : t.status === "failed" && t.errorMessage
        ? `\n   السبب: ${t.errorMessage}`
        : "";
    return head + "\n" + meta + urls;
  });
  return `📚 أحدث ${tasks.length} مهمة مخزنة:\n\n${lines.join("\n")}`;
}
