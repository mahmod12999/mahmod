// GET /api/health — حالة السيرفر والقاعدة والمزودين وخدمة الدمج
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { MERGER_BASE, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const healthy = await dbHealthy();
  const merger = await mergerHealthy();
  return NextResponse.json({
    ok: healthy,
    database: healthy ? "turso-connected" : "turso-unreachable",
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: {
      base: MERGER_BASE,
      healthy: merger,
    },
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  });
}
