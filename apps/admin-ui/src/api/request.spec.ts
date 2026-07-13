// @vitest-environment jsdom

import { defineAdminApiResponseContract } from "@vem/shared";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  normalizeRequestParams,
  postAdminApiContract,
  postContract,
  request,
  tokenStorage,
} from "./request";

describe("normalizeRequestParams", () => {
  it("clamps numeric pageSize query params to the backend pagination contract", () => {
    expect(normalizeRequestParams({ page: 1, pageSize: 200 })).toEqual({
      page: 1,
      pageSize: 100,
    });
    expect(normalizeRequestParams({ page: 1, pageSize: "250" })).toEqual({
      page: 1,
      pageSize: 100,
    });
    expect(normalizeRequestParams({ page: 1, pageSize: 0 })).toEqual({
      page: 1,
      pageSize: 1,
    });
  });

  it("clamps URLSearchParams pageSize without mutating the caller params", () => {
    const params = new URLSearchParams({ page: "1", pageSize: "500" });

    const normalized = normalizeRequestParams(params);

    expect(normalized).toBeInstanceOf(URLSearchParams);
    if (!(normalized instanceof URLSearchParams)) {
      throw new Error("expected normalized params to be URLSearchParams");
    }
    expect(normalized.get("pageSize")).toBe("100");
    expect(params.get("pageSize")).toBe("500");
  });

  it("leaves unrelated params untouched", () => {
    const params = { page: 1, status: "paid" };

    expect(normalizeRequestParams(params)).toBe(params);
  });
});

describe("tokenStorage", () => {
  it("clears a stale refresh token when the next token response omits one", () => {
    tokenStorage.setTokens("access-1", "refresh-1");

    tokenStorage.setTokens("access-2");

    expect(tokenStorage.getAccessToken()).toBe("access-2");
    expect(tokenStorage.getRefreshToken()).toBeNull();
  });
});

describe("schema-bound admin API helpers", () => {
  it("rejects invalid request bodies before sending and parses response data", async () => {
    const bodySchema = z.strictObject({ name: z.string().min(1) });
    const responseSchema = z.strictObject({ id: z.string(), name: z.string() });
    const postSpy = vi.spyOn(request, "post").mockResolvedValue({
      data: { code: 0, message: "ok", data: { id: "product-1", name: "Tea" } },
    });

    await expect(
      postContract("/products", bodySchema, responseSchema, {
        name: "Tea",
      }),
    ).resolves.toEqual({ id: "product-1", name: "Tea" });

    await expect(
      postContract("/products", bodySchema, responseSchema, {
        name: "Tea",
        unsupported: true,
      } as z.input<typeof bodySchema> & { unsupported: boolean }),
    ).rejects.toThrow("Admin API contract validation failed");

    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects extra wire fields through a shared Admin response contract", async () => {
    const contract = defineAdminApiResponseContract({
      method: "POST",
      path: "/media-assets/example",
      responseSchema: z.strictObject({ id: z.string() }),
    });
    const postSpy = vi.spyOn(request, "post").mockResolvedValue({
      data: {
        code: 0,
        message: "ok",
        data: { id: "asset-1", storageKey: "private/key.png" },
      },
    });

    await expect(
      postAdminApiContract(contract, new FormData()),
    ).rejects.toThrow("Admin API contract validation failed");
    expect(postSpy).toHaveBeenCalledWith(
      contract.path,
      expect.any(FormData),
      undefined,
    );
  });
});
