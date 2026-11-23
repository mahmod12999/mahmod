# 🎨 MCP Media Generator + Video Merger — الحزمة الكاملة

مشروعان مترابطان جاهزان للنشر على **Vercel**:

| المشروع | المجلد | الوظيفة |
|---|---|---|
| **خادم توليد الوسائط MCP** | [`mcp-media-generator/`](mcp-media-generator/) | خادم MCP (Next.js) بـ 5 أدوات: توليد صور، فيديو بصوت متزامن، دمج مقاطع، تتبع المهام، واسترجاع الوسائط — مع لوحة إدارة عربية وتبديل تسلسلي تلقائي للمفاتيح |
| **خدمة دمج الفيديو** | [`video-merger/`](video-merger/) | موقع دمج فيديو + API عامة (Node.js خالص) — MP4 (H.264+AAC) حتى 1080p، تخزين Turso، معالجة ffmpeg داخل الدوال، حذف تلقائي بعد 24 ساعة |

كلا المشروعين فيه README عربي كامل خطوة بخطوة:

- [README خادم MCP](mcp-media-generator/README.md) — الأدوات، التبديل التسلسلي، الربط مع العملاء، النشر.
- [README خدمة الدمج](video-merger/README.md) — توثيق API الكامل بأمثلة curl، محرك الدمج، النشر.

## 🚀 التشغيل السريع المحلي

```bash
# 1) خدمة الدمج (منفذ 3001)
cd video-merger && npm install && npm run dev

# 2) خادم MCP (منفذ 3000)
cd mcp-media-generator && npm install
cp .env.example .env.local   # ضع قيم Turso + MERGER_API_BASE=http://localhost:3001
npm run build && npm run start
```

ثم افتح `http://localhost:3000` — أضف مفتاح kie.ai من لوحة «مدير المفاتيح» وابدأ.

## ☁️ النشر على Vercel (مشروعان من مستودع واحد)

1. ارفع هذا المستودع إلى GitHub.
2. في Vercel أنشئ **مشروعين** من نفس المستودع:
   - المشروع الأول: Root Directory = `video-merger` — متغيرات: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
   - المشروع الثاني: Root Directory = `mcp-media-generator` — متغيرات: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `MERGER_API_BASE=https://<مشروع-الدمج>.vercel.app` (واختياريًا `MCP_ACCESS_TOKEN`).
3. بعد النشر: الواجهة على جذر مشروع MCP، والخدمة على `<origin>/mcp`، و`/api/health` للفحص.

## 🔑 ما تحتاجه قبل الاستخدام

1. قاعدة [Turso](https://turso.tech) مجانية: `turso db create <name>` ثم `--url` و `tokens create`.
2. مفتاح [kie.ai](https://kie.ai) — يُضاف من لوحة الإدارة (لا يوضع في متغيرات البيئة).
3. (اختياري) مفتاح CometAPI لمزود ثانٍ — يُجرب تلقائيًا ضمن نفس الترتيب التسلسلي.

## 🧪 الاختبارات المنفذة

- خدمة الدمج: **8/8** اختبارات وحدات + **19/19** اختبار HTTP.
- خادم MCP: **9/9** اختبارات بروتوكول (initialize / tools/list / الحدود / الردود العربية).
- e2e حقيقي بالسكرپت `scripts/e2e-test.mjs`: صورة حقيقية عبر kie.ai + تبديل تسلسلي بمفتاح خاطئ أولًا + مفتاح مستنزف لا يعرقل + فيديو حقيقي يتبع بـ get_task + دمج مقطعين عامين + list_media + تنظيف آثار الاختبار.
