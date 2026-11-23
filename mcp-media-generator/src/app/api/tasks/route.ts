// GET /api/tasks — بيانات لوحة المهام (إحصائيات + أحدث المهام، تتحدث كل ~5 ثوانٍ من الواجهة)
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || undefined;
  const status = searchParams.get("status") || undefined;
  const limit = Math.min(Math.max(parseInt(searchParams.get("limit") ?? "20", 10) || 20, 1), 50);

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(limit, { type, status }),
  ]);

  return NextResponse.json({
    stats,
    tasks: tasks.map((t) => ({
      id: t.id,
      provider: t.provider,
      keyLabel: t.keyId ? maskKey(t.keyId) : null, // أي أثر لمفتاح يظهر مقنّعًا فقط
      model: t.model,
      type: t.type,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt.slice(0, 120),
      resultUrls: t.resultUrls,
      errorMessage: t.errorMessage,
      attemptsCount: t.attempts.length,
      attempts: t.attempts.map((a) => ({
        provider: a.provider,
        keyLabel: a.keyLabel,
        ok: a.ok,
        errorClass: a.errorClass,
        at: a.at,
      })),
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
}
