# 🎬 خدمة دمج الفيديوهات — Video Merger API

موقع كامل لدمج مقاطع الفيديو مع واجهة برمجية عامة (API) للمطورين، جاهز للنشر على **Vercel**:
Node.js خالص (CommonJS) بلا خطوة بناء، تخزين كامل في **Turso** (libSQL)، ومعالجة **ffmpeg** داخل الدوال نفسها.

- **الناتج:** MP4 (H.264 + AAC) بجودة CRF 18 حتى 1080p — يُوحَّد بأكبر دقة بين المدخلات، fps=30.
- **بدون S3 أو خدمات خارجية:** كل شيء (المصادر المرفوعة والناتج) يُخزَّن كأجزاء BLOB في Turso.
- **الخصوصية:** الملفات تُحذف تلقائيًا بعد **24 ساعة** (تنظيف كسول عند كل طلب + Cron يومي).

---

## 🚀 النشر على Vercel خطوة بخطوة

### 1) إنشاء قاعدة Turso مجانية

```bash
# تثبيت أداة Turso (مرة واحدة)
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup

# إنشاء القاعدة والحصول على الرابط والتوكن
turso db create video-merger
turso db show video-merger --url      # ← هذا TURSO_DATABASE_URL
turso db tokens create video-merger   # ← هذا TURSO_AUTH_TOKEN (بصلاحيات كتابة)
```

### 2) رفع الكود إلى GitHub وربطه بـ Vercel

1. ارفع هذا المجلد (`video-merger/`) إلى مستودع GitHub.
2. في [vercel.com/new](https://vercel.com/new) اضغط **Import** على المستودع.
3. في إعدادات المشروع اضبط **Root Directory** على `video-merger` (إن كان المستودع يحوي المشروعين).
4. أضف **Environment Variables** (Production + Preview):

   | المتغير | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://<db-name>-<org>.turso.io` |
   | `TURSO_AUTH_TOKEN` | التوكن من الخطوة 1 |

5. اضغط **Deploy**. سيتعرف Vercel على `api/` تلقائيًا — لا خطوة بناء.

> **حدود الخطة المجانية في Vercel:** أقصى مدة تنفيذ للدالة 60 ثانية (هنا مضبوطة 300 للخطة Pro عبر `vercel.json`)، وحجم الطلب ~4.5MB (لهذا الرفع أجزاء 4MB)، ومساحة القرص مؤقتة `/tmp` فقط (~500MB).

### 3) تجربة API بعد النشر بـ curl

```bash
BASE="https://<your-project>.vercel.app"

# الحدود العامة
curl "$BASE/api/config"

# إنشاء مهمة من روابط مباشرة
curl -X POST "$BASE/api/jobs" -H "Content-Type: application/json" \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# → {"jobId":"mk_xxx","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# تنفيذ الدمج (متزامن، يستغرق ~10-15 ثانية)
curl -X POST "$BASE/api/jobs/<jobId>/process"
# → {"status":"done","videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"640x360","expiresAt":"..."}

# متابعة الحالة
curl "$BASE/api/jobs/<jobId>"

# تحميل الناتج
curl -o merged.mp4 "$BASE/api/jobs/<jobId>/video?download=1"

# رفع ملف من الجهاز كأجزاء 4MB (ثنائي)
curl -X POST "$BASE/api/upload?job=<jobId>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @part0.bin

# حذف فوري شامل
curl -X DELETE "$BASE/api/jobs/<jobId>"
```

---

## 📡 توثيق API الكامل

عام بلا تسجيل، CORS مفتوح، والأخطاء دائمًا بصيغة `{"error":"رسالة عربية"}`.

| Method | Endpoint | الوظيفة | الاستجابة |
|---|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة دمج | `201` مع `jobId` و`statusUrl` و`processUrl` و`expiresAt` (+`uploads[]` عند وجود ملفات) |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء ≤4MB ثنائي | `{"ok":true,"received":...,"totalReceived":...,"complete":bool}` |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا | `200` `{"status":"done",...}` أو `202` إن كانت قيد المعالجة أو `409/500` عند الفشل |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0-100 | `{status, progress, videoUrl?, downloadUrl?, size, duration, resolution, expiresAt}` |
| `GET` | `/api/jobs/<id>/video` | بث الناتج بدعم **Range 206**، و`?download=1` للتحميل | MP4 |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل | `{"ok":true}` |
| `GET` | `/api/config` | الحدود العامة + version | `{version, limits, output}` |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي) | `{"ok":true,"deleted":n}` |

**أشكال جسم إنشاء المهمة:**

