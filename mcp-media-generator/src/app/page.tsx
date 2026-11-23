"use client";

// لوحة الإدارة العربية — ثلاث بطاقات: مدير المفاتيح، لوحة المهام، ربط السيرفر
import { useCallback, useEffect, useRef, useState } from "react";

// ============== الأنواع ==============
interface KeyRow {
  id: string; provider: string; label: string; masked: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number; successCount: number; failCount: number;
  lastUsedAt: string | null; lastCheckedAt: string | null; lastError: string | null;
  createdAt: string;
}
interface TaskAttemptLite { provider: string; keyLabel: string; ok: boolean; errorClass?: string; at: string; }
interface TaskRow {
  id: string; provider: string | null; model: string; type: "image" | "video" | "merge";
  status: "pending" | "processing" | "completed" | "failed";
  progress: number; prompt: string; resultUrls: string[];
  errorMessage: string | null; attemptsCount: number; attempts: TaskAttemptLite[];
  createdAt: string;
}
interface Health {
  ok: boolean; database: string; mcpEndpoint: string; authRequired: boolean;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string; healthy: boolean };
}

// ============== المساعدات ==============
const STATUS_LABEL: Record<string, string> = {
  active: "نشط", exhausted: "مستنزف", disabled: "معطّل",
  completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "بانتظار",
};
const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  exhausted: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  disabled: "bg-zinc-500/15 text-zinc-400 border-zinc-500/40",
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  failed: "bg-red-500/15 text-red-300 border-red-500/40",
  processing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  pending: "bg-violet-500/15 text-violet-300 border-violet-500/40",
};
const TYPE_LABEL: Record<string, string> = { image: "🖼️ صورة", video: "🎬 فيديو", merge: "🔀 دمج" };

