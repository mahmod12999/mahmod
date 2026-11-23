// طبقة قاعدة البيانات — Turso عبر HTTP فقط (متوافقة مع Vercel serverless، لا ملفات SQLite محلية)
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;

export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error("TURSO_DATABASE_URL مفقود — أضفه إلى متغيرات البيئة");
    _client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
  }
  return _client;
}

let _schemaPromise: Promise<void> | null = null;

// إنشاء الجداول عند أول وصول فقط — لا حاجة لأداة migrations
export function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = getTurso()
      .batch([
        `CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )`,
        `CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
      ])
      .then(() => undefined)
      .catch((e) => {
        _schemaPromise = null;
        throw e;
      });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await getTurso().execute("SELECT 1");
    return r.rows.length === 1;
  } catch {
    return false;
  }
}

// ============== الأنواع ==============

export interface TaskAttempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface Task {
  id: string;
  provider: string | null;
  providerTaskId: string | null;
  keyId: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params: Record<string, unknown>;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: TaskAttempt[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ApiKey {
  id: string;
  provider: string;
  label: string;
  apiKey: string;
  status: "active" | "exhausted" | "disabled";
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

function mapTask(row: Record<string, unknown>): Task {
  const parse = (v: unknown, def: unknown) => {
    if (v == null || v === "") return def;
    try {
      return JSON.parse(String(v));
    } catch {
      return def;
    }
  };
  return {
    id: String(row.id),
    provider: row.provider != null ? String(row.provider) : null,
    providerTaskId: row.provider_task_id != null ? String(row.provider_task_id) : null,
    keyId: row.key_id != null ? String(row.key_id) : null,
    model: String(row.model ?? ""),
    type: String(row.type ?? "image") as Task["type"],
    prompt: String(row.prompt ?? ""),
    params: parse(row.params_json, {}),
    status: String(row.status ?? "pending") as Task["status"],
    progress: Number(row.progress ?? 0),
    resultUrls: parse(row.result_urls_json, []) as string[],
    errorMessage: row.error_message != null ? String(row.error_message) : null,
    attempts: parse(row.attempts_json, []) as TaskAttempt[],
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    completedAt: row.completed_at != null ? String(row.completed_at) : null,
  };
}

function mapKey(row: Record<string, unknown>): ApiKey {
  return {
    id: String(row.id),
    provider: String(row.provider),
    label: String(row.label ?? ""),
    apiKey: String(row.api_key),
    status: String(row.status ?? "active") as ApiKey["status"],
    usageCount: Number(row.usage_count ?? 0),
    successCount: Number(row.success_count ?? 0),
    failCount: Number(row.fail_count ?? 0),
    lastUsedAt: row.last_used_at != null ? String(row.last_used_at) : null,
    lastCheckedAt: row.last_checked_at != null ? String(row.last_checked_at) : null,
    lastError: row.last_error != null ? String(row.last_error) : null,
    createdAt: String(row.created_at ?? ""),
  };
}

// ============== عمليات المهام ==============

export async function insertTask(task: {
  id: string;
  model: string;
  type: Task["type"];
  prompt?: string;
  params?: Record<string, unknown>;
  status?: Task["status"];
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, model, type, prompt, params_json, status, progress) VALUES (?, ?, ?, ?, ?, ?, 0)`,
    args: [
      task.id,
      task.model,
      task.type,
      task.prompt ?? "",
      JSON.stringify(task.params ?? {}),
      task.status ?? "pending",
    ],
  });
}

export async function getTask(taskId: string): Promise<Task | null> {
  await ensureSchema();
  const r = await getTurso().execute("SELECT * FROM tasks WHERE id = ?", [taskId]);
  if (!r.rows.length) return null;
  return mapTask(r.rows[0] as unknown as Record<string, unknown>);
}

// تحديث جزئي: يضيف attempts ويضبط updated_at و completed_at تلقائيًا عند الاكتمال
export async function updateTask(
  taskId: string,
  patch: Partial<{
    provider: string | null;
    providerTaskId: string | null;
    keyId: string | null;
    status: Task["status"];
    progress: number;
    resultUrls: string[];
    errorMessage: string | null;
  }>,
  attempt?: TaskAttempt
): Promise<void> {
  const sets: string[] = ["updated_at = datetime('now')"];
  const args: InValue[] = [];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.providerTaskId !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.providerTaskId); }
  if (patch.keyId !== undefined) { sets.push("key_id = ?"); args.push(patch.keyId); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.resultUrls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.resultUrls)); }
  if (patch.errorMessage !== undefined) { sets.push("error_message = ?"); args.push(patch.errorMessage); }
  if (patch.status === "completed") { sets.push("completed_at = datetime('now')"); sets.push("progress = 100"); }
  if (attempt) {
    sets.push("attempts_json = COALESCE(attempts_json, '[]')");
    // نقرأ الحالي ونضيف السجل الجديد (استعلامان لضمان صحة JSON)
    const cur = await getTurso().execute("SELECT attempts_json FROM tasks WHERE id = ?", [taskId]);
    let list: TaskAttempt[] = [];
    try { list = JSON.parse(String(cur.rows[0]?.attempts_json ?? "[]")); } catch { list = []; }
    list.push(attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(list));
  }
  args.push(taskId);
  await getTurso().execute(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args);
}

