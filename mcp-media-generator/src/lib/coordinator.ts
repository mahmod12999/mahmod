// منسّق التوليد — قلب المشروع:
// 1) تسجيل المهمة في Turso قبل أي نداء خارجي.
// 2) تجربة المفاتيح بالترتيب التسلسلي الصارم (أول مفتاح أُضيف أولًا).
// 3) تبديل صامت عند أي خطأ مفتاح/رصيد — نفس المهمة بنفس task_id على المفتاح التالي.
// 4) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
// 5) فشل الإنشاء على كل المفاتيح → المهمة تبقى processing وتُعاد مع كل get_task (تهدئة ~45 ثانية).
import { randomUUID } from "crypto";
import {
  getKeyPool, insertTask, getTask, updateTask, recordKeyResult, getKey,
  type ApiKey, type Task, type TaskAttempt,
} from "./turso";
import { normalizeModelName, type ModelDef } from "./models";
import {
  classifyProviderError, isKeyOrBalanceMessage, providerError,
  type ProviderAdapter, type ProviderError,
} from "./provider";
import { kieAdapter } from "./providers/kie";
import { cometapiAdapter } from "./providers/cometapi";

const adapters: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

// رسالة داخلية تُخزَّن في القاعدة عند فشل كل المفاتيح — لا تخرج للعميل كإخفاق
const WAITING_FOR_KEY = "بانتظار توفر مفتاح صالح…";
const COOLDOWN_MS = 45_000; // تهدئة بين محاولات إعادة الإنشاء عبر get_task

// أخطاء معطيات → فشل فوري (التبديل لن يحلها) — وأخطاء لا مفاتيح → رد واضح
export class ParamsError extends Error {}
export class NoKeysError extends Error {}

