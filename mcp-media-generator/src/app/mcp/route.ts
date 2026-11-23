// خادم MCP — مسار /mcp (Streamable HTTP حسب مواصفة MCP)
// SDK الرسمي: McpServer + WebStandardStreamableHTTPServerTransport (يدعم SSE و JSON مباشرة)
// وضع stateless (sessionIdGenerator: undefined) — الأنسب لبيئة Vercel serverless:
// كل طلب مستقل، لا جلسات عالقة بين النسخ الباردة، وكل العملاء الكبار يدعمونه.
import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, NoKeysError, ParamsError } from "@/lib/coordinator";
import { runMerge, refreshMergeTask, MergeConfigError } from "@/lib/merger";
import { listRecentTasks, getTask } from "@/lib/turso";
import { formatTask, formatTaskList } from "@/lib/format";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

// إرشادات السيرفر تُرسل مع initialize — تخبر النموذج كيف يعمل
const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ============== معالجات الأدوات ==============

// بث إشعارات التقدم أثناء نافذة الانتظار (إذا زوّد العميل الطلب بـ _meta.progressToken)
type ExtraWithProgress = {
  sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
  _meta?: { progressToken?: string | number };
};

function makeProgressSender(extra: ExtraWithProgress) {
  const token = extra._meta?.progressToken;
  return (progress: number, message: string) => {
    if (token === undefined || !extra.sendNotification) return;
    void extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      })
      .catch(() => {});
  };
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

async function handleGenerateImage(args: Record<string, unknown>, extra: ExtraWithProgress) {
  const task = await runGeneration({
    type: "image",
    model: args.model as string | undefined,
    prompt: String(args.prompt ?? ""),
    params: {
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
      background: args.background,
      output_format: args.output_format,
    },
    waitSeconds: Number(args.wait_seconds ?? 90),
    onProgress: makeProgressSender(extra),
  });
  return textResult(formatTask(task), task.status === "failed");
}

async function handleGenerateVideo(args: Record<string, unknown>, extra: ExtraWithProgress) {
  const task = await runGeneration({
    type: "video",
    model: args.model as string | undefined,
    prompt: String(args.prompt ?? ""),
    params: {
      image_url: args.image_url,
      aspect_ratio: args.aspect_ratio,
      resolution: args.resolution,
      enable_audio: args.enable_audio,
      duration: args.duration,
    },
    waitSeconds: Number(args.wait_seconds ?? 25),
    onProgress: makeProgressSender(extra),
  });
  return textResult(formatTask(task), task.status === "failed");
}

async function handleMergeVideos(args: Record<string, unknown>, extra: ExtraWithProgress) {
  const task = await runMerge({
    urls: (args.urls as string[] | undefined)?.map(String),
    taskIds: (args.task_ids as string[] | undefined)?.map(String),
    waitSeconds: Number(args.wait_seconds ?? 60),
    onProgress: makeProgressSender(extra),
  });
  return textResult(formatTask(task), task.status === "failed");
}

