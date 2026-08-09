import { z } from "zod";

export type AdminApiEndpointContract<
  TMethod extends "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  TPath extends string,
  TPathParamsSchema extends z.ZodType,
  TQuerySchema extends z.ZodType,
  TBodySchema extends z.ZodType,
  TResponseSchema extends z.ZodType,
> = Readonly<{
  method: TMethod;
  path: TPath;
  pathParamsSchema: TPathParamsSchema;
  querySchema: TQuerySchema;
  bodySchema: TBodySchema;
  responseSchema: TResponseSchema;
}>;

export type AdminApiResponseContract<
  TMethod extends "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  TPath extends string,
  TResponseSchema extends z.ZodType,
> = AdminApiEndpointContract<
  TMethod,
  TPath,
  z.ZodType,
  z.ZodType,
  z.ZodType,
  TResponseSchema
>;

const noPathParamsSchema = z.strictObject({});
const noQuerySchema = z.strictObject({});

export function defineAdminEndpointContract<
  const TMethod extends "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  const TPath extends string,
  TPathParamsSchema extends z.ZodType,
  TQuerySchema extends z.ZodType,
  TBodySchema extends z.ZodType,
  TResponseSchema extends z.ZodType,
>(contract: {
  method: TMethod;
  path: TPath;
  pathParamsSchema: TPathParamsSchema;
  querySchema: TQuerySchema;
  bodySchema: TBodySchema;
  responseSchema: TResponseSchema;
}): AdminApiEndpointContract<
  TMethod,
  TPath,
  TPathParamsSchema,
  TQuerySchema,
  TBodySchema,
  TResponseSchema
> {
  return contract;
}

export function defineAdminApiResponseContract<
  const TMethod extends "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  const TPath extends string,
  TResponseSchema extends z.ZodType,
>(contract: {
  method: TMethod;
  path: TPath;
  responseSchema: TResponseSchema;
}): AdminApiResponseContract<TMethod, TPath, TResponseSchema> {
  return defineAdminEndpointContract({
    ...contract,
    pathParamsSchema: noPathParamsSchema,
    querySchema: noQuerySchema,
    bodySchema: z.unknown(),
  });
}

export function parseAdminApiResponse<TResponseSchema extends z.ZodType>(
  contract: Pick<
    AdminApiEndpointContract<
      "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      string,
      z.ZodType,
      z.ZodType,
      z.ZodType,
      TResponseSchema
    >,
    "responseSchema"
  >,
  value: unknown,
): z.output<TResponseSchema> {
  return contract.responseSchema.parse(value);
}