export interface GenerationRequest {
  type: "image" | "video";
  model?: string;
  prompt: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  onProgress?: (percent: number, message: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// تسجيل محاولة في المهمة + تحديث عدّادات المفتاح دائمًا
async function logAttempt(
  taskId: string,
  key: ApiKey,
  ok: boolean,
  errorClass?: string,
  error?: string
): Promise<void> {
  const attempt: TaskAttempt = {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label || key.provider,
    ok,
    ...(errorClass ? { errorClass } : {}),
    ...(error ? { error: String(error).slice(0, 300) } : {}),
    at: new Date().toISOString(),
  };
  await recordKeyResult(key.id, ok, {
    errorClass,
    error,
    // التعليم التلقائي: disabled → تعطيل، exhausted → استنزاف (يبقى في القاعدة)
    markStatus: errorClass === "disabled" ? "disabled" : errorClass === "exhausted" ? "exhausted" : undefined,
  });
  await updateTask(taskId, {}, attempt);
}

// بناء input المزود من معطيات الأداة + الموديل المعياري
function buildProviderInput(req: GenerationRequest, modelDef: ModelDef): Record<string, unknown> {
  const base: Record<string, unknown> = { prompt: req.prompt };
  for (const [k, v] of Object.entries(req.params)) {
    // نتجاهل model و wait_seconds — ليست حقول مزود
    if (k === "model" || k === "wait_seconds") continue;
    if (v !== undefined && v !== null) base[k] = v;
  }
  // موديل الصور الافتراضي عند عدم التمرير
  base.model = modelDef.canonical;
  delete base.model; // الموديل يُرسل في الحقل الأعلى من createTask وليس داخل input
  return base;
}

// تجربة المرشحين بالترتيب بدءًا من startIndex حتى أول نجاح
// تعيد فهرس المفتاح الناجح، أو null عند فشل الجميع (المهمة تبقى processing)
async function createOnPool(
  taskId: string,
  modelDef: ModelDef,
  req: GenerationRequest,
  pool: ApiKey[],
  startIndex: number
): Promise<number | null> {
  for (let i = Math.max(0, startIndex); i < pool.length; i++) {
    const key = pool[i];
    const adapter = adapters[key.provider];
    if (!adapter) continue;
    const providerModel = modelDef.providerModel[key.provider as keyof typeof modelDef.providerModel]
      ?? modelDef.canonical;
    try {
      // المدخل للمزود = الوصف النصي + حقول الأداة (الـ prompt يمرر هنا دائمًا)
      const providerInput = { prompt: req.prompt, ...req.params } as never;
      // صور CometAPI متزامنة: النتيجة فورًا — المهمة تكتمل مباشرة
      if (req.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key, providerModel, providerInput);
        await recordKeyResult(key.id, true);
        await updateTask(taskId, {
          provider: key.provider,
          keyId: key.id,
          status: "completed",
          progress: 100,
          resultUrls: urls,
        }, {
          provider: key.provider, keyId: key.id, keyLabel: key.label || key.provider,
          ok: true, at: new Date().toISOString(),
        });
        return i;
      }
      const { providerTaskId } = await adapter.createTask(key, providerModel, providerInput);
      await recordKeyResult(key.id, true);
      await updateTask(taskId, {
        provider: key.provider,
        providerTaskId,
        keyId: key.id,
        status: "processing",
        progress: 5,
      }, {
        provider: key.provider, keyId: key.id, keyLabel: key.label || key.provider,
        ok: true, at: new Date().toISOString(),
      });
      return i;
    } catch (e) {
      const pe = e as ProviderError;
      const cls = classifyProviderError(pe);
      await logAttempt(taskId, key, false, cls, pe.message);
      if (cls === "params") {
        // توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات (رسالة آمنة بلا ذكر مفاتيح)
        const safeMsg = `رفض المزود معطيات الطلب: ${pe.message.slice(0, 200)}`;
        await updateTask(taskId, {
          status: "failed",
          errorMessage: safeMsg,
        });
        throw new ParamsError(safeMsg);
      }
      // disabled / exhausted / provider / temporary → الانتقال للمفتاح التالي بصمت
      continue;
    }
  }
  return null;
}

// نافذة الانتظار: استعلام كل 3 ثوانٍ مع بث التقدم وتبديل فوري عند فشل منتصف المهمة
async function waitWindow(
  taskId: string,
  req: GenerationRequest,
  startKeyIndex: number
): Promise<Task> {
  const started = Date.now();
  let keyIndex = startKeyIndex;
  while (Date.now() - started < req.waitSeconds * 1000) {
    await sleep(3000);
    let task = await getTask(taskId);
    if (!task || task.status === "completed" || task.status === "failed") return task!;
    if (!task.provider || !task.providerTaskId) break;

    const adapter = adapters[task.provider];
    if (!adapter) break;
    // جلب المفتاح الحالي للمهمة للاستعلام — إن حُذف نعيد الإنشاء من أول المجموعة
    const key = task.keyId ? await getKey(task.keyId) : null;
    if (!key) {
      keyIndex = (await failoverToNextKey(taskId, -1)) ?? -1;
      if (keyIndex < 0) break;
      continue;
    }
    let check;
    try {
      check = await adapter.checkTask(key, task.providerTaskId);
    } catch (err) {
      const pe = err as ProviderError;
      // مفتاح مات أثناء الاستعلام → تبديل فوري بنفس task_id
      const cls = classifyProviderError(pe);
      if (cls === "disabled" || cls === "exhausted") {
        keyIndex = (await failoverToNextKey(taskId, keyIndex)) ?? keyIndex;
        if (keyIndex < 0) break; // لا مفتاح متبقٍ
        continue;
      }
      // temporary → استمر بالاستعلام حتى انتهاء النافذة
      continue;
    }
    if (check.status === "completed" && check.urls?.length) {
      await updateTask(taskId, {
        status: "completed", progress: 100, resultUrls: check.urls,
      });
      req.onProgress?.(100, "اكتمل التوليد ✓");
      return (await getTask(taskId))!;
    }
    if (check.status === "failed") {
      const msg = check.error ?? "";
      if (isKeyOrBalanceMessage(msg)) {
        // فشل منتصف المهمة بنمط مفتاح/رصيد → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي
        keyIndex = (await failoverToNextKey(taskId, keyIndex)) ?? -1;
        if (keyIndex < 0) break; // كل المفاتيح فشلت → تبقى processing
        continue;
      }
      // فشل حقيقي (سياسة/معطيات) → failed نهائي
      await updateTask(taskId, { status: "failed", errorMessage: msg.slice(0, 400) });
      return (await getTask(taskId))!;
    }
    const progress = Math.max(task.progress, Math.min(check.progress ?? 0, 99));
    await updateTask(taskId, { progress });
    req.onProgress?.(progress, `قيد التوليد… ${progress}%`);
  }
  // انتهت النافذة والنتيجة لم تظهر → تعاد processing والعميل يتابع بـ get_task
  return (await getTask(taskId))!;
}

// إعادة إنشاء نفس المهمة على المفتاح التالي (نفس task_id) — تعيد فهرس المفتاح الجديد
async function failoverToNextKey(taskId: string, currentIndex: number): Promise<number | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  const modelDef = normalizeModelName(task.model);
  if (!modelDef) return null;
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) return null;
  const req: GenerationRequest = {
    type: modelDef.type === "image" ? "image" : "video",
    prompt: task.prompt,
    params: { ...task.params, model: modelDef.canonical },
    waitSeconds: 0,
  };
  // نجرب من المفتاح التالي بعد الفاشل — والفاشل أصبح disabled/exhausted فتُستثنى تلقائيًا
  const result = await createOnPool(taskId, modelDef, req, pool, currentIndex + 1);
  return result;
}

