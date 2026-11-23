// طبقة تخزين الـ Blobs — تقسيم 2MB لكل صف (حد HTTP في Turso) وقراءة تدفقيًا
const { Readable } = require("stream");
const { getDb } = require("./db");

// حجم صف التخزين في القاعدة (2MB)
const BLOB_CHUNK = 2 * 1024 * 1024;
// عدد الصفوف في كل استعلام عند القراءة التدفقيّة
const PAGE_ROWS = 8;

// Turso يعيد الـ BLOB كـ ArrayBuffer — نحوّله إلى Uint8Array بشكل صحيح
function toU8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Uint8Array.from(data);
}

// كتابة مخزن بايتات كأجزاء 2MB في جدول source_chunks — startIndex يحدد ترقيم أول صف
async function putSourceChunks(jobId, seq, buf, startIndex = 0) {
  const db = getDb();
  const stmts = [];
  for (let off = 0, i = 0; off < buf.length; off += BLOB_CHUNK, i++) {
    stmts.push({
      sql: "INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)",
      args: [jobId, seq, startIndex + i, buf.subarray(off, Math.min(off + BLOB_CHUNK, buf.length))],
    });
  }
  if (stmts.length) await db.batch(stmts, "write");
  return stmts.length;
}

// كتابة الفيديو الناتج كأجزاء 2MB في جدول output_chunks
async function putOutputChunks(jobId, buf) {
  const db = getDb();
  const stmts = [];
  for (let off = 0, i = 0; off < buf.length; off += BLOB_CHUNK, i++) {
    stmts.push({
      sql: "INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)",
      args: [jobId, i, buf.subarray(off, Math.min(off + BLOB_CHUNK, buf.length))],
    });
  }
  if (stmts.length) await db.batch(stmts, "write");
  return stmts.length;
}

// إعادة تجميع ملف مصدر مرفوع من أجزائه
async function readSourceFile(jobId, seq) {
  const db = getDb();
  const rows = [];
  let cursor = 0;
  // قراءة بصفحات من 8 صفوف لتجنّب استعلامات ضخمة
  while (true) {
    const r = await db.execute(
      "SELECT chunk_index, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk_index >= ? ORDER BY chunk_index ASC LIMIT ?",
      [jobId, seq, cursor, PAGE_ROWS]
    );
    for (const row of r.rows) rows.push(toU8(row.data));
    if (r.rows.length < PAGE_ROWS) break;
    cursor = Number(r.rows[r.rows.length - 1].chunk_index) + 1;
  }
  const total = rows.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of rows) { out.set(c, off); off += c.length; }
  return Buffer.from(out);
}

// حجم الملف المصدر المخزن (مجموع أطوال الأجزاء) — للتحقق من اكتمال الرفع
async function sourceStoredBytes(jobId, seq) {
  const r = await getDb().execute(
    "SELECT total(length(data)) AS n, count(*) AS c FROM source_chunks WHERE job_id = ? AND seq = ?",
    [jobId, seq]
  );
  return { bytes: Number(r.rows[0]?.n || 0), chunks: Number(r.rows[0]?.c || 0) };
}

// تحويل صفوف الـ Blobs إلى stream مع تقليم أول/آخر جزء حسب نطاق bytes المطلوب (دعم Range)
function outputBlobStream(jobId, start = null, end = null) {
  const db = getDb();
  // حساب أول وآخر صف مطلوب + القص داخل الصف الطرفي
  let firstChunk = 0;
  let lastChunk = null;
  let trimStart = 0;
  if (start != null) {
    firstChunk = Math.floor(start / BLOB_CHUNK);
    trimStart = start % BLOB_CHUNK;
  }
  if (end != null) {
    lastChunk = Math.floor(end / BLOB_CHUNK);
  }

  let cursor = firstChunk;
  let done = false;
  let rowBuf = null;
  let rowOff = 0;

  return new Readable({
    async read() {
      if (done) return this.push(null);
      try {
        // إذا انتهى الصف الحالي ننتقل لصف جديد
        if (!rowBuf || rowOff >= rowBuf.length) {
          if (lastChunk != null && cursor > lastChunk) {
            done = true;
            return this.push(null);
          }
          const r = await db.execute(
            "SELECT chunk_index, data FROM output_chunks WHERE job_id = ? AND chunk_index >= ? ORDER BY chunk_index ASC LIMIT ?",
            [jobId, cursor, PAGE_ROWS]
          );
          if (!r.rows.length) {
            done = true;
            return this.push(null);
          }
          rowBuf = null;
          rowOff = 0;
          // إزاحة النهاية داخل الصف الأخير الخام (شاملة)
          const pieceEnd = lastChunk != null ? end - lastChunk * BLOB_CHUNK + 1 : null;
          for (const row of r.rows) {
            const idx = Number(row.chunk_index);
            if (lastChunk != null && idx > lastChunk) {
              done = true;
              break;
            }
            let piece = toU8(row.data);
            if (idx === firstChunk && idx === lastChunk) {
              // النطاق كله داخل صف واحد — تقليم من الطرفين
              piece = piece.subarray(trimStart, pieceEnd);
            } else if (idx === firstChunk) {
              piece = piece.subarray(trimStart);
            } else if (idx === lastChunk) {
              piece = piece.subarray(0, pieceEnd);
            }
            if (rowBuf) {
              const merged = new Uint8Array(rowBuf.length + piece.length);
              merged.set(rowBuf, 0);
              merged.set(piece, rowBuf.length);
              rowBuf = merged;
            } else {
              rowBuf = piece;
            }
          }
          if (!rowBuf) {
            done = true;
            return this.push(null);
          }
          rowOff = 0;
          cursor = Number(r.rows[r.rows.length - 1].chunk_index) + 1;
        }
        const chunk = rowBuf.subarray(rowOff, Math.min(rowOff + 512 * 1024, rowBuf.length));
        rowOff += chunk.length;
        this.push(Buffer.from(chunk));
      } catch (e) {
        this.destroy(e);
      }
    },
  });
}

// الحجم الكلي للناتج المخزن (للتحقق والترويسات)
async function outputStoredBytes(jobId) {
  const r = await getDb().execute(
    "SELECT total(length(data)) AS n FROM output_chunks WHERE job_id = ?",
    [jobId]
  );
  return Number(r.rows[0]?.n || 0);
}

module.exports = {
  BLOB_CHUNK,
  putSourceChunks,
  putOutputChunks,
  readSourceFile,
  sourceStoredBytes,
  outputBlobStream,
  outputStoredBytes,
};