function Badge({ s }: { s: string }) {
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-bold ${STATUS_STYLE[s] ?? ""}`}>
      {STATUS_LABEL[s] ?? s}
    </span>
  );
}

function timeAgo(iso: string): string {
  const d = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  if (!Number.isFinite(d)) return iso;
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return `قبل ${s} ثانية`;
  if (s < 3600) return `قبل ${Math.floor(s / 60)} دقيقة`;
  if (s < 86400) return `قبل ${Math.floor(s / 3600)} ساعة`;
  return `قبل ${Math.floor(s / 86400)} يوم`;
}

const TOOLS_INFO = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي — تعيد الرابط أو task_id للتابع بـ get_task" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن — يتبع بـ get_task كل ~10 ثوانٍ" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب — urls أو task_ids" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها — توليد أو دمج — وتحديثها حيًا" },
  { name: "list_media", desc: "أحدث الوسائط المخزنة بروابطها من قاعدة البيانات" },
];

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  // نموذج إضافة مفتاح
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // تبويب الربط
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);
  const mcpUrlRef = useRef<HTMLInputElement>(null);

  const refreshKeys = useCallback(async () => {
    try {
      const r = await fetch("/api/keys");
      const j = await r.json();
      setKeys(j.keys ?? []);
    } catch { /* تجاهل مؤقت */ }
  }, []);

  const refreshTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20");
      const j = await r.json();
      setTasks(j.tasks ?? []);
      setStats(j.stats ?? stats);
    } catch { /* تجاهل مؤقت */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    refreshKeys();
    refreshTasks();
    // لوحة المهام تتحدث تلقائيًا كل ~5 ثوانٍ
    const t = setInterval(refreshTasks, 5000);
    return () => clearInterval(t);
  }, [refreshKeys, refreshTasks]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyMsg(null);
    const r = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, api_key: apiKey, label }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      setKeyMsg({ ok: true, text: "✅ أُضيف المفتاح — سيُجرَّب أولًا في الترتيب التسلسلي" });
      setApiKey(""); setLabel("");
      refreshKeys();
    } else {
      setKeyMsg({ ok: false, text: `❌ ${j.error ?? "فشل الإضافة"}` });
    }
  }

  async function toggleKey(k: KeyRow) {
    const to = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: to }),
    });
    refreshKeys();
  }

  async function deleteKey(k: KeyRow) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    refreshKeys();
  }

  function copy(text: string, tag: string) {
    navigator.clipboard.writeText(text);
    setCopied(tag);
    setTimeout(() => setCopied(null), 1500);
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "https://<your-domain>";
  const mcpUrl = `${origin}/mcp`;
  const authHeaders = health?.authRequired
    ? {
        Authorization: "Bearer <MCP_ACCESS_TOKEN>",
      }
    : undefined;

  const snippets: Record<typeof tab, string> = {
    chatgpt: JSON.stringify(
      { mcpServers: { "media-generator": { url: mcpUrl, ...(authHeaders ? { headers: authHeaders } : {}) } } },
      null, 2
    ),
    claude: JSON.stringify(
      { mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...(authHeaders ? { headers: authHeaders } : {}) } } },
      null, 2
    ),
    cursor: JSON.stringify(
      { mcpServers: { "media-generator": { url: mcpUrl, ...(authHeaders ? { headers: authHeaders } : {}) } } },
      null, 2
    ),
  };
  const tabHint: Record<typeof tab, string> = {
    chatgpt: "في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».",
    claude: "ضع الكود في ملف claude_desktop_config.json ثم أعد تشغيل Claude Desktop.",
    cursor: "ضع الكود في mcp.json داخل إعدادات Cursor / Windsurf / Cline ثم أعد التشغيل.",
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 text-zinc-100" style={{ background: "transparent" }}>
      {/* الهيدر مع حالة الصحة */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold bg-gradient-to-l from-cyan-400 to-violet-400 bg-clip-text text-transparent">
            ⚡ خادم توليد الوسائط — MCP
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            صور · فيديو بصوت متزامن · دمج المقاطع — مع تبديل تسلسلي تلقائي للمفاتيح
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {health ? (
            <>
              <span className={`rounded-full border px-3 py-1 font-bold ${health.ok ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "border-red-500/40 bg-red-500/15 text-red-300"}`}>
                {health.ok ? "● Turso متصل" : "● غير متصل"}
              </span>
              <span className={`rounded-full border px-3 py-1 font-bold ${health.merger?.healthy ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "border-amber-500/40 bg-amber-500/15 text-amber-300"}`}>
                {health.merger?.healthy ? "● الدمج جاهز" : "● الدمج غير متاح"}
              </span>
              {health.authRequired && (
                <span className="rounded-full border border-violet-500/40 bg-violet-500/15 px-3 py-1 text-violet-300">🔒 محمي بـ Token</span>
              )}
            </>
          ) : (
            <span className="text-zinc-500">جارٍ فحص الحالة…</span>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* أ) مدير المفاتيح */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 shadow-xl">
          <h2 className="mb-3 text-lg font-bold">🔑 مدير المفاتيح</h2>
          <p className="mb-4 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs leading-relaxed text-cyan-200">
            أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي
            عند أي خطأ أو نفاد رصيد دون توقف.
          </p>
          <form onSubmit={addKey} className="mb-4 flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              المزود
              <select
                value={provider} onChange={(e) => setProvider(e.target.value)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
              >
                <option value="kie">kie.ai</option>
                <option value="cometapi">CometAPI</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              تسمية (اختياري)
              <input
                value={label} onChange={(e) => setLabel(e.target.value)}
                placeholder="مثال: الحساب الرئيسي"
                className="w-40 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              المفتاح
              <input
                value={apiKey} onChange={(e) => setApiKey(e.target.value)} required
                placeholder="الصق مفتاح API كاملًا — يُقنَّع فورًا بعد الحفظ"
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm" dir="ltr"
              />
            </label>
            <button type="submit" className="rounded-lg bg-gradient-to-l from-cyan-500 to-violet-500 px-4 py-2 text-sm font-bold text-zinc-950 hover:opacity-90">
              إضافة
            </button>
          </form>
          {keyMsg && (
            <p className={`mb-3 rounded-lg px-3 py-2 text-xs ${keyMsg.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"}`}>
              {keyMsg.text}
            </p>
          )}
          <div className="space-y-2">
            {keys.length === 0 && <p className="text-sm text-zinc-500">لا توجد مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.</p>}
            {keys.map((k, i) => (
              <div key={k.id} className="rounded-xl border border-zinc-800 bg-zinc-800/60 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-zinc-950 px-2 py-0.5 font-mono text-xs" dir="ltr">#{i + 1} · {k.masked}</span>
                  <Badge s={k.status} />
                  <span className="text-xs text-zinc-400">
                    {k.provider === "kie" ? "kie.ai" : "CometAPI"}{k.label ? ` · ${k.label}` : ""}
                  </span>
                  <span className="mr-auto flex gap-1">
                    <button onClick={() => toggleKey(k)} className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:border-cyan-400 hover:text-cyan-300">
                      {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                    </button>
                    <button onClick={() => deleteKey(k)} className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:border-red-400 hover:text-red-300">
                      حذف
                    </button>
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-400">
                  <span>استخدام: {k.usageCount}</span>
                  <span className="text-emerald-400">نجاح: {k.successCount}</span>
                  <span className="text-red-400">فشل: {k.failCount}</span>
                  {k.lastUsedAt && <span>آخر استخدام: {timeAgo(k.lastUsedAt)}</span>}
                </div>
                {k.lastError && (
                  <p className="mt-1 truncate text-xs text-amber-400/80" title={k.lastError}>آخر خطأ: {k.lastError}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* ج) ربط السيرفر */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 shadow-xl">
          <h2 className="mb-3 text-lg font-bold">🔌 ربط السيرفر</h2>
          <div className="mb-3 flex gap-2">
            <input
              ref={mcpUrlRef} readOnly value={mcpUrl} dir="ltr"
              className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 font-mono text-sm"
            />
            <button onClick={() => copy(mcpUrl, "url")} className="rounded-lg border border-zinc-700 px-3 py-2 text-sm hover:border-cyan-400">
              {copied === "url" ? "✓ نُسخ" : "نسخ"}
            </button>
          </div>
          <div className="mb-2 flex gap-1 text-sm">
            {([["chatgpt", "ChatGPT / GPT Agents"], ["claude", "Claude Desktop"], ["cursor", "Cursor / Windsurf / Cline"]] as const).map(([id, t]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`rounded-lg px-3 py-1.5 ${tab === id ? "bg-cyan-500/20 font-bold text-cyan-300" : "text-zinc-400 hover:text-zinc-200"}`}>
                {t}
              </button>
            ))}
          </div>
          <pre dir="ltr" className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-3 text-xs leading-relaxed text-cyan-200">
{snippets[tab]}
          </pre>
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-400">{tabHint[tab]}</p>
            <button onClick={() => copy(snippets[tab], "json")} className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:border-cyan-400">
              {copied === "json" ? "✓ نُسخ" : "نسخ JSON"}
            </button>
          </div>
          <div className="mt-4">
            <p className="mb-2 text-xs font-bold text-zinc-300">الأدوات الخمس المتاحة عبر السيرفر:</p>
            <div className="flex flex-wrap gap-2">
              {TOOLS_INFO.map((t) => (
                <span key={t.name} title={t.desc}
                  className="cursor-help rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-xs text-violet-200">
                  <code className="font-mono">{t.name}</code>
                </span>
              ))}
            </div>
            <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-zinc-500">
              {TOOLS_INFO.map((t) => (
                <li key={t.name}><code className="font-mono text-zinc-400">{t.name}</code> — {t.desc}</li>
              ))}
            </ul>
          </div>
          <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-200">
            ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
            اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
            حتى لا تنقطع العملية.
          </p>
        </section>

        {/* ب) لوحة المهام — بعرض كامل تحت البطاقتين */}
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 shadow-xl lg:col-span-2">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-bold">📋 لوحة المهام</h2>
            <span className="text-xs text-zinc-500">تتحدث تلقائيًا كل 5 ثوانٍ</span>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {([["إجمالي", stats.total, "text-zinc-100"], ["مكتملة", stats.completed, "text-emerald-300"],
              ["فاشلة", stats.failed, "text-red-300"], ["جارية", stats.processing, "text-cyan-300"]] as const).map(([t, v, c]) => (
              <div key={t} className="rounded-xl border border-zinc-800 bg-zinc-800/60 p-3 text-center">
                <div className={`text-2xl font-extrabold ${c}`}>{v}</div>
                <div className="text-xs text-zinc-400">{t}</div>
              </div>
            ))}
          </div>
          <div className="space-y-2">
            {tasks.length === 0 && (
              <p className="text-sm text-zinc-500">
                لا مهام بعد — استدعِ generate_image أو generate_video من عميل MCP وستظهر هنا حيًا.
              </p>
            )}
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-800/60 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span>{TYPE_LABEL[t.type]}</span>
                  <Badge s={t.status} />
                  <code className="rounded bg-zinc-950 px-2 py-0.5 font-mono text-xs text-zinc-300" dir="ltr">{t.model}</code>
                  <span className="text-xs text-zinc-500">{timeAgo(t.createdAt)}</span>
                  {t.attemptsCount > 1 && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">🔄 محاولات: {t.attemptsCount}</span>
                  )}
                  <span className="mr-auto flex flex-wrap gap-1">
                    {t.resultUrls.map((u, i) => (
                      <a key={i} href={u} target="_blank" rel="noreferrer"
                        className="rounded-md border border-cyan-500/50 px-2 py-1 text-xs text-cyan-300 hover:bg-cyan-500/10">
                        فتح الرابط {t.resultUrls.length > 1 ? i + 1 : ""} ↗
                      </a>
                    ))}
                  </span>
                </div>
                {t.prompt && <p className="mt-1 truncate text-xs text-zinc-400" title={t.prompt}>✍️ {t.prompt}</p>}
                {t.status === "processing" && (
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-950">
                    <div className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-400 transition-all"
                      style={{ width: `${Math.max(t.progress, 3)}%` }} />
                  </div>
                )}
                {t.status === "failed" && t.errorMessage && (
                  <p className="mt-1 text-xs text-red-400">❌ {t.errorMessage}</p>
                )}
                {t.attemptsCount > 1 && (
                  <details className="mt-1 text-xs text-zinc-500">
                    <summary className="cursor-pointer">تفاصيل المحاولات</summary>
                    <ul className="mt-1 space-y-0.5">
                      {t.attempts.map((a, i) => (
                        <li key={i}>
                          {a.ok ? "✅" : "⚠️"} {a.provider} · {a.keyLabel}
                          {a.errorClass ? ` · ${a.errorClass}` : ""} · {timeAgo(a.at)}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="mt-8 text-center text-xs text-zinc-600">
        خادم MCP لتوليد الوسائط — يعمل عبر {mcpUrl} — روابط النتائج فقط تُخزَّن، لا ملفات وسائط على السيرفر.
      </footer>
    </main>
  );
}
