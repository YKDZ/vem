import type { AdminApiEndpointContract } from "@vem/shared";
import type { Request } from "express";
import type { z } from "zod";

import {
  applyDecorators,
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestMethod,
  RequestMapping,
  SetMetadata,
  UseInterceptors,
} from "@nestjs/common";

import { ADMIN_RESPONSE_CONTRACT } from "./admin-response-contract.decorator";

export const ADMIN_ENDPOINT_CONTRACT = Symbol("admin-endpoint-contract");

type AnyAdminEndpointContract = AdminApiEndpointContract<
  "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  string,
  z.ZodType,
  z.ZodType,
  z.ZodType,
  z.ZodType
>;

const requestMethods = {
  GET: RequestMethod.GET,
  POST: RequestMethod.POST,
  PATCH: RequestMethod.PATCH,
  PUT: RequestMethod.PUT,
  DELETE: RequestMethod.DELETE,
} as const;

/**
 * The method route and all request/response schemas are one shared contract.
 * This decorator is intentionally the provider's route binding, not merely a
 * response annotation: it registers the method/path and attaches the request
 * validation interceptor at the public HTTP boundary.
 */
export function AdminEndpointContract(
  contract: AnyAdminEndpointContract,
): MethodDecorator {
  return applyDecorators(
    RequestMapping({
      path: contract.path,
      method: requestMethods[contract.method],
    }),
    SetMetadata(ADMIN_ENDPOINT_CONTRACT, contract),
    SetMetadata(ADMIN_RESPONSE_CONTRACT, contract),
    UseInterceptors(AdminContractRequestValidationInterceptor),
  );
}

@Injectable()
export class AdminContractRequestValidationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const handler = context.getHandler();
    const metadata: unknown = Reflect.getMetadata(
      ADMIN_ENDPOINT_CONTRACT,
      handler,
    );
    const contract = isAdminEndpointContract(metadata) ? metadata : undefined;
    if (!contract) return next.handle();

    const request = context.switchToHttp().getRequest<
      Request & {
        file?: unknown;
      }
    >();
    parseOrReject(contract.pathParamsSchema, request.params, "path");
    parseOrReject(contract.querySchema, request.query, "query");
    if (contract.path === "/media-assets/try-on-garments" && !request.file) {
      if (isRecord(request.body) && Object.keys(request.body).length > 0) {
        throw new BadRequestException("TRY_ON_GARMENT_MULTIPART_INVALID");
      }
      // Keep the upload operation's stable missing-file reason code while
      // still requiring the file through the contract for all present files.
      throw new BadRequestException("TRY_ON_GARMENT_FILE_REQUIRED");
    }
    const body = request.file
      ? { ...(isRecord(request.body) ? request.body : {}), file: request.file }
      : (request.body ?? {});
    try {
      parseOrReject(contract.bodySchema, body, "body");
    } catch (error) {
      if (contract.path === "/media-assets/try-on-garments") {
        throw new BadRequestException("TRY_ON_GARMENT_MULTIPART_INVALID");
      }
      throw error;
    }
    return next.handle();
  }
}

function parseOrReject(schema: z.ZodType, value: unknown, location: string) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new BadRequestException(
    parsed.error.issues
      .map(
        (issue) =>
          `${location}.${issue.path.join(".") || "value"}: ${issue.message}`,
      )
      .join("; "),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdminEndpointContract(
  value: unknown,
): value is AnyAdminEndpointContract {
  if (!isRecord(value)) return false;
  return (
    typeof value.method === "string" &&
    typeof value.path === "string" &&
    isZodSchema(value.pathParamsSchema) &&
    isZodSchema(value.querySchema) &&
    isZodSchema(value.bodySchema) &&
    isZodSchema(value.responseSchema)
  );
}

function isZodSchema(value: unknown): value is z.ZodType {
  return isRecord(value) && typeof value.safeParse === "function";
}
