// إدارة المفاتيح — GET القائمة (مقنّعة دائمًا) و POST إضافة مع رفض التكرار
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listKeys, insertKey, findDuplicateKey } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// القائمة كاملة مع إخفاء المفاتيح دائمًا — لا يُعاد المفتاح الكامل في أي استجابة
export async function GET() {
  const keys = await listKeys();
  return NextResponse.json({
    keys: keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      masked: maskKey(k.apiKey),
      status: k.status,
      usageCount: k.usageCount,
      successCount: k.successCount,
      failCount: k.failCount,
      lastUsedAt: k.lastUsedAt,
      lastCheckedAt: k.lastCheckedAt,
      lastError: k.lastError,
      createdAt: k.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }
  const provider = String(body.provider ?? "").toLowerCase();
  const apiKey = String(body.api_key ?? "").trim();
  if (provider !== "kie" && provider !== "cometapi") {
    return NextResponse.json({ error: "المزود يجب أن يكون kie أو cometapi" }, { status: 400 });
  }
  if (!apiKey || apiKey.length < 8) {
    return NextResponse.json({ error: "أرسل مفتاح API صالحًا (8 أحرف على الأقل)" }, { status: 400 });
  }
  // رفض التكرار لنفس المزود — ولا يخزَّن المفتاح نفسه مرتين
  if (await findDuplicateKey(provider, apiKey)) {
    return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
  }
  const id = randomUUID();
  await insertKey({ id, provider, label: String(body.label ?? "").slice(0, 100), apiKey });
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
