// مزود kie.ai — Jobs API الموحد (المزود الأساسي)
// ملاحظة مقاسة فعليًا: الاستجابات تعود بجسم HTTP 200 مع {code, msg, data}
// والأخطاء تظهر في code الداخلي (401/402/422/...) — يجب فحصه وليس HTTP فقط
import type {
  ProviderAdapter, CreateTaskResult, CheckTaskResult, ImageGenInput, VideoGenInput, ProviderError,
} from "../provider";
import { providerError } from "../provider";
import type { ApiKey } from "../turso";

const BASE = "https://api.kie.ai/api/v1/jobs";

interface KieEnvelope<T> {
  code: number;
  msg?: string;
  data?: T;
}

// نداء موحد يرمي ProviderError بالرمز الداخلي الصحيح
async function kieFetch<T>(path: string, key: ApiKey, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    // انقطاع شبكة/timeout → خطأ مؤقت بلا status
    throw providerError(undefined, `kie.ai unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) {
    // خطأ HTTP صريح من الطبقة الناقلة
    throw providerError(res.status, `kie.ai HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as KieEnvelope<T>;
  // الجسم دائمًا {code,msg,data} — code !== 200 يعني فشل فعلي رغم HTTP 200
  if (body.code !== 200) {
    throw providerError(body.code, body.msg || `kie.ai error code ${body.code}`);
  }
  return body.data as T;
}

// بناء input حسب نوع المهمة — نمرر فقط الحقول المدعومة ونتجاهل undefined
function buildInput(input: ImageGenInput | VideoGenInput): Record<string, unknown> {
  const out: Record<string, unknown> = { prompt: input.prompt };
  const anyInput = input as ImageGenInput & VideoGenInput;
  for (const field of [
    "aspect_ratio", "resolution", "background", "output_format",
    "image_url", "enable_audio", "duration",
  ] as const) {
    const v = anyInput[field];
    if (v !== undefined && v !== null && v !== "") out[field] = v;
  }
  return out;
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, providerModel, input): Promise<CreateTaskResult> {
    const data = await kieFetch<{ taskId: string }>("/createTask", key, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input: buildInput(input) }),
    });
    if (!data?.taskId) throw providerError(500, "kie.ai لم يعيد taskId");
    return { providerTaskId: data.taskId };
  },

  async checkTask(key, providerTaskId): Promise<CheckTaskResult> {
    interface KieRecord {
      state: string;
      resultJson?: string;
      failMsg?: string;
      failCode?: string;
      progress?: number;
    }
    const data = await kieFetch<KieRecord>(`/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, key);
    const state = data?.state ?? "waiting";
    if (state === "success") {
      // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثانيًا (الشكل الرسمي)
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(data.resultJson || "{}");
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls.filter(Boolean) : [];
      } catch {
        throw providerError(500, "تعذر تحليل resultJson من kie.ai");
      }
      if (!urls.length) throw providerError(500, "نجحت المهمة لكن بدون روابط نتائج");
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: data.failMsg || data.failCode || "فشل المزود بدون تفاصيل" };
    }
    // تقدم تقديري إن لم يوفره المزود: waiting 5 / queuing 15 / generating 45
    const progress = typeof data.progress === "number" && data.progress > 0
      ? Math.min(data.progress, 99)
      : state === "generating" ? 45 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};

// ملاحظة توثيقية: إذا تغيّر شكل الاستجابة لاحقًا فاتبع docs.kie.ai الرسمي — لا تُخترع حقولًا
export type { ProviderError };
