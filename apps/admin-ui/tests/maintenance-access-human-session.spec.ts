import { expect, test } from "@playwright/test";

const MAINTAINER_ID = "550e8400-e29b-41d4-a716-446655440001";
const MACHINE_ID = "550e8400-e29b-41d4-a716-446655440002";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440003";
const MACHINE_PEER_ID = "550e8400-e29b-41d4-a716-446655440004";

const maintainerPeer = {
  id: MAINTAINER_ID,
  role: "maintainer",
  publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  tunnelAddress: "10.91.2.10",
};
const targetMachine = {
  id: MACHINE_ID,
  code: "VEM-HUMAN-01",
  name: "Windows testbed",
  maintenancePeerId: MACHINE_PEER_ID,
  tunnelAddress: "10.91.16.10",
};
const relayPeer = {
  id: "550e8400-e29b-41d4-a716-446655440010",
  role: "relay",
  publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
  tunnelAddress: "10.91.0.1",
};

function session(status: "active" | "revoked" = "active") {
  return {
    id: SESSION_ID,
    kind: "human",
    actor: {
      type: "admin",
      adminUserId: "550e8400-e29b-41d4-a716-446655440005",
    },
    relayPeer,
    sourcePeer: maintainerPeer,
    targetMachine,
    protocol: "tcp",
    port: 22,
    reason: "Investigate Windows runtime failure",
    issuedAt: "2026-07-10T12:00:00.000Z",
    expiresAt: "2026-07-10T12:30:00.000Z",
    activatedAt: "2026-07-10T12:00:01.000Z",
    expiredAt: null,
    failedAt: null,
    failure: null,
    revokedAt: status === "revoked" ? "2026-07-10T12:05:00.000Z" : null,
    status,
    relayConvergence: {
      desiredStateVersion: 13,
      appliedDesiredStateVersion: 13,
      state: status === "revoked" ? "removed" : "applied",
    },
  };
}

function overview(sessions: ReturnType<typeof session>[]) {
  const active = sessions.filter((item) => item.status === "active");
  return {
    schemaVersion: "maintenance-access-overview/v1",
    sourcePeers: [maintainerPeer],
    targetMachines: [targetMachine],
    peerHealth: [
      {
        peer: maintainerPeer,
        relayApplied: true,
        lastHandshakeAt: "2026-07-10T12:00:01.000Z",
        health: "healthy",
      },
    ],
    sessions,
    desiredState: {
      schemaVersion: "maintenance-relay-desired-state/v1",
      desiredStateVersion: 13,
      generatedAt: "2026-07-10T12:00:01.000Z",
      peers: [
        maintainerPeer,
        {
          id: MACHINE_PEER_ID,
          role: "machine",
          publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
          tunnelAddress: "10.91.16.10",
        },
      ],
      authorizations: active.map((item) => ({
        sessionId: item.id,
        sourcePeerId: MAINTAINER_ID,
        sourceTunnelAddress: "10.91.2.10",
        targetMachineId: MACHINE_ID,
        targetTunnelAddress: "10.91.16.10",
        protocol: "tcp",
        port: 22,
        expiresAt: item.expiresAt,
      })),
    },
    observedState: {
      schemaVersion: "maintenance-relay-observed-state/v1",
      observedAt: "2026-07-10T12:00:01.000Z",
      desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
      appliedDesiredStateVersion: 13,
      attemptedDesiredStateVersion: null,
      appliedPeerIds: [MAINTAINER_ID, MACHINE_PEER_ID],
      appliedAuthorizationIds: active.map((item) => item.id),
      peerObservations: [
        {
          peerId: MAINTAINER_ID,
          latestHandshakeAt: "2026-07-10T12:00:01.000Z",
        },
        { peerId: MACHINE_PEER_ID, latestHandshakeAt: null },
      ],
      activeAuthorizationObservations: active.map((item) => ({
        sessionId: item.id,
        expiresAt: item.expiresAt,
      })),
      transport: {
        mode: "insecure-http",
        health: "degraded",
        reason: "Private test transport exception",
      },
      failure: null,
    },
    relayHealth: {
      observation: "current",
      overall: "degraded",
      stale: false,
      observedAt: "2026-07-10T12:00:01.000Z",
    },
    relayFailure: null,
  };
}

