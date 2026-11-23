// مزود CometAPI — مزود ثانٍ
// الصور: نقطة متوافقة مع OpenAI تعيد النتيجة فورًا (متزامنة).
// الفيديو: نقطة مهام غير متزامنة بنمط create/check وفق توثيق api.cometapi.com الحالي.
// المزود يعيد أخطاء على شكل OpenAI {"error":{"message","type","code"}}
import type {
  ProviderAdapter, CreateTaskResult, CheckTaskResult, ImageGenInput, VideoGenInput, ProviderError,
} from "../provider";
import { providerError } from "../provider";
import type { ApiKey } from "../turso";

const BASE = "https://api.cometapi.com";

// استخراج رسالة الخطأ من أشكال الاستجابة المتعددة الممكنة
function extractError(body: unknown, httpStatus: number): ProviderError {
  const b = body as { error?: { message?: string }; message?: string; msg?: string };
  const msg =
    b?.error?.message || b?.message || b?.msg || `CometAPI HTTP ${httpStatus}`;
  // رمز داخلي إن وجد (نفس أولوية جدول التصنيف)
  const codeStr = (b?.error as { code?: string | number } | undefined)?.code;
  const code = typeof codeStr === "string" && /^\d+$/.test(codeStr) ? Number(codeStr) : httpStatus;
  return providerError(code, msg);
}

async function cometFetch<T>(url: string, key: ApiKey, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw providerError(undefined, `CometAPI unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw extractError(body, res.status);
  // بعض النقاط تعيد 200 مع جسم خطأ
  const b = body as { error?: { message?: string } } | null;
  if (b?.error?.message) throw extractError(body, res.status);
  return body as T;
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  // صور متزامنة — OpenAI-compatible /v1/images/generations تعيد الرابط فورًا
  async createImageSync(key, providerModel, input: ImageGenInput) {
    interface ImagesResponse {
      data?: Array<{ url?: string; b64_json?: string }>;
    }
    const body = await cometFetch<ImagesResponse>(
      `${BASE}/v1/images/generations`,
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          ...(input.aspect_ratio && input.aspect_ratio !== "auto"
            ? { size: input.aspect_ratio }
            : {}),
          ...(input.output_format ? { response_format: "url" } : {}),
        }),
      }
    );
    const urls = (body.data ?? [])
      .map((d) => d.url)
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    if (!urls.length) throw providerError(500, "CometAPI لم يعيد روابط صور");
    return { urls };
  },

  // فيديو غير متزامن — POST /v1/videos يعيد معرّف مهمة نستعلمه بحالة
  async createTask(key, providerModel, input: ImageGenInput | VideoGenInput): Promise<CreateTaskResult> {
    const v = input as VideoGenInput;
    const body = await cometFetch<{ id?: string; task_id?: string; taskId?: string }>(
      `${BASE}/v1/videos`,
      key,
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          prompt: v.prompt,
          ...(v.image_url ? { image_url: v.image_url } : {}),
          ...(v.duration ? { seconds: String(v.duration) } : {}),
          ...(v.aspect_ratio && v.aspect_ratio !== "auto" ? { aspect_ratio: v.aspect_ratio } : {}),
        }),
      }
    );
    const id = body?.id ?? body?.task_id ?? body?.taskId;
    if (!id) throw providerError(500, "CometAPI لم يعيد معرّف المهمة");
    return { providerTaskId: String(id) };
  },

  // GET /v1/videos/{id} → {status: queued|processing|succeeded|failed, video_url|download_url|result}
  async checkTask(key, providerTaskId): Promise<CheckTaskResult> {
    const body = await cometFetch<Record<string, unknown>>(
      `${BASE}/v1/videos/${encodeURIComponent(providerTaskId)}`,
      key
    );
    const status = String(body?.status ?? "processing").toLowerCase();
    const isDone = ["succeeded", "success", "completed", "done"].includes(status);
    const isFailed = ["failed", "error", "cancelled", "canceled"].includes(status);
    if (isDone) {
      // أشكال روابط محتملة: video_url / download_url / result.video_url / data[0].url
      const b = body as {
        video_url?: string; download_url?: string;
        result?: { video_url?: string; download_url?: string };
        data?: Array<{ url?: string }>;
      };
      const urls = [
        b.video_url, b.download_url,
        b.result?.video_url, b.result?.download_url,
        ...(b.data?.map((d) => d.url) ?? []),
      ].filter((u): u is string => typeof u === "string" && u.length > 0);
      if (!urls.length) throw providerError(500, "نجحت مهمة CometAPI بدون روابط");
      return { status: "completed", urls, progress: 100 };
    }
    if (isFailed) {
      const b = body as { error?: { message?: string }; failure_reason?: string };
      return { status: "failed", error: b?.error?.message || b?.failure_reason || "فشل المزود" };
    }
    return { status: "processing", progress: 40 };
  },
};
