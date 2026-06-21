// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { normalizeRequestParams, tokenStorage } from "./request";

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