export async function listRecentTasks(
  limit = 10,
  filter?: { type?: string; status?: string }
): Promise<Task[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filter?.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter?.status) { where.push("status = ?"); args.push(filter.status); }
  args.push(limit);
  const r = await getTurso().execute(
    `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
    args
  );
  return r.rows.map((row) => mapTask(row as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{
  total: number; completed: number; failed: number; processing: number;
}> {
  await ensureSchema();
  const r = await getTurso().execute(
    `SELECT
       count(*) AS total,
       sum(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       sum(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = r.rows[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}

// ============== عمليات المفاتيح ==============

export async function insertKey(k: {
  id: string;
  provider: string;
  label?: string;
  apiKey: string;
}): Promise<void> {
  await ensureSchema();
  await getTurso().execute(
    `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    [k.id, k.provider, k.label ?? "", k.apiKey]
  );
}

export async function listKeys(): Promise<ApiKey[]> {
  await ensureSchema();
  // الترتيب التسلسلي الصارم: أول مفتاح أُضيف يُجرَّب أولًا — ليس round-robin
  const r = await getTurso().execute(
    "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
  );
  return r.rows.map((row) => mapKey(row as unknown as Record<string, unknown>));
}

// مجموعة المفاتيح المرشحة لهذه المزودات بالترتيب التسلسلي الصارم (الإضافة أولًا)
// المفتاح المستنزف يبقى في القائمة — الاستثناء الوحيد هو التعطيل اليدوي
export async function getKeyPool(providers: string[]): Promise<ApiKey[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const r = await getTurso().execute(
    `SELECT * FROM api_keys
     WHERE status != 'disabled' AND provider IN (${placeholders})
     ORDER BY created_at ASC, id ASC`,
    providers
  );
  return r.rows.map((row) => mapKey(row as unknown as Record<string, unknown>));
}

export async function getKey(keyId: string): Promise<ApiKey | null> {
  await ensureSchema();
  const r = await getTurso().execute("SELECT * FROM api_keys WHERE id = ?", [keyId]);
  if (!r.rows.length) return null;
  return mapKey(r.rows[0] as unknown as Record<string, unknown>);
}

export async function setKeyStatus(keyId: string, status: ApiKey["status"]): Promise<void> {
  await ensureSchema();
  await getTurso().execute("UPDATE api_keys SET status = ? WHERE id = ?", [status, keyId]);
}

export async function deleteKey(keyId: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute("DELETE FROM api_keys WHERE id = ?", [keyId]);
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const r = await getTurso().execute(
    "SELECT id FROM api_keys WHERE provider = ? AND api_key = ?",
    [provider, apiKey]
  );
  return r.rows.length > 0;
}

// تحديث عدّادات المفتاح دائمًا (نجاح أو فشل) — مع تعليم الحالة حسب فئة الخطأ
export async function recordKeyResult(
  keyId: string,
  ok: boolean,
  opts?: { errorClass?: string; error?: string; markStatus?: ApiKey["status"] }
): Promise<void> {
  const sets: string[] = [
    "usage_count = usage_count + 1",
    ok ? "success_count = success_count + 1" : "fail_count = fail_count + 1",
    "last_used_at = datetime('now')",
    "last_checked_at = datetime('now')",
  ];
  const args: InValue[] = [];
  if (!ok) {
    sets.push("last_error = ?");
    args.push((opts?.error ?? "").slice(0, 300));
    if (opts?.markStatus) {
      sets.push("status = ?");
      args.push(opts.markStatus);
    }
  } else {
    sets.push("last_error = NULL");
    // نجاح بعد استنزاف؟ نعيد المفتاح للعمل (مثلًا بعد شحن الرصيد)
    sets.push("status = 'active'");
  }
  args.push(keyId);
  await getTurso().execute(`UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args);
}
