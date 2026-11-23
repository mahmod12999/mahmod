// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP فقط، مناسبة لبيئة Vercel serverless
const { createClient } = require("@libsql/client");
const env = require("./env");

let _client = null;
function getDb() {
  if (!_client) {
    if (!env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL مفقود");
    _client = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN || undefined,
    });
  }
  return _client;
}

let _schemaReady = null;
// إنشاء الجداول عند أول وصول فقط — لا حاجة لأداة migrations
function ensureSchema() {
  if (!_schemaReady) {
    _schemaReady = getDb()
      .batch([
        `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          error TEXT,
          video_size INTEGER,
          video_duration REAL,
          video_resolution TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        )`,
        `CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          mime TEXT,
          size INTEGER,
          duration REAL,
          width INTEGER,
          height INTEGER,
          has_audio INTEGER,
          PRIMARY KEY (job_id, seq)
        )`,
        // كل ملف مصدر يُقسَّم إلى أجزاء 2MB (حد HTTP في Turso)
        `CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk_index)
        )`,
        `CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk_index)
        )`,
      ])
      .catch((e) => {
        _schemaReady = null;
        throw e;
      });
  }
  return _schemaReady;
}

async function dbHealthy() {
  const r = await getDb().execute("SELECT 1");
  return r.rows.length === 1;
}

// إعادة محاولة تلقائية لأخطاء الشبكة العابرة في نداءات Turso (HTTP)
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const transient = /fetch|network|timeout|ECONN|socket|502|503|429/i.test(
        `${e.message} ${e.cause?.message || ""}`
      );
      if (!transient || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

// تنظيف كسول: حذف المهام المنتهية (تعمل عند كل إنشاء/دمج) — إضافة إلى /api/cron اليومي
async function cleanupExpired() {
  const db = getDb();
  const res = await db.execute(
    "SELECT id FROM jobs WHERE expires_at < ?", [new Date().toISOString()]
  );
  let deleted = 0;
  for (const row of res.rows) {
    await deleteJobRows(String(row.id));
    deleted++;
  }
  return deleted;
}

// حذف شامل لكل صفوف المهمة في batch واحد
async function deleteJobRows(jobId) {
  const db = getDb();
  await db.batch([
    { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] },
    { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] },
    { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] },
  ]);
}

async function getJob(jobId) {
  const r = await getDb().execute("SELECT * FROM jobs WHERE id = ?", [jobId]);
  return r.rows[0] || null;
}

async function getSources(jobId) {
  const r = await getDb().execute(
    "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC", [jobId]
  );
  return r.rows;
}

async function updateJob(jobId, patch) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  if (!sets.length) return;
  args.push(jobId);
  await getDb().execute(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args);
}

module.exports = {
  getDb,
  ensureSchema,
  dbHealthy,
  cleanupExpired,
  deleteJobRows,
  getJob,
  getSources,
  updateJob,
  withRetry,
};
