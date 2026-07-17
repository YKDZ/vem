import { expect, test } from "@playwright/test";

const timestamp = "2026-07-17T08:00:00.000Z";
const identityKey = "container:11111111-2222-3333-4444-555555555555";

function effectiveRuntimeConfiguration(claimed: boolean) {
  const profile = {
    machine: {
      id: "550e8400-e29b-41d4-a716-446655440001",
      code: "M001",
      name: "Machine E2E",
      status: "online",
      locationLabel: "Test lab",
    },
    apiBaseUrl: "http://127.0.0.1:3000/api",
    runtimeEndpoints: {
      apiBasePath: "/api",
      machineAuthTokenPath: "/api/machine-auth/token",
      machineApiBasePath: "/api/machines/M001",
      mqttTopicPrefix: "vem/machines/M001",
    },
    mqttConnection: {
      url: "mqtt://127.0.0.1:1883",
      clientId: "vem-machine-M001",
      username: "machine",
    },
    hardwareProfile: {
      profile: "production",
      controller: { required: true, protocol: "vem-vending-controller" },
      paymentScanner: { required: true, supportsPaymentCode: true },
      vision: { required: false, supportsRecommendations: true },
    },
    hardwareModel: "vem-prod-24",
    hardwareSlotTopology: { identity: "vem-prod-24", version: "v1" },
    paymentCapability: {
      profile: "production",
      qrCodeEnabled: true,
      paymentCodeEnabled: true,
      serverTime: timestamp,
    },
    metadata: {
      profileVersion: 1,
      profileRevision: 7,
      claimCodeId: "550e8400-e29b-41d4-a716-446655440002",
      claimedAt: timestamp,
      serverTime: timestamp,
    },
  };
  const profileCache = claimed
    ? { schemaVersion: 1, generation: 2, acceptedAt: timestamp, profile }
    : null;
  return {
    schemaVersion: 1,
    generation: claimed ? 2 : 1,
    sourceRevisions: {
      bootstrapSchemaVersion: 1,
      profile: claimed
        ? { generation: 2, profileRevision: 7, acceptedAt: timestamp }
        : null,
      localSettingsRevision: 3,
    },
    sourceDocuments: {
      bootstrap: {
        schemaVersion: 1,
        provisioningApiBaseUrl: "http://127.0.0.1:3000/api",
        hardwareModel: "vem-prod-24",
        topology: { identity: "vem-prod-24", version: "v1" },
      },
      profileCache,
    },
    machine: claimed ? profile.machine : null,
    platform: claimed
      ? {
          apiBaseUrl: profile.apiBaseUrl,
          runtimeEndpoints: profile.runtimeEndpoints,
          mqttConnection: profile.mqttConnection,
          paymentCapability: profile.paymentCapability,
        }
      : null,
    hardware: {
      model: "vem-prod-24",
      topology: { identity: "vem-prod-24", version: "v1" },
      expectedProfile: claimed ? profile.hardwareProfile : null,
      lowerControllerBinding: null,
      scannerBinding: null,
      scannerProtocol: { baudRate: 9600, frameSuffix: "crlf" },
    },
    experience: {
      audio: {
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      },
    },
    secretStatus: {
      machineSecretConfigured: true,
      mqttSigningSecretConfigured: true,
      mqttPasswordConfigured: true,
    },
    profileRefresh: {
      status: claimed ? "accepted" : "unclaimed",
      lastError: null,
    },
  };
}

const health = {
  status: "healthy",
  process: {
    component: "daemon",
    level: "ok",
    code: "READY",
    message: "daemon ready",
    updatedAt: timestamp,
  },
  components: [],
  configConfigured: true,
  databaseOnline: true,
  backendOnline: true,
  mqttConnected: true,
  outboxSize: 0,
  outboxMax: 10,
  hardwareOnline: true,
  scannerOnline: true,
  visionOnline: false,
  remoteOpsActive: false,
  currentTransaction: null,
  operatorReason: "ready",
  updatedAt: timestamp,
};

const ready = {
  ready: false,
  updatedAt: timestamp,
};

const noCurrentTransaction = {
  orderId: null,
  orderNo: null,
  productSummary: null,
  paymentId: null,
  paymentNo: null,
  paymentMethod: null,
  paymentProvider: null,
  paymentUrl: null,
  paymentStatus: null,
  orderStatus: null,
  totalAmountCents: null,
  vending: null,
  nextAction: null,
  maskedAuthCode: null,
  paymentCodeAttempt: null,
  expiresAt: null,
  errorCode: null,
  errorMessage: null,
  operatorHint: null,
  updatedAt: timestamp,
};

