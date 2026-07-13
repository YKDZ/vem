import type { z } from "zod";

export type AdminApiResponseContract<
  TMethod extends "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  TPath extends string,
  TResponseSchema extends z.ZodType,
> = Readonly<{
  method: TMethod;
  path: TPath;
  responseSchema: TResponseSchema;
}>;

export function defineAdminApiResponseContract<
  const TMethod extends "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  const TPath extends string,
  TResponseSchema extends z.ZodType,
>(contract: {
  method: TMethod;
  path: TPath;
  responseSchema: TResponseSchema;
}): AdminApiResponseContract<TMethod, TPath, TResponseSchema> {
  return contract;
}

export function parseAdminApiResponse<TResponseSchema extends z.ZodType>(
  contract: AdminApiResponseContract<
    "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    string,
    TResponseSchema
  >,
  value: unknown,
): z.output<TResponseSchema> {
  return contract.responseSchema.parse(value);
}
