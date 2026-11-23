// عميل خدمة دمج الفيديو — Video Merger API v2
// بلا مفاتيح أو توثيق. المخرجات MP4 (H.264+AAC) حتى 1080p — لا توجد معاملات resolution/fps.
// قواعد حتمية: أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل نهائي فوري؛
// أخطاء شبكتنا نحن (timeout/fetch) = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة.
import { randomUUID } from "crypto";
import {
  getTask, insertTask, updateTask, listRecentTasks,
  type Task,
} from "./turso";

export const MERGER_BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").replace(/\/$/, "");

// قفل في الذاكرة حتى لا يتزامن تنفيذ /process مع استعلامات get_task (مرة واحدة فقط)
const processInFlight = new Set<string>();

export class MergeConfigError extends Error {} // أخطاء تحقق الدمج (أقل من 2 أو أكثر من 10)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// نداء دفاعي موحد — يميز بين أخطاء الخدمة المعلنة (نهائية) وأخطاء شبكتنا (مؤقتة)
async function mergerFetch(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null; networkError?: boolean }> {
  try {
    const res = await fetch(`${MERGER_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(init?.method === "POST" && path.endsWith("/process") ? 300_000 : 30_000),
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
  } catch {
    // انقطاع شبكتنا — مؤقت: استمر بالاستعلام حتى انتهاء النافذة
    return { status: 0, body: null, networkError: true };
  }
}

// تحليل الحالة الدفاعي (قسم 7.2) — أكمل/فشل بأشكال متعددة، والprogress كسرًا 0..1
function parseStatus(body: Record<string, unknown> | null): {
  state: "queued" | "processing" | "done" | "failed";
  progress: number;
  error?: string;
  videoUrl?: string;
  downloadUrl?: string;
} {
  if (!body) return { state: "processing", progress: 0 };
  // انتبه: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
  const err = typeof body.error === "string" ? body.error : undefined;
  const raw = String(body.status ?? "").toLowerCase();
  const statusMissing = !body.status;
  const isDone = /done|completed|complete|success|succeeded|finished/.test(raw);
  const isFailed = /error|failed|failure|cancelled|canceled/.test(raw) || (statusMissing && !!err);
  let progress = Number(body.progress ?? 0);
  if (progress > 0 && progress <= 1) progress = progress * 100; // كسر 0..1 → ×100
  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا فاضبط من jobId في refreshMergeTask
  const videoUrl = typeof body.videoUrl === "string" ? body.videoUrl : undefined;
  const downloadUrl = typeof body.downloadUrl === "string" ? body.downloadUrl : undefined;
  if (isDone) return { state: "done", progress: 100, videoUrl, downloadUrl };
  if (isFailed) return { state: "failed", progress, error: err || "فشل الدمج في الخدمة" };
  return { state: raw === "queued" || statusMissing ? "queued" : "processing", progress, error: err };
}

// حل روابط task_ids لمهام فيديو مكتملة بالترتيب — مع تفاصيل كل معرّف فاشل
async function resolveTaskUrls(taskIds: string[]): Promise<{ urls: string[]; details: string[] }> {
  const urls: string[] = [];
  const details: string[] = [];
  for (const id of taskIds) {
    const t = await getTask(id.trim());
    if (!t) {
      details.push(`«${id}»: مهمة غير موجودة`);
      continue;
    }
    if (t.type !== "video") {
      details.push(`«${id}»: النوع ${t.type} وليس فيديو`);
      continue;
    }
    if (t.status !== "completed" || !t.resultUrls.length) {
      details.push(`«${id}»: الحالة ${t.status} بدون روابط — أكملها أولًا بـ get_task`);
      continue;
    }
    urls.push(...t.resultUrls);
  }
  return { urls, details };
}

export interface MergeRequest {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: (percent: number, message: string) => void;
}

// تدفق runMerge — يرجع المهمة (مكتملة خلال النافذة أو processing)
export async function runMerge(req: MergeRequest): Promise<Task> {
  // 1) تحقق صارم: بعد جمع الروابط يجب أن تكون ≥2 وكلها http/https مباشرة وعامة
  const resolved = req.taskIds?.length ? await resolveTaskUrls(req.taskIds) : { urls: [], details: [] };
  const combined = [...resolved.urls, ...(req.urls ?? [])];
  if (combined.length < 2) {
    let msg = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (resolved.details.length) {
      msg += "\n\nتفاصيل المعرّفات:\n" + resolved.details.map((d) => `- ${d}`).join("\n");
    }
    throw new MergeConfigError(msg);
  }
  if (combined.length > 10) {
    throw new MergeConfigError("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const bad = combined.find((u) => !/^https?:\/\//i.test(u));
  if (bad) {
    throw new MergeConfigError(`❌ رابط غير صالح (يجب أن يكون http/https مباشرًا وعامًا): ${bad.slice(0, 80)}`);
  }

  // 2) سجل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${combined.length} مقاطع`,
    params: { urls: combined, task_ids: req.taskIds ?? [] },
    status: "processing",
  });

  // 3) POST /api/jobs ثم أطلق خلفيًا وبمرة واحدة فقط POST .../process
  const create = await mergerFetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ videos: combined }),
  });
  if (create.networkError) {
    // شبكتنا → المهمة تبقى processing وget_task يكملها (سيبدأ process هناك)
    await updateTask(taskId, { errorMessage: "تعذر الوصول لخدمة الدمج مؤقتًا — ستُستكمل تلقائيًا" });
    return (await getTask(taskId))!;
  }
  if (create.status >= 400 || !create.body?.jobId) {
    // خطأ معلن من الخدمة = فشل حتمي فوري — لا إعادة محاولة
    const msg = String(create.body?.error ?? `HTTP ${create.status}`);
    await updateTask(taskId, { status: "failed", errorMessage: `فشل إنشاء مهمة الدمج: ${msg}`.slice(0, 400) });
    return (await getTask(taskId))!;
  }
  const jobId = String(create.body.jobId);
  await updateTask(taskId, { provider: "merger", providerTaskId: jobId, progress: 5 });

  // إطلاق process خلفيًا وبمرة واحدة فقط (محمي بقفل في الذاكرة)
  void fireProcess(jobId);

  // 4) حتى نهاية نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث تقدم وكتابة فورية في Turso
  const started = Date.now();
  while (Date.now() - started < req.waitSeconds * 1000) {
    await sleep(3000);
    const st = await queryMergeJob(jobId);
    if (st.state === "done") {
      const url = st.videoUrl || st.downloadUrl || `${MERGER_BASE}/api/jobs/${jobId}/video`;
      await updateTask(taskId, {
        status: "completed", progress: 100, resultUrls: [url], providerTaskId: jobId,
      });
      req.onProgress?.(100, "اكتمل الدمج ✓");
      return (await getTask(taskId))!;
    }
    if (st.state === "failed") {
      // خطأ معلن → فشل نهائي فوري
      await updateTask(taskId, { status: "failed", errorMessage: (st.error ?? "فشل الدمج").slice(0, 400) });
      return (await getTask(taskId))!;
    }
    const progress = Math.max(5, Math.min(Math.round(st.progress) || 0, 99));
    await updateTask(taskId, { progress, providerTaskId: jobId });
    req.onProgress?.(progress, `جارٍ الدمج… ${progress}%`);
  }
  // انتهت النافذة → processing والعميل يتابع بـ get_task
  return (await getTask(taskId))!;
}

