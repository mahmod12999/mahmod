// سجل الموديلات — الأسماء القياسية والصيغ البديلة وأسماء كل مزود
// قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL, COMETAPI_VIDEO_MODEL, ...)
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMETAPI_IMAGE },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMETAPI_VIDEO },
  },
];

// توحيد اسم الموديل عبر الاسم القياسي والأسماء البديلة — غير معروف → null (خطأ معطيات)
export function normalizeModelName(name?: string): ModelDef | null {
  if (!name) return MODELS[0]; // الافتراضي: موديل الصور
  const n = name.trim().toLowerCase();
  return (
    MODELS.find(
      (m) => m.canonical.toLowerCase() === n || m.aliases.some((a) => a.toLowerCase() === n)
    ) ?? null
  );
}

export function modelForType(type: MediaType): ModelDef {
  return MODELS.find((m) => m.type === type)!;
}
