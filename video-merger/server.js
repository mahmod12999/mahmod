// خادم تطوير محلي يحاكي بيئة Vercel — يحلّل المسارات الديناميكية ويضعها في req.query
// مثلًا: /api/jobs/mk_123/process → req.query.id = "mk_123" ثم يستدعي api/jobs/[id]/process.js
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

require("./lib/env"); // تحميل .env يدويًا

const PORT = parseInt(process.env.PORT || "3001", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

// جدول التوجيه — نفس أسماء ملفات Vercel بالضبط
const routes = [
  { method: "POST", re: /^\/api\/jobs\/?$/, mod: () => require("./api/jobs") },
  { method: "GET", re: /^\/api\/config\/?$/, mod: () => require("./api/config") },
  { method: "GET", re: /^\/api\/cron\/?$/, mod: () => require("./api/cron") },
  { method: "POST", re: /^\/api\/upload\/?$/, mod: () => require("./api/upload") },
  { method: ["GET", "DELETE"], re: /^\/api\/jobs\/([^/]+)\/?$/, mod: () => require("./api/jobs/[id].js"), param: "id" },
  { method: "POST", re: /^\/api\/jobs\/([^/]+)\/process\/?$/, mod: () => require("./api/jobs/[id]/process.js"), param: "id" },
  { method: "GET", re: /^\/api\/jobs\/([^/]+)\/video\/?$/, mod: () => require("./api/jobs/[id]/video.js"), param: "id" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // API — أول مسار يطابق يتكفل بالاستجابة (بما فيها 405 لطريقة خاطئة، مثل سلوك Vercel)
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (!m) continue;
    // المحاكاة الجوهرية: معاملات المسار الديناميكي تُوضع في req.query مثل Vercel
    req.query = { ...parsed.query };
    if (r.param) req.query[r.param] = m[1];
    try {
      await r.mod()(req, res);
    } catch (e) {
      console.error("API error:", e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: e.message }));
      }
    }
    return;
  }

  // ملفات ثابتة
  if (req.method === "GET") {
    if (pathname === "/" || pathname === "/index.html") {
      return serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
    }
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return serveStatic(res, filePath);
    }
  }

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "المسار غير موجود" }));
});

server.listen(PORT, () => {
  console.log(`✅ خادم التطوير يعمل على http://localhost:${PORT}`);
});