```jsonc
// روابط مباشرة
{"videos": ["https://a.com/x.mp4", "https://b.com/y.mp4"]}

// أو مصادر مختلطة (رابط + ملف سيُرفع لاحقًا بالأجزاء)
{"sources": [
  {"kind":"url","url":"https://a.com/x.mp4"},
  {"kind":"file","name":"y.mp4","size":123456,"mime":"video/mp4"}
]}
```

**حالات المهمة:** `queued` → (`uploading`) → `processing` → `done` | `failed`، مع عمود `progress`.

**أكواد الأخطاء:** `400` مدخلات تالفة · `404` غير موجود · `405` طريقة خاطئة · `409` حالة غير مناسبة · `413` تجاوز الحجم · `416` نطاق Range خارج الحدود · `500` خطأ داخلي.

---

## 🧱 المحرك الداخلي (جودة عالية)

1. **ffprobe لكل مصدر:** الدقة، معدل الإطارات، المدة، وجود صوت.
2. **توحيد عبر `filter_complex`:** `scale` + `pad` إلى أكبر دقة بين المدخلات (حد 1920×1080، أبعاد زوجية)، `fps=30`، `setsar=1`، `format=yuv420p` ثم `concat=n=:v=1:a=1`.
3. **مصدر بلا صوت؟** يُضاف مسار صامت `aevalsrc` بنفس مدته بدل أن يفشل الدمج.
4. **الترميز:** `libx264 CRF 18` + `AAC 192k/44100Hz` + `+faststart`، والـ preset من متغير البيئة.
5. **تقدم الترميز:** يُقرأ `out_time_us` من `-progress pipe:1` — (0-40 سحب المصادر، 40-90 ترميز، 100 اكتمال) ويُخزَّن في القاعدة.
6. **`ensureExecutable`:** ينسخ ثنائي ffmpeg إلى `/tmp` بصلاحية 755 إن فقدت صلاحية التنفيذ في الاستضافة.
7. **الحدود تُفحص قبل وأثناء العمل:** عدد المصادر، حجم كل مصدر أثناء التنزيل، حجم الناتج بعد الترميز، مجموع المدد — تجاوز أي حد = فشل واضح برسالة، لا انهيار.
8. **التخزين:** كل Blob يُقسَّم لصفوف 2MB (حد HTTP في Turso)، تُقرأ بصفحات من 8 صفوف، والبث يدعم تقليم أول/آخر جزء حسب `Range`.
9. **لا ملفات دائمة:** `/tmp` فقط أثناء المعالجة، وتُنظف في `finally`.

---

## 🧪 الاختبارات

```bash
npm run dev        # خادم تطوير محلي على :3001 يحاكي Vercel (يحلل المسارات الديناميكية)
npm run test:unit  # 8 اختبارات: توليد فيديوهين مختلفي الدقة بـ ffmpeg، دمج، التحقق من الدقة/المدة/الصوت، تخزين Turso بتطابق sha256، رفع الأجزاء، الحدود، الحذف الشامل
npm run test:http  # 19 اختبارًا ضد خادم التطوير: دورة كاملة من روابط، Range 206، مهمة مختلطة، 413/404/405/400، JSON تالف، قائمة فارغة، DELETE
```

---

## ⚙️ متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | ✅ | — | توكن بصلاحيات كتابة |
| `MAX_SOURCES` | — | `10` | أقصى عدد مقاطع للدمج |
| `SOURCE_MAX_MB` | — | `200` | حد حجم كل مصدر |
| `OUTPUT_MAX_MB` | — | `150` | حد حجم الناتج |
| `MAX_TOTAL_DURATION_SEC` | — | `600` | مجموع مدد المقاطع |
| `FFMPEG_PRESET` | — | `medium` | preset ترميز libx264 |
| `PORT` | — | `3001` | منفذ خادم التطوير فقط |

---

## 📁 البنية

```
video-merger/
├── api/                  # دوال Vercel Serverless
│   ├── jobs.js           # POST /api/jobs
│   ├── upload.js         # POST /api/upload
│   ├── config.js         # GET /api/config
│   ├── cron.js           # GET /api/cron
│   └── jobs/[id]/        # GET|DELETE، process، video
├── lib/                  # المنطق: قاعدة بيانات، تخزين، دمج، أدوات
├── public/index.html     # الواجهة العربية RTL (ملف واحد، ثيم داكن)
├── scripts/              # اختبارات الوحدات و HTTP
├── server.js             # خادم تطوير يحاكي Vercel
└── vercel.json           # maxDuration 300 + Cron يومي + includeFiles لثنائيات ffmpeg
```

> ملاحظة: ثنائيات `ffmpeg-static`/`ffprobe-static` تُضمَّن مع الدالة عبر `includeFiles` في `vercel.json` لأن NFT قد لا يتتبعها تلقائيًا.
