import { z } from "zod";

export const adminUserStatusSchema = z.enum(["active", "disabled"]);
export type AdminUserStatus = z.infer<typeof adminUserStatusSchema>;
export const adminUserStatuses = adminUserStatusSchema.options;

export const roleStatusSchema = z.enum(["active", "disabled"]);
export type RoleStatus = z.infer<typeof roleStatusSchema>;
export const roleStatuses = roleStatusSchema.options;

export const permissionCodeSchema = z.enum([
  "dashboard.read",
  "products.read",
  "products.write",
  "inventory.read",
  "inventory.adjust",
  "inventory.refill",
  "orders.read",
  "orders.refund",
  "payments.read",
  "payments.configure",
  "payments.refund",
  "machines.read",
  "machines.write",
  "machines.command",
  "adminUsers.read",
  "adminUsers.write",
  "roles.write",
  "notifications.read",
  "notifications.write",
  "audit.read",
]);
export type PermissionCode = z.infer<typeof permissionCodeSchema>;
export const permissionCodes = permissionCodeSchema.options;