const saleStartCapability = {
  generation: "playwright-daemon",
  revision: 1,
  observedAt: timestamp,
  canStartSale: false,
  blockers: [
    {
      code: "PLATFORM_UNREACHABLE",
      component: "platform",
      message: "platform unavailable",
    },
  ],
  degradations: [],
  paymentOptions: {
    ready: true,
    defaultOptionKey: "qr_code:alipay",
    defaultProviderCode: "alipay",
    options: [
      {
        optionKey: "qr_code:alipay",
        providerCode: "alipay",
        method: "qr_code",
        displayName: "支付宝",
        description: "扫码支付",
        icon: "alipay",
        recommended: true,
        ready: true,
        disabledReason: null,
      },
    ],
  },
};

function deviceBindings() {
  const identity = {
    identityKey,
    instanceId: "USB\\VID_1234&PID_5678\\SCAN-001",
    containerId: "11111111-2222-3333-4444-555555555555",
    hardwareIds: ["USB\\VID_1234&PID_5678"],
    serialNumber: "SCAN-001",
  };
  return {
    roles: [
      {
        role: "lower_controller",
        binding: null,
        currentPort: null,
        ready: false,
        code: "DEVICE_BINDING_REQUIRED",
        message: "select lower controller",
        ambiguous: false,
        ambiguityKind: null,
        ambiguityPorts: [],
        legacyPortHint: null,
        candidates: [],
        discoveryDiagnostics: [],
      },
      {
        role: "scanner",
        binding: {
          identity,
          confirmedAt: timestamp,
          confirmedBy: "operator",
          testEvidenceCode: "SCANNER_READY",
        },
        currentPort: "COM7",
        ready: true,
        code: "DEVICE_BINDING_READY",
        message: "scanner ready",
        ambiguous: false,
        ambiguityKind: null,
        ambiguityPorts: [],
        legacyPortHint: "COM3",
        candidates: [
          {
            identity,
            currentPort: "COM7",
            friendlyName: "Payment scanner",
            readiness: "ready",
            readinessCode: "SCANNER_READY",
            readinessMessage: "scanner ready",
          },
        ],
        discoveryDiagnostics: [],
      },
    ],
  };
}

