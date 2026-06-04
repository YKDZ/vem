import { randomUUID } from "node:crypto";

export type BusinessNoPrefix = "ORD" | "PAY" | "PCA" | "CMD" | "MCMD" | "RFD";

export function createBusinessNo(prefix: BusinessNoPrefix): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  return `${prefix}${timestamp}${suffix}`;
}
