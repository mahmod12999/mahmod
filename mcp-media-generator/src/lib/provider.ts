// واجهة المزودات الموحدة + تصنيف الأخطاء (قلب سياسة التبديل)
import type { ApiKey } from "./turso";

export interface ProviderError extends Error {
  status?: number; // HTTP أو رمز داخلي من المزود
  message: string;
}

export function providerError(status: number | undefined, message: string): ProviderError {
  const e = new Error(message) as ProviderError;
  if (status !== undefined) e.status = status;
  return e;
}

export interface CreateTaskResult {
  providerTaskId: string;
}

export interface CheckTaskResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

export interface ImageGenInput {
  prompt: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
}

export interface VideoGenInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  enable_audio?: boolean;
  duration?: number;
}

export interface ProviderAdapter {
  id: string;
  // مهمة غير متزامنة (فيديو، وبعض الصور): تعيد providerTaskId
  createTask(key: ApiKey, providerModel: string, input: ImageGenInput | VideoGenInput): Promise<CreateTaskResult>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: ApiKey, providerModel: string, input: ImageGenInput): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: ApiKey, providerTaskId: string): Promise<CheckTaskResult>;
}

// ============== تصنيف الأخطاء الموحد ==============

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

// أنماط رسائل مشكلات المفتاح/الرصيد — تُفحص قبل فئة 400 لأن بعض المزودين
// يرسلون نفاد الرصيد بحالة 400 أو بجسم HTTP 200 وكود داخلي
const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|arrearage|欠费|رصيد/i;
const AUTH_RE = /invalid api key|unauthorized|forbidden|authentication|api key|token/i;

// الفئات والإجراء:
// disabled → المفتاح مرفوض → علّمه disabled تلقائيًا → انتقل للمفتاح التالي
// exhausted → علّم المفتاح exhausted (يبقى في القاعدة) → انتقل للتالي
// provider  → الموديل غير مدعوم لدى هذا المزود → انتقل للتالي
// params    → توقف فورًا — تبديل المفاتيح لن يحل خطأ معطيات
// temporary → 429/5xx/شبكة → انتقل للتالي الآن والمفتاح يبقى سليمًا
export function classifyProviderError(err: ProviderError): ErrorClass {
  const msg = err.message || "";
  const status = err.status;

  // 1) مشكلات المصادقة: 401/403 أو رسالة واضحة
  if (status === 401 || status === 403 || AUTH_RE.test(msg)) return "disabled";

  // 2) نفاد الرصيد قبل 400 — قد يأتي بحالة 400 أو 402 أو رسالة نصية
  if (status === 402 || EXHAUSTED_RE.test(msg)) return "exhausted";

  // 3) موديل غير مدعوم
  if (/model not found|unsupported model|invalid model|unknown model/i.test(msg) &&
      (status === 400 || status === 404 || status === 422 || status === undefined)) {
    return "provider";
  }

  // 4) معطيات الطلب
  if (status === 400 || status === 422) return "params";

  // 5) مؤقت: 429 أو 5xx أو انقطاع شبكة (بلا status)
  if (status === 429 || (status !== undefined && status >= 500) || status === undefined) {
    return "temporary";
  }

  // أي شيء آخر يُعامل مؤقتًا (نتقل للمفتاح التالي دون تعليم المفتاح)
  return "temporary";
}

// هل رسالة فشل منتصف المهمة تطابق نمط مشكلات مفتاح/رصيد؟ (قسم 4.3.2)
export function isKeyOrBalanceMessage(msg: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|充值|欠费/i.test(msg || "");
}
