import "reflect-metadata";
import type { CallHandler, ExecutionContext } from "@nestjs/common";

import { BadRequestException } from "@nestjs/common";
import { defineAdminEndpointContract } from "@vem/shared";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ADMIN_ENDPOINT_CONTRACT,
  AdminContractRequestValidationInterceptor,
} from "./admin-endpoint-contract.decorator";

const contract = defineAdminEndpointContract({
  method: "POST",
  path: "/machines/:id",
  pathParamsSchema: z.strictObject({ id: z.uuid() }),
  querySchema: z.strictObject({ page: z.coerce.number().int().default(1) }),
  bodySchema: z.strictObject({
    code: z.string().transform((value) => value.toUpperCase()),
  }),
  responseSchema: z.strictObject({ ok: z.boolean() }),
});

const handler = () => undefined;

function contextFor(handlerFn: unknown, request: unknown): ExecutionContext {
  return {
    getHandler: () => handlerFn,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("AdminContractRequestValidationInterceptor", () => {
  it("is the single request validation point and hands parsed values to the handler", async () => {
    Reflect.defineMetadata(ADMIN_ENDPOINT_CONTRACT, contract, handler);
    const request = {
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      query: { page: "3" },
      body: { code: "ab-cd" },
    };
    const interceptor = new AdminContractRequestValidationInterceptor();

    const result = await firstValueFrom(
      interceptor.intercept(contextFor(handler, request), {
        handle: () => of("next"),
      } as CallHandler),
    );

    expect(result).toBe("next");
    expect(request.body.code).toBe("AB-CD");
    expect(request.query.page).toBe(3);
    expect(request.params.id).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("rejects an invalid body at the HTTP boundary with a deterministic 400", async () => {
    Reflect.defineMetadata(ADMIN_ENDPOINT_CONTRACT, contract, handler);
    const request = {
      params: { id: "550e8400-e29b-41d4-a716-446655440000" },
      query: {},
      body: { code: 42 },
    };
    const interceptor = new AdminContractRequestValidationInterceptor();

    expect(() =>
      interceptor.intercept(contextFor(handler, request), {
        handle: () => of("next"),
      } as CallHandler),
    ).toThrow(BadRequestException);
  });

  it("keeps the stable missing-file reason for the garment upload contract", async () => {
    const uploadContract = defineAdminEndpointContract({
      method: "POST",
      path: "/media-assets/try-on-garments",
      pathParamsSchema: z.strictObject({}),
      querySchema: z.strictObject({}),
      bodySchema: z.strictObject({ file: z.unknown() }),
      responseSchema: z.strictObject({}),
    });
    Reflect.defineMetadata(ADMIN_ENDPOINT_CONTRACT, uploadContract, handler);
    const request = { params: {}, query: {}, body: {} };
    const interceptor = new AdminContractRequestValidationInterceptor();

    expect(() =>
      interceptor.intercept(contextFor(handler, request), {
        handle: () => of("next"),
      } as CallHandler),
    ).toThrow("TRY_ON_GARMENT_FILE_REQUIRED");
  });
});
