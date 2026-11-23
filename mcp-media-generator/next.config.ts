import type { NextConfig } from "next";

// ملاحظة: cacheComponents معطّل لأنه يتعارض مع route segment config المطلوب في المواصفة
// (export const runtime = "nodejs" على كل الـ route handlers و dynamic="force-dynamic" على /mcp)
const nextConfig: NextConfig = {
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