async function handleGetTask(args: Record<string, unknown>) {
  const taskId = String(args.task_id ?? "").trim();
  if (!taskId) return textResult("❌ أرسل task_id للمهمة.", true);
  let task = await getTask(taskId);
  if (!task) {
    return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${taskId}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`, true);
  }
  // المهمة الجارية تُحدَّث حية من المزود/خدمة الدمج قبل إرجاع الصياغة
  task = (await refreshTask(taskId)) ?? task;
  if (task.type === "merge" && task.status !== "completed" && task.status !== "failed") {
    task = await refreshMergeTask(task);
  }
  return textResult(formatTask(task), task.status === "failed");
}

async function handleListMedia(args: Record<string, unknown>) {
  const tasks = await listRecentTasks(Number(args.limit ?? 10), {
    type: args.type as string | undefined,
    status: args.status as string | undefined,
  });
  return textResult(formatTaskList(tasks));
}

// ============== تسجيل الأدوات الخمس ==============

// المخططات مطابقة للبرومبت حرفيًا (merge بدون resolution/fps وبحد 10)
const toolDefs = {
  generate_image: {
    description:
      "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). Returns the finished image URL if it completes within the wait window; otherwise returns a task_id — call get_task every ~10 seconds until completed, then show the URL and stop.",
    schema: z.object({
      prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
      model: z
        .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
        .default("gpt-image-2-6/flare-text-to-image"),
      aspect_ratio: z
        .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
        .default("auto"),
      resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
      background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      wait_seconds: z.number().int().min(0).max(240).default(90),
    }),
    handler: handleGenerateImage,
  },
  generate_video: {
    description:
      "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). Video takes minutes: short wait with live progress, then a task_id — track it with get_task every ~10 seconds.",
    schema: z.object({
      prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
      image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
      model: z
        .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
        .default("grok-imagine-video-1-5-preview"),
      aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
      enable_audio: z.boolean().default(true),
      duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
      wait_seconds: z.number().int().min(0).max(240).default(25),
    }),
    handler: handleGenerateVideo,
  },
  merge_videos: {
    description:
      "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — like generate_video results) or 'task_ids' (COMPLETED video tasks — their result URLs are resolved from the database in this order; ideal after generating several clips). Usually fast: short wait with live progress, then a merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    schema: z.object({
      urls: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
      task_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
      wait_seconds: z.number().int().min(0).max(240).default(60),
    }),
    handler: handleMergeVideos,
  },
  get_task: {
    description:
      "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live state from the provider/merging service while still processing). Poll every ~10 seconds; when completed you will find the result URLs — show them to the user and stop polling.",
    schema: z.object({ task_id: z.string() }),
    handler: (args: Record<string, unknown>) => handleGetTask(args),
  },
  list_media: {
    description:
      "Latest stored images/videos/merges with their URLs from the database (no regeneration) — recall previous results.",
    schema: z.object({
      type: z.enum(["image", "video", "merge"]).optional(),
      status: z.enum(["completed", "failed", "processing"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    }),
    handler: (args: Record<string, unknown>) => handleListMedia(args),
  },
} as const;

// بناء سيرفر جديد لكل طلب (وضع stateless — أنسب للـ serverless)
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // تسجيل الأدوات لتظهر في tools/list بمخططاتها الكاملة
  for (const [name, def] of Object.entries(toolDefs)) {
    server.registerTool(name, { description: def.description, inputSchema: def.schema }, async () => {
      // لا يُستدعى هذا المسار فعليًا لأننا نستبدل معالج tools/call أدناه — لكنه مطلوب للتسجيل
      return textResult("غير مستخدم");
    });
  }

  // معالج tools/call مخصص: أداة مجهولة → رسالة عربية، ومعالجة أخطاء صامتة تمامًا
  // (لا يخرج للعميل أي ذكر لمفاتيح أو رصيد أبدًا)
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const def = toolDefs[name as keyof typeof toolDefs];
    if (!def) {
      return textResult(
        `❌ أداة غير معروفة: ${name}. المتاح: ${Object.keys(toolDefs).join(", ")}`,
        true
      );
    }
    const parsed = def.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `- ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      return textResult(`❌ معطيات غير صالحة للأداة ${name}:\n${issues}`, true);
    }
    try {
      return await def.handler(parsed.data as Record<string, unknown>, extra as ExtraWithProgress);
    } catch (e) {
      if (e instanceof NoKeysError) {
        return textResult(`❌ ${e.message}`, true);
      }
      if (e instanceof ParamsError || e instanceof MergeConfigError) {
        return textResult(e.message, true);
      }
      // أي خطأ آخر: رسالة عامة آمنة — ولا تُذكر أسرار أو مفاتيح
      return textResult("❌ حدث خطأ داخلي غير متوقع أثناء المعالجة. أعد المحاولة لاحقًا.", true);
    }
  });

  return server;
}

// ============== نقطة النداء ==============

// حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>
function authorized(req: NextRequest): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

async function handleMcpRequest(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: مطلوب Authorization Bearer token" }, id: null },
      { status: 401 }
    );
  }
  // وضع stateless: نقل مستقل لكل طلب — لا جلسات على الخادم
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer();
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(req as unknown as Request);
    return new NextResponse(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (e) {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: `خطأ في المعالجة: ${(e as Error).message}` }, id: null },
      { status: 400 }
    );
  }
}

export async function POST(req: NextRequest) {
  return handleMcpRequest(req);
}

// DELETE لإنهاء الجلسة (لا جلسات في وضع stateless — يرد 200 عبر النقل)
export async function DELETE(req: NextRequest) {
  return handleMcpRequest(req);
}

// GET: SSE مستقل — يمرر للنقل (يرد 405 إن لم يكن مدعومًا)
export async function GET(req: NextRequest) {
  return handleMcpRequest(req);
}
