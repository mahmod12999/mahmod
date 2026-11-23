import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MCP Media Generator — لوحة الإدارة",
  description: "خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع",
};

// واجهة عربية RTL من أول لحظة — dir="rtl" و lang="ar" وخط عربي جيد
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body
        className="antialiased min-h-screen"
        style={{ fontFamily: "'Tajawal', system-ui, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
