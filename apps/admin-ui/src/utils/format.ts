export function formatCents(value: number): string {
  return `¥${(value / 100).toFixed(2)}`;
}

export function formatDateTime(
  value: string | Date | null | undefined,
): string {
  if (!value) return "-";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
