import { describe, expect, it } from "vitest";

import {
  createPinnedPrivateDnsLookup,
  isAllowedInsecureIpAddress,
  resolveServiceApiTransport,
} from "./transport";

describe("Service API transport policy", () => {
  it("rejects credentials embedded in every control-plane URL", () => {
    for (const url of [
      "https://relay-user:relay-password@service-api.example/api",
      "http://relay-user@127.0.0.1:26849/api",
    ]) {
      expect(() => resolveServiceApiTransport(url, true)).toThrow(
        "must not include userinfo",
      );
    }
  });

  it("requires HTTPS unless the explicit insecure exception is enabled", () => {
    expect(() =>
      resolveServiceApiTransport("https://service-api.example/api", false),
    ).not.toThrow();
    expect(() =>
      resolveServiceApiTransport("http://127.0.0.1:26849/api", false),
    ).toThrow("HTTPS is required");
  });

  it("allows explicit insecure HTTP only for private relay destinations", () => {
    for (const url of [
      "http://127.0.0.1:26849/api",
      "http://10.12.0.4/api",
      "http://172.16.9.4/api",
      "http://192.168.1.4/api",
      "http://service-api:26849/api",
    ]) {
      expect(resolveServiceApiTransport(url, true)).toEqual({
        mode: "insecure-http",
        health: "degraded",
        reason: "Service API uses explicitly allowed insecure HTTP",
      });
    }
  });

  it("accepts only contract-authorized IPv6 destination forms", () => {
    for (const url of [
      "http://[::1]:26849/api",
      "http://[::ffff:127.0.0.1]:26849/api",
      "http://[::ffff:10.12.0.4]:26849/api",
    ]) {
      expect(resolveServiceApiTransport(url, true).health).toBe("degraded");
    }

    for (const url of [
      "http://[::ffff:8.8.8.8]/api",
      "http://[fe80::1]/api",
      "http://[fc00::1]/api",
      "http://[fd12:3456::1]/api",
    ]) {
      expect(() => resolveServiceApiTransport(url, true)).toThrow(
        "insecure HTTP destination is not private",
      );
    }
  });

  it("applies the IPv4 policy to dotted IPv4-mapped IPv6 resolver answers", () => {
    expect(isAllowedInsecureIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isAllowedInsecureIpAddress("::ffff:10.12.0.4")).toBe(true);
    expect(isAllowedInsecureIpAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("rejects insecure HTTP for public and non-private destinations", () => {
    for (const url of [
      "http://service-api.example/api",
      "http://8.8.8.8/api",
      "http://172.15.9.4/api",
      "http://172.32.9.4/api",
      "http://169.254.1.4/api",
    ]) {
      expect(() => resolveServiceApiTransport(url, true)).toThrow(
        "insecure HTTP destination is not private",
      );
    }
  });

  it("rejects a trailing-dot hostname instead of treating it as a private single-label destination", () => {
    expect(() =>
      resolveServiceApiTransport("http://service-api.:26849/api", true),
    ).toThrow("trailing dot");
  });

  it("rejects the whole DNS answer set when any A or AAAA address is disallowed", async () => {
    const lookup = createPinnedPrivateDnsLookup(async () => [
      { address: "10.12.0.4", family: 4 },
      { address: "::1", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]);

    await expect(
      new Promise((resolve, reject) => {
        lookup("service-api", { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses);
        });
      }),
    ).rejects.toThrow("resolved to a disallowed address");
  });
});
