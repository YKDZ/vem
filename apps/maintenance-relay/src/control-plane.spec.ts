import type { MaintenanceRelayObservedState } from "@vem/shared/schemas/maintenance-access";

import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";

import { HttpRelayControlPlane } from "./control-plane";

const observed: MaintenanceRelayObservedState = {
  schemaVersion: "maintenance-relay-observed-state/v1",
  observedAt: "2026-07-10T12:00:00.000Z",
  desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
  appliedDesiredStateVersion: 1,
  attemptedDesiredStateVersion: null,
  appliedPeerIds: [],
  appliedAuthorizationIds: [],
  peerObservations: [],
  activeAuthorizationObservations: [],
  transport: { mode: "https", health: "healthy", reason: null },
  failure: null,
};

describe("HTTP relay control plane", () => {
  it("rejects redirects for every control-plane request", async () => {
    const request = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const data = url.endsWith("credential-exchange")
        ? {
            actor: "maintenance_relay",
            accessToken: "relay-token",
            expiresAt: "2026-07-10T13:00:00.000Z",
          }
        : url.endsWith("desired-state")
          ? {
              schemaVersion: "maintenance-relay-desired-state/v1",
              desiredStateVersion: 1,
              generatedAt: "2026-07-10T12:00:00.000Z",
              peers: [],
              authorizations: [],
            }
          : JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ code: 0, data }), {
        headers: { "content-type": "application/json" },
      });
    });
    const controlPlane = new HttpRelayControlPlane(
      "https://service-api.example/api",
      "relay-credential-at-least-thirty-two-bytes",
      request,
    );

    const token = await controlPlane.exchangeCredential();
    await controlPlane.fetchDesiredState(token.accessToken);
    await controlPlane.reportObservedState(token.accessToken, observed);

    expect(request).toHaveBeenCalledTimes(3);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ redirect: "error" });
    }
  });

  it("pins each single-label connection to one validated DNS result and rejects rebinding", async () => {
    const server = createServer((_request, response) => {
      response
        .writeHead(200, {
          connection: "close",
          "content-type": "application/json",
        })
        .end(
          JSON.stringify({
            code: 0,
            data: {
              actor: "maintenance_relay",
              accessToken: "relay-token",
              expiresAt: "2026-07-10T13:00:00.000Z",
            },
          }),
        );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const answers = [
        [{ address: "127.0.0.1", family: 4 as const }],
        [{ address: "8.8.8.8", family: 4 as const }],
      ];
      const resolveDns = vi.fn(async () => answers.shift() ?? []);
      const controlPlane = new HttpRelayControlPlane(
        `http://service-api:${address.port}/api`,
        "relay-credential-at-least-thirty-two-bytes",
        { allowInsecureHttp: true, resolveDns },
      );

      await expect(controlPlane.exchangeCredential()).resolves.toMatchObject({
        accessToken: "relay-token",
      });
      await expect(controlPlane.exchangeCredential()).rejects.toThrow(
        "resolved to a disallowed address",
      );
      expect(resolveDns).toHaveBeenCalledTimes(2);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
