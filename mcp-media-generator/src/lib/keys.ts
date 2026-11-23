// أدوات المفاتيح — الإخفاء الإلزامي في كل الاستجابات والسجلات
// maskKey = أول 7 أحرف + •••••••• + آخر 4 (للمفاتيح القصيرة: أول 3 + ••••)
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) {
    return key.slice(0, Math.min(3, key.length)) + "••••";
  }
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}
