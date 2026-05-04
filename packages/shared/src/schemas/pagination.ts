import { z } from "zod";

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const createPageResultSchema = <TItem extends z.ZodType>(
  itemSchema: TItem,
): z.ZodObject<{
  items: z.ZodArray<TItem>;
  page: z.ZodNumber;
  pageSize: z.ZodNumber;
  total: z.ZodNumber;
}> =>
  z.object({
    items: z.array(itemSchema),
    page: z.int().min(1),
    pageSize: z.int().min(1),
    total: z.int().min(0),
  });

export const createApiResponseSchema = <TData extends z.ZodType>(
  dataSchema: TData,
): z.ZodObject<{
  code: z.ZodNumber;
  message: z.ZodString;
  data: TData;
}> =>
  z.object({
    code: z.int(),
    message: z.string(),
    data: dataSchema,
  });