// نقطة الدخول لأدوات generate_image / generate_video
export async function runGeneration(req: GenerationRequest): Promise<Task> {
  const modelDef = normalizeModelName(req.model);
  if (!modelDef) {
    throw new ParamsError(`موديل غير معروف: ${req.model}. المتاح: ${"gpt-image-2-6/flare-text-to-image"} أو ${"grok-imagine-video-1-5-preview"}`);
  }
  if (modelDef.type !== req.type) {
    throw new ParamsError(`الموديل ${modelDef.canonical} من نوع ${modelDef.type} وليس ${req.type}`);
  }
  const pool = await getKeyPool(modelDef.providers);
  if (!pool.length) {
    throw new NoKeysError(
      `لا توجد مفاتيح نشطة لخدمة ${modelDef.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`
    );
  }
  // سجل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع
  const taskId = randomUUID();
  const { model: _m, wait_seconds: _w, ...rest } = req.params;
  await insertTask({
    id: taskId,
    model: modelDef.canonical,
    type: req.type,
    prompt: req.prompt,
    params: { ...rest, model: modelDef.canonical },
    status: "pending",
  });

  const created = await createOnPool(taskId, modelDef, req, pool, 0);
  if (created === null) {
    // فشل الإنشاء على كل المفاتيح → المهمة تبقى processing (ليست failed)
    // برسالة داخلية «بانتظار توفر مفتاح صالح…» وتُعاد المحاولة مع كل get_task
    await updateTask(taskId, { status: "processing", provider: null, providerTaskId: null, errorMessage: WAITING_FOR_KEY });
    return (await getTask(taskId))!;
  }
  const task = (await getTask(taskId))!;
  if (task.status === "completed") return task; // صور متزامنة
  req.onProgress?.(5, "قيد التوليد… 5%");
  return waitWindow(taskId, req, created);
}

// تحديث المهمة الجارية من المزود — يُستدعى من أداة get_task
// مع نفس منطق إعادة المحاولة/التبديل، ثم تُرجَع المهمة المحدثة
export async function refreshTask(taskId: string): Promise<Task | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;
  if (task.type === "merge") {
    // مهام الدمج لها مسار تحديث خاص (refreshMergeTask)
    return task;
  }

  const modelDef = normalizeModelName(task.model);
  if (!modelDef) return task;

  if (!task.provider || !task.providerTaskId) {
    // الإنشاء لم ينجح سابقًا — أعده مع كل استدعاء get_task بعد تهدئة ~45 ثانية
    const lastAt = task.attempts.length ? Date.parse(task.attempts[task.attempts.length - 1].at) : 0;
    if (Date.now() - lastAt < COOLDOWN_MS) return task;
    const pool = await getKeyPool(modelDef.providers);
    if (!pool.length) return task;
    const req: GenerationRequest = {
      type: modelDef.type === "image" ? "image" : "video",
      prompt: task.prompt,
      params: { ...task.params },
      waitSeconds: 0,
    };
    const created = await createOnPool(task.id, modelDef, req, pool, 0);
    if (created === null) {
      await updateTask(task.id, { errorMessage: WAITING_FOR_KEY });
      return (await getTask(taskId))!;
    }
    task = (await getTask(taskId))!;
    if (task.status === "completed") return task;
  }

  // تحديث حي من المزود بمفتاح المهمة الحالي
  const adapter = adapters[task.provider!];
  if (!adapter || !task.providerTaskId) return task;
  const key = task.keyId ? await getKey(task.keyId) : null;
  if (!key) {
    // المفتاح حُذف يدويًا أثناء المعالجة → إعادة إنشاء من أول المجموعة
    await failoverToNextKey(task.id, -1);
    return (await getTask(taskId))!;
  }
  let check;
  try {
    check = await adapter.checkTask(key, task.providerTaskId);
  } catch (err) {
    const pe = err as ProviderError;
    const cls = classifyProviderError(pe);
    if (cls === "disabled" || cls === "exhausted") {
      // مفتاح مات بين الاستعلامات → تبديل صامت بنفس task_id
      await failoverToNextKey(task.id, await indexOfKey(task.keyId));
    }
    return (await getTask(taskId))!;
  }

  if (check.status === "completed" && check.urls?.length) {
    await updateTask(task.id, { status: "completed", progress: 100, resultUrls: check.urls });
  } else if (check.status === "failed") {
    const msg = check.error ?? "";
    if (isKeyOrBalanceMessage(msg)) {
      await failoverToNextKey(task.id, await indexOfKey(task.keyId));
    } else {
      await updateTask(task.id, { status: "failed", errorMessage: msg.slice(0, 400) });
    }
  } else {
    const progress = Math.max(task.progress, Math.min(check.progress ?? 0, 99));
    if (progress !== task.progress) await updateTask(task.id, { progress });
  }
  return (await getTask(taskId))!;
}

// فهرس المفتاح الحالي في المجموعة (لإعادة الإنشاء من التالي)
async function indexOfKey(keyId: string | null): Promise<number> {
  if (!keyId) return -1;
  const pool = await getKeyPool(["kie", "cometapi"]);
  const idx = pool.findIndex((k) => k.id === keyId);
  return idx;
}

// مفتاح المهمة الحالي (للاستعلامات الحية)
export async function getTaskKey(task: Task): Promise<ApiKey | null> {
  if (!task.keyId) return null;
  return getKey(task.keyId);
}