test("Admin filters, creates, and revokes a sanitized maintainer session in the browser", async ({
  page,
}) => {
  let sessions: ReturnType<typeof session>[] = [];
  const requestedSessionStatuses: (string | null)[] = [];
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const failedResponses: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      failedResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("vem.admin.accessToken", "browser-maintenance-token");
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) {
      await route.continue();
      return;
    }
    const respond = async (data: unknown) => {
      await route.fulfill({ json: { code: 0, message: "ok", data } });
    };

    if (path === "/api/auth/me") {
      await respond({
        id: "550e8400-e29b-41d4-a716-446655440005",
        username: "maintenance-admin",
        displayName: "Maintenance Admin",
        roles: [],
        permissions: ["maintenanceAccess.read", "maintenanceAccess.write"],
      });
      return;
    }
    if (path === "/api/maintenance-access" && request.method() === "GET") {
      await respond(overview(sessions));
      return;
    }
    if (
      path === "/api/maintenance-access/audit" &&
      request.method() === "GET"
    ) {
      await respond([]);
      return;
    }
    if (
      path === "/api/maintenance-access/sessions" &&
      request.method() === "GET"
    ) {
      const status = new URL(request.url()).searchParams.get("status");
      requestedSessionStatuses.push(status);
      await respond(
        status ? sessions.filter((item) => item.status === status) : sessions,
      );
      return;
    }
    if (
      path === "/api/maintenance-access/sessions" &&
      request.method() === "POST"
    ) {
      const body = request.postDataJSON() as {
        sourcePeerId: string;
        targetMachineId: string;
        reason: string;
        ttlMinutes: number;
      };
      expect(body).toMatchObject({
        sourcePeerId: MAINTAINER_ID,
        targetMachineId: MACHINE_ID,
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
      });
      sessions = [session()];
      await respond(sessions[0]);
      return;
    }
    if (
      path === "/api/maintenance-access/sessions/" + SESSION_ID + "/revoke" &&
      request.method() === "POST"
    ) {
      sessions = [session("revoked")];
      await respond(sessions[0]);
      return;
    }
    await route.fulfill({
      status: 404,
      json: { code: 404, message: "missing", data: null },
    });
  });

  await page.goto("/maintenance-access");
  await expect(page).toHaveURL(/\/maintenance-access$/);
  await page.waitForLoadState("networkidle");
  expect(pageErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  await expect(page.locator("body")).toContainText("来源维护者");
  await expect(page.getByText("10.91.2.10").first()).toBeVisible();
  await expect(page.getByText("非加密 HTTP")).toBeVisible();
  await expect(page.getByText("专用测试传输例外")).toBeVisible();

  await page.locator("textarea").fill("Investigate Windows runtime failure");
  await page.getByRole("button", { name: "创建会话" }).click();
  await page.getByTestId("session-status-filter").click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("活动", { exact: true })
    .click();
  await expect.poll(() => requestedSessionStatuses.at(-1)).toBe("active");
  await expect(
    page.getByRole("cell", { name: "活动", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("已应用").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "提前撤销" })).toBeVisible();
  await page.getByRole("button", { name: "提前撤销" }).click();
  await page.getByTestId("session-status-filter").click();
  await page
    .locator(".ant-select-dropdown:visible")
    .getByText("已撤销", { exact: true })
    .click();
  await expect.poll(() => requestedSessionStatuses.at(-1)).toBe("revoked");
  await expect(
    page.getByRole("cell", { name: "已撤销", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("已移除").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText(
    /private.?key|credential|accessToken|certificatePrivate/i,
  );
});
