import type { CallHandler, ExecutionContext } from "@nestjs/common";

import { Reflector } from "@nestjs/core";
import { adminTryOnSilhouetteUploadContract } from "@vem/shared";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { ApiResponseInterceptor } from "./api-response.interceptor";

const handler = vi.fn();
const context = {
  getHandler: () => handler,
} as unknown as ExecutionContext;
const summary = {
  id: "550e8400-e29b-41d4-a716-446655440125",
  publicUrl: "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
  contentType: "image/png",
};

describe("ApiResponseInterceptor", () => {
  it("validates declared Admin responses before wrapping the envelope", async () => {
    const reflector = {
      get: vi.fn().mockReturnValue(adminTryOnSilhouetteUploadContract),
    } as unknown as Reflector;
    const interceptor = new ApiResponseInterceptor(reflector);

    await expect(
      firstValueFrom(
        interceptor.intercept(context, {
          handle: () => of(summary),
        } as CallHandler),
      ),
    ).resolves.toEqual({ code: 0, message: "ok", data: summary });
  });

  it("rejects database fields that leak across a declared response seam", async () => {
    const reflector = {
      get: vi.fn().mockReturnValue(adminTryOnSilhouetteUploadContract),
    } as unknown as Reflector;
    const interceptor = new ApiResponseInterceptor(reflector);

    await expect(
      firstValueFrom(
        interceptor.intercept(context, {
          handle: () => of({ ...summary, storageKey: "private/key.png" }),
        } as CallHandler),
      ),
    ).rejects.toThrow();
  });
});
