// PATCH تعطيل/تنشيط يدوي — DELETE حذف مفتاح
import { NextRequest, NextResponse } from "next/server";
import { getKey, setKeyStatus, deleteKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "جسم الطلب ليس JSON صالحًا" }, { status: 400 });
  }
  const status = String(body.status ?? "");
  if (status !== "active" && status !== "disabled") {
    return NextResponse.json({ error: "status يجب أن يكون active أو disabled" }, { status: 400 });
  }
  const key = await getKey(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await setKeyStatus(id, status);
  return NextResponse.json({ ok: true, id, status });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const key = await getKey(id);
  if (!key) return NextResponse.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await deleteKey(id);
  return NextResponse.json({ ok: true, deleted: id });
}