test("clean bootstrap claims in Local Operations and uses direct configuration intents", async ({
  page,
}) => {
  let claimed = false;
  const requests: string[] = [];

  await page.route("http://127.0.0.1:7891/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    const response = (payload: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });

    if (url.pathname === "/healthz") return response(health);
    if (url.pathname === "/readyz") return response(ready);
    if (url.pathname === "/v1/runtime-configuration") {
      return response(effectiveRuntimeConfiguration(claimed));
    }
    if (url.pathname === "/v1/transactions/current")
      return response(noCurrentTransaction);
    if (url.pathname === "/v1/sale-start-capability") {
      return response(saleStartCapability);
    }
    if (
      url.pathname === "/v1/provisioning/claim" &&
      request.method() === "POST"
    ) {
      expect(request.postDataJSON()).toEqual({ claimCode: "CLAIM-001" });
      claimed = true;
      return response({
        status: "provisioned",
        machineCode: "M001",
        restartRequested: false,
      });
    }
    if (url.pathname === "/v1/network/available") {
      return response({
        status: "available",
        networks: [
          {
            ssid: "Venue-Wifi",
            signalQuality: 80,
            security: "wpa2_personal",
            connected: false,
            profileSaved: false,
          },
        ],
        operatorGuidance: "",
        updatedAt: timestamp,
      });
    }
    if (url.pathname === "/v1/stock/maintenance-task") {
      return response({
        taskId: "stock-1",
        mode: "routine_refill",
        status: "ready",
        slots: [],
      });
    }
    if (url.pathname === "/v1/hardware-bindings")
      return response(deviceBindings());
    if (url.pathname === "/v1/hardware-bindings/scanner/test") {
      return response({
        role: "scanner",
        identityKey,
        currentPort: "COM7",
        success: true,
        code: "SCANNER_READY",
        message: "scanner ready",
        testedAt: timestamp,
        testEvidenceToken: "550e8400-e29b-41d4-a716-446655440099",
        testEvidenceExpiresAt: "2026-07-17T09:00:00.000Z",
        observationRevision: `sha256:${"a".repeat(64)}`,
        configRevision: `sha256:${"b".repeat(64)}`,
      });
    }
    if (
      url.pathname ===
      "/v1/runtime-configuration/intents/hardware-bindings/scanner/confirm"
    ) {
      return response({
        binding: deviceBindings().roles[1].binding,
        currentPort: "COM7",
        ready: true,
        code: "DEVICE_BINDING_ACTIVATED",
        message: "bound",
        unrelatedRuntimeRestarted: false,
      });
    }
    if (
      url.pathname ===
      "/v1/runtime-configuration/intents/hardware-bindings/scanner/clear"
    )
      return response(effectiveRuntimeConfiguration(claimed));
    if (
      url.pathname ===
      "/v1/runtime-configuration/intents/scanner-protocol-parameters"
    )
      return response(effectiveRuntimeConfiguration(claimed));
    if (url.pathname === "/v1/sync/status")
      return response({
        mqttRunning: true,
        mqttConnected: true,
        brokerUrlMasked: null,
        lastHeartbeatAt: null,
        lastCommandNo: null,
        outboxSize: 0,
        outboxMax: 10,
        outboxUsage: 0,
        nextRetryAt: null,
        lastError: null,
        tlsAuthStatus: null,
      });
    if (url.pathname === "/v1/scanner/status")
      return response({
        online: true,
        adapter: "serial_text",
        port: "COM7",
        level: "ready",
        code: "SCANNER_READY",
        message: "scanner ready",
        updatedAt: timestamp,
      });
    if (url.pathname === "/v1/vision/status")
      return response({
        enabled: false,
        online: false,
        message: "vision unavailable",
        latestDiagnosticPayload: null,
      });
    if (url.pathname === "/v1/natural-context")
      return response({
        status: "unconfigured",
        machineCode: "M001",
        checkedAt: timestamp,
        degraded: false,
        customerFacingBlocked: false,
        externalEnvironment: null,
        localSiteSignals: null,
      });
    if (url.pathname === "/v1/remote-ops/status")
      return response({
        lastPolledAt: null,
        pending: 0,
        lastError: null,
        processing: null,
      });
    if (url.pathname === "/v1/maintenance/payment-environment")
      return response({
        environment: "production",
        readiness: "ready",
        errorCategory: "none",
        channels: [],
      });
    return response({});
  });

  await page.goto("/#/boot");
  await expect(page).toHaveURL(/#\/maintenance$/);
  await expect(page.getByRole("heading", { name: "生产维护" })).toBeVisible();
  await expect(page.getByText("Runtime Bootstrap 所有者")).toBeVisible();
  await expect(page.getByText("Provisioning Profile 所有者")).toBeVisible();
  await expect(page.getByLabel("认领码")).toBeVisible();

  const networkName = page.getByLabel("网络名称");
  await networkName.focus();
  const touchKeyboard = page.locator('[data-test="touch-keyboard"]');
  await expect(touchKeyboard).toBeVisible();
  await page.locator('[data-test="touch-keyboard"] [data-key="q"]').click();
  await expect(networkName).toHaveValue("q");
  await page.locator('[data-test="touch-keyboard-dismiss"]').click();

  await page.getByLabel("认领码").fill("claim-001");
  await page.getByRole("button", { name: "认领机器" }).click();
  await expect(page.getByText("M001")).toBeVisible();

  const scannerBinding = page.locator('[data-test="device-binding-scanner"]');
  await scannerBinding
    .getByRole("button", { name: "测试", exact: true })
    .click();
  await scannerBinding
    .getByRole("button", { name: "确认绑定", exact: true })
    .click();
  await scannerBinding
    .getByRole("button", { name: "清除绑定", exact: true })
    .click();
  const protocol = page.getByLabel("扫码器协议");
  await protocol.locator("input[type=number]").fill("115200");
  await protocol.locator("select").selectOption("lf");
  await protocol.getByRole("button", { name: "应用扫码器协议" }).click();

  expect(requests).toContain("POST /v1/provisioning/claim");
  expect(requests).toContain(
    "POST /v1/runtime-configuration/intents/hardware-bindings/scanner/confirm",
  );
  expect(requests).toContain(
    "POST /v1/runtime-configuration/intents/hardware-bindings/scanner/clear",
  );
  expect(requests).toContain(
    "POST /v1/runtime-configuration/intents/scanner-protocol-parameters",
  );

  await page.goto("/#/boot");
  await expect(page).toHaveURL(/#\/catalog$/);
});