// إطلاق POST /process مرة واحدة فقط لكل مهمة
async function fireProcess(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" });
    // النتيجة تُلتقط في حلقة الاستعلام — لا حاجة لمعالجة الاستجابة هنا
  } finally {
    processInFlight.delete(jobId);
  }
}

// استعلام GET /api/jobs/{id} مع تحليل دفاعي
async function queryMergeJob(jobId: string): Promise<ReturnType<typeof parseStatus>> {
  const r = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (r.networkError) return { state: "processing", progress: 0 }; // شبكتنا → مؤقت
  if (r.status === 404) {
    return { state: "failed", progress: 0, error: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  if (r.status >= 400) {
    const err = String(r.body?.error ?? `HTTP ${r.status}`);
    return { state: "failed", progress: 0, error: err };
  }
  return parseStatus(r.body);
}

// تحديث مهمة دمج جارية من الخدمة — يُستدعى من get_task (refreshMergeTask)
export async function refreshMergeTask(task: Task): Promise<Task> {
  if (task.status === "completed" || task.status === "failed") return task;
  if (!task.providerTaskId) {
    // الإنشاء لم يكتمل (انقطاع شبكة عند الإنشاء) — أعده الآن
    const params = task.params as { urls?: string[] };
    if (!params?.urls?.length) {
      await updateTask(task.id, { status: "failed", errorMessage: "معطيات الدمج مفقودة" });
      return (await getTask(task.id))!;
    }
    const create = await mergerFetch("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ videos: params.urls }),
    });
    if (!create.networkError && create.body?.jobId) {
      await updateTask(task.id, { provider: "merger", providerTaskId: String(create.body.jobId) });
      void fireProcess(String(create.body.jobId));
    }
    return (await getTask(task.id))!;
  }

  const st = await queryMergeJob(task.providerTaskId);
  if (st.state === "done") {
    const url = st.videoUrl || st.downloadUrl || `${MERGER_BASE}/api/jobs/${task.providerTaskId}/video`;
    await updateTask(task.id, { status: "completed", progress: 100, resultUrls: [url] });
  } else if (st.state === "failed") {
    await updateTask(task.id, { status: "failed", errorMessage: (st.error ?? "فشل الدمج").slice(0, 400) });
  } else {
    // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يحمي من التزامن)
    if (st.state === "processing" || st.state === "queued") {
      void fireProcess(task.providerTaskId);
    }
    const progress = Math.max(task.progress, Math.min(Math.round(st.progress) || 0, 99));
    if (progress !== task.progress) await updateTask(task.id, { progress });
  }
  return (await getTask(task.id))!;
}

// فحص جهوزية الخدمة لمسار /api/health — بمهلة 4 ثوانٍ
export async function mergerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

// حذف مهمة دمج من الخدمة (تنظيف اختياري — يُستخدم بعد الاختبارات)
export async function deleteMergerJob(jobId: string): Promise<boolean> {
  try {
    const res = await fetch(`${MERGER_BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// أحدث المهام المخزنة (تُستخدم مع list_media)
export { listRecentTasks };
