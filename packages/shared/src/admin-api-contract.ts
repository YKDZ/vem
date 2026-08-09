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

/** Browser uploads and Multer's server-side representation share one typed
 * boundary, so media operations never escape the Admin endpoint contract. */
export type AdminMultipartFile =
  | Blob
  | {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Uint8Array;
    };

export const adminMultipartFileSchema = z.custom<AdminMultipartFile>(
  (value) => {
    if (typeof Blob !== "undefined" && value instanceof Blob) return true;
    if (!isRecord(value)) return false;
    return (
      typeof value.originalname === "string" &&
      typeof value.mimetype === "string" &&
      typeof value.size === "number" &&
      Number.isInteger(value.size) &&
      value.size >= 0 &&
      value.buffer instanceof Uint8Array
    );
  },
  "a multipart file is required",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
