import { z } from "zod";

export const categoryStatusSchema = z.enum(["active", "inactive"]);
export type CategoryStatus = z.infer<typeof categoryStatusSchema>;
export const categoryStatuses = categoryStatusSchema.options;

export const productStatusSchema = z.enum(["draft", "active", "inactive"]);
export type ProductStatus = z.infer<typeof productStatusSchema>;
export const productStatuses = productStatusSchema.options;

export const variantStatusSchema = z.enum(["active", "inactive"]);
export type VariantStatus = z.infer<typeof variantStatusSchema>;
export const variantStatuses = variantStatusSchema.options;
