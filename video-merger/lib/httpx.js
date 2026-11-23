// أدوات HTTP مشتركة بين الدوال — استجابات JSON موحدة وأخطاء عربية واضحة
const env = require("./env");

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(body);
}

// CORS مفتوح — الموقع API عام للمطورين
function handleOptions(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.statusCode = 204;
  res.end();
}

// قراءة الجسم الثنائي بحد أقصى — تجاوز الحد = 413 (نُبقي الاتصال حيًا لإرسال الاستجابة)
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        // نتجاهل بقية البيانات ونستمر بالقراءة حتى النهاية ثم نرد 413
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (overflow) {
        const err = new Error(`حجم الجزء يتجاوز الحد المسموح (${Math.round(maxBytes / 1024 / 1024)}MB)`);
        err.status = 413;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

// قراءة جسم JSON مع رفض التالف برسالة عربية (400)
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const buf = await readRawBody(req, maxBytes);
  const text = buf.toString("utf8").trim();
  if (!text) {
    const err = new Error("جسم الطلب فارغ — أرسل JSON صالحًا");
    err.status = 400;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("جسم الطلب ليس JSON صالحًا");
    err.status = 400;
    throw err;
  }
}

// عنوان الخدمة المطلق من الترويسات (يعمل محليًا وعلى Vercel خلف بروكسي)
function buildBaseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost");
  return `${proto}://${host}`;
}

function isHttpError(e) {
  return e && typeof e.status === "number";
}

module.exports = {
  env,
  sendJson,
  handleOptions,
  readRawBody,
  readJsonBody,
  buildBaseUrl,
  isHttpError,
};
