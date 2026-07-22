import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildCreateOrderRequest,
  mqttEvidenceProvesNoDispense,
  openFixtureProductFromCatalog,
  refreshAdminAccessToken,
  unwrapServiceApiEnvelope,
  waitForMachineOnline,
  parsePaymentRecoveryGuestArgs,
  selectFixtureSlot,
  validatePaymentRecoveryEvidence,
} from "./payment-recovery-guest-full.mjs";

describe("payment recovery guest full", () => {
  it("publishes its root handoff serial session for recovery", () => {
    const source = readFileSync(
      new URL("./payment-recovery-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /report\.handoffSerialSessionId\s*=\s*required\(/);
    assert.doesNotMatch(source, /controlPlaneSessionId/);
    assert.doesNotMatch(source, /Page\.reload|location\.hash\s*=/);
    assert.doesNotMatch(source, /maintenance-entry-header/);
    assert.doesNotMatch(source, /customer-error-evidence-entry/);
  });
  it("drives create_failure through the provider create gate timeout without release or mock fail", () => {
    const source = readFileSync(
      new URL("./payment-recovery-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /mock-payment-create-gate\/arm/);
    assert.match(source, /mock payment create gate timed out before release/);
    assert.match(source, /mock-payment-create-gate\/open/);
    assert.doesNotMatch(source, /mock-payment-create-gate\/release/);
    assert.doesNotMatch(source, /payments\/mock\/\$\{.*paymentNo.*\}\/fail/);
  });
  it("parses the installed guest contract", () => {
    assert.equal(
      parsePaymentRecoveryGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\input.json",
        "--handoff",
        "C:\\handoff.json",
        "--out",
        "C:\\out.json",
      ]).mode,
      "full",
    );
  });
  it("refreshes the admin token through the existing login path", async () => {
    const calls = [];
    const token = await refreshAdminAccessToken(
      {
        serviceApi: { adminUsername: "seeded-admin", adminPassword: "secret" },
      },
      async (_input, path, options) => {
        calls.push({ path, options });
        return { accessToken: "fresh-token" };
      },
    );
    assert.equal(token, "fresh-token");
    assert.deepEqual(calls[0], {
      path: "/auth/login",
      options: {
        method: "POST",
        body: { username: "seeded-admin", password: "secret" },
      },
    });
  });
  it("unwraps real Service API admin response envelopes", () => {
    assert.deepEqual(unwrapServiceApiEnvelope({ code: 0, data: { id: 17 } }), {
      id: 17,
    });
  });
  it("resolves the fixture slotId from daemon sale-view regardless of its display label", () => {
    assert.deepEqual(
      selectFixtureSlot(
        {
          planogramVersion: "P-7",
          items: [
            {
              slotDisplayLabel: "R1C1",
              slotId: "slot-1",
              inventoryId: "inv-1",
              categoryName: "袜子",
              productName: "商务中筒袜",
            },
          ],
        },
        { slotId: "slot-1", categoryKey: "socks" },
      ),
      {
        slotId: "slot-1",
        categoryKey: "socks",
        inventoryId: "inv-1",
        planogramVersion: "P-7",
      },
    );
  });
  it("derives the fixture category from daemon sale-view when the allocation omits it", () => {
    assert.deepEqual(
      selectFixtureSlot(
        {
          planogramVersion: "P-7",
          items: [
            {
              slotId: "slot-underwear",
              inventoryId: "inv-underwear",
              categoryName: "",
              productName: "男士平角裤",
            },
          ],
        },
        { slotId: "slot-underwear" },
      ),
      {
        slotId: "slot-underwear",
        categoryKey: "underwear",
        inventoryId: "inv-underwear",
        planogramVersion: "P-7",
      },
    );
  });
  it("rejects a fixture category that diverges from Machine Catalog semantics", () => {
    assert.throws(
      () =>
        selectFixtureSlot(
          {
            planogramVersion: "P-7",
            items: [
              {
                slotId: "slot-underwear",
                inventoryId: "inv-underwear",
                categoryName: "",
                productName: "男士平角裤",
              },
            ],
          },
          { slotId: "slot-underwear", categoryKey: "tshirts" },
        ),
      /does not match Machine Catalog category underwear/,
    );
  });
  it("opens the fixture product through its expected Catalog category", async () => {
    const calls = [];
    let selectedCategory = "tshirts";
    const slotId = "slot-socks";
    const productSelector = `[data-test="catalog-product"][data-slot-id=${JSON.stringify(slotId)}]`;
    await openFixtureProductFromCatalog({
      client: { id: "customer" },
      slotId,
      categoryKey: "socks",
      evaluateExpressionFn: async (client, expression) => {
        assert.equal(client.id, "customer");
        if (expression.includes("expectedCategoryAvailable")) {
          return {
            activeCategoryKey: selectedCategory,
            productVisible: false,
            expectedCategoryAvailable: true,
          };
        }
        return {
          activeCategoryKey: selectedCategory,
          productVisible: selectedCategory === "socks",
        };
      },
      activateVisibleSelectorFn: async (_client, selector) => {
        calls.push(selector);
        const category = /data-category-key="([^"]+)"/.exec(selector)?.[1];
        if (category) selectedCategory = category;
      },
    });
    assert.deepEqual(calls, [
      '[data-test="catalog-category"][data-category-key="socks"]:not(:disabled)',
      productSelector,
    ]);
  });
  it("does not use another category when the fixture category is unavailable", async () => {
    await assert.rejects(
      () =>
        openFixtureProductFromCatalog({
          client: { id: "customer" },
          slotId: "slot-socks",
          categoryKey: "socks",
          evaluateExpressionFn: async () => ({
            activeCategoryKey: null,
            productVisible: false,
            expectedCategoryAvailable: false,
          }),
          activateVisibleSelectorFn: async () => {
            throw new Error("must not select another category");
          },
        }),
      /expected Catalog category socks is unavailable/,
    );
  });
  it("builds strict create-order payloads without a slot display label", () => {
    assert.deepEqual(
      buildCreateOrderRequest({
        slotId: "slot-1",
        inventoryId: "inv-1",
        planogramVersion: "P-7",
      }),
      {
        inventoryId: "inv-1",
        quantity: 1,
        planogramVersion: "P-7",
        slotId: "slot-1",
        paymentMethod: "mock",
        paymentProviderCode: "mock",
      },
    );
  });
  it("waits for the matching Service API machine to become online", async () => {
    const statuses = ["starting", "online"];
    const calls = [];
    const machine = await waitForMachineOnline(
      { runtimeBootstrap: { provisioningApiBaseUrl: "http://api" } },
      "MACHINE-17",
      "admin-token",
      {
        query: async (_input, path, options) => {
          calls.push({ path, options });
          return {
            code: 0,
            data: {
              items: [{ code: "MACHINE-17", status: statuses.shift() }],
            },
          };
        },
        wait: async () => {},
        now: (() => {
          let value = 0;
          return () => value++;
        })(),
      },
    );
    assert.equal(machine.status, "online");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.token, "admin-token");
  });
  it("fails after a finite wait when the machine never becomes online", async () => {
    await assert.rejects(
      waitForMachineOnline(
        { runtimeBootstrap: { provisioningApiBaseUrl: "http://api" } },
        "MACHINE-17",
        "admin-token",
        {
          timeoutMs: 1,
          query: async () => ({
            items: [{ code: "MACHINE-17", status: "offline" }],
          }),
          wait: async () => {},
          now: (() => {
            let value = 0;
            return () => value++;
          })(),
        },
      ),
      /did not become online/,
    );
  });
  it("requires real dispense-topic evidence that recovery did not vend", () => {
    assert.equal(
      mqttEvidenceProvesNoDispense({
        mqtt: { topic: "vem/machines/M-1/commands/dispense", messages: [] },
      }),
      true,
    );
    assert.equal(
      mqttEvidenceProvesNoDispense({
        mqtt: {
          topic: "vem/machines/M-1/commands/dispense",
          messages: [{ payload: { commandNo: "VEND-1" } }],
        },
      }),
      false,
    );
  });
  it("requires production recovery boundaries and no duplicate dispense", () => {
    const report = recoveryReport();
    assert.deepEqual(validatePaymentRecoveryEvidence(report), {
      paymentId: "pay-1",
      action: "query_payment",
      duplicatePaymentCount: 0,
      attemptCount: 4,
    });
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          recoveryMqttEvidence: {
            mqtt: {
              topic: "vem/machines/M-1/commands/dispense",
              messages: [{ payload: { commandNo: "CMD-1" } }],
            },
          },
        }),
      /MQTT/,
    );
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          assertions: { duplicatePaymentCount: 1, dispenseStarted: false },
        }),
      /duplicate/,
    );
  });

  it("requires every recovery attempt to reach its terminal state without retaining a reservation", () => {
    const report = recoveryReport();

    assert.equal(validatePaymentRecoveryEvidence(report).attemptCount, 4);
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          attempts: report.attempts.map((attempt, index) =>
            index === 2
              ? {
                  ...attempt,
                  reservation: {
                    ...attempt.reservation,
                    terminal: {
                      ...attempt.reservation.terminal,
                      activeRows: 1,
                    },
                  },
                }
              : attempt,
          ),
        }),
      /reservation baseline/,
    );
  });

  it("rejects create_failure evidence that releases the gate or leaves daemon state", () => {
    const report = recoveryReport();
    const createFailure = report.attempts.find(
      (attempt) => attempt.kind === "create_failure",
    );
    createFailure.createGate.released = true;
    assert.throws(
      () => validatePaymentRecoveryEvidence(report),
      /durable technical evidence/,
    );
  });

  it("rejects report-only customer copy and locally invented correlations", () => {
    const report = recoveryReport();
    assert.throws(
      () =>
        validatePaymentRecoveryEvidence({
          ...report,
          attempts: report.attempts.map((attempt) =>
            attempt.kind === "create_failure"
              ? attempt
              : {
                  ...attempt,
                  customer: { saleable: true, semanticChineseOnly: true },
                  technicalEvidence: { correlationId: `local:${attempt.kind}` },
                },
          ),
        }),
      /customer surface|correlation/,
    );
  });

  it("requires observed customer UI text to contain stable copy without raw technical detail", () => {
    const report = recoveryReport();
    const queryFailure = report.attempts.find(
      (attempt) => attempt.kind === "query_failure",
    );
    queryFailure.customer.text = "订单已关闭 provider query_failed over HTTP";

    assert.throws(
      () => validatePaymentRecoveryEvidence(report),
      /customer surface|correlation/,
    );
  });

  it("accepts raw create failure evidence from the installed runtime trace, not the customer DOM", () => {
    const report = recoveryReport();
    const createFailure = report.attempts.find(
      (attempt) => attempt.kind === "create_failure",
    );
    createFailure.technicalEvidence.runtimeTrace.entry = {
      id: 1,
      technicalMessage: "mock payment create gate timed out before release",
    };
    delete createFailure.technicalEvidence.localOperations;

    assert.equal(validatePaymentRecoveryEvidence(report).attemptCount, 4);
  });
});

function recoveryReport() {
  const terminalByKind = {
    create_failure: {
      paymentStatus: "failed",
      orderStatus: "canceled",
      paymentState: "payment_failed",
      resultKind: "payment_failed",
      customerCopy: "支付订单创建失败，请稍后重试",
    },
    query_failure: {
      paymentStatus: "canceled",
      orderStatus: "canceled",
      paymentState: "canceled",
      resultKind: "closed",
      customerCopy: "订单已关闭",
    },
    canceled: {
      paymentStatus: "canceled",
      orderStatus: "canceled",
      paymentState: "canceled",
      resultKind: "closed",
      customerCopy: "订单已关闭",
    },
    expired: {
      paymentStatus: "expired",
      orderStatus: "payment_expired",
      paymentState: "payment_expired",
      resultKind: "payment_expired",
      customerCopy: "支付超时",
    },
  };
  return {
    schemaVersion: "vem-payment-recovery-guest-full/v1",
    ok: true,
    handoffSerialSessionId: "payment-recovery-serial-session",
    inventory: { id: "inventory-1" },
    payment: { id: "pay-1" },
    recoveryMqttEvidence: {
      mqtt: { topic: "vem/machines/M-1/commands/dispense", messages: [] },
    },
    attempts: Object.entries(terminalByKind).map(([kind, terminal]) => ({
      kind,
      ...(kind === "create_failure"
        ? { idempotencyKey: "checkout:create-failure" }
        : {}),
      order: { id: `order-${kind}`, paymentId: `pay-${kind}` },
      payment: { id: `pay-${kind}`, paymentNo: `payment-${kind}` },
      expectedTerminal: terminal,
      reservation: {
        quantity: 1,
        baseline: { onHandQty: 3, reservedQty: 0, activeRows: 0 },
        active: {
          onHandQty: 3,
          reservedQty: 1,
          activeRows: 1,
          orderReservationRows: 1,
          row: { id: `reservation-${kind}`, status: "active" },
        },
        terminal: {
          onHandQty: 3,
          reservedQty: 0,
          activeRows: 0,
          orderReservationRows: 1,
          row: { id: `reservation-${kind}`, status: "released" },
        },
      },
      daemon:
        kind === "create_failure"
          ? {
              active: null,
              terminal: {
                orderId: null,
                paymentId: null,
                paymentStatus: null,
                nextAction: null,
              },
            }
          : {
              active: { orderId: `order-${kind}`, paymentId: `pay-${kind}` },
              terminal: {
                orderId: `order-${kind}`,
                paymentId: `pay-${kind}`,
                paymentStatus: terminal.paymentStatus,
              },
            },
      terminal: {
        paymentStatus: terminal.paymentStatus,
        orderStatus: terminal.orderStatus,
        paymentState: terminal.paymentState,
      },
      customer:
        kind === "create_failure"
          ? {
              source: "installed_machine_runtime_cdp",
              checkoutAttemptIdempotencyKey: "checkout:create-failure",
              stage: "payment_creation",
              text: terminal.customerCopy,
            }
          : {
              source: "installed_machine_runtime_cdp",
              orderId: `order-${kind}`,
              paymentId: `pay-${kind}`,
              resultKind: terminal.resultKind,
              text: terminal.customerCopy,
            },
      technicalEvidence:
        kind === "create_failure"
          ? {
              providerCreate: {
                source: "mock_provider_create_gate",
                paymentNo: `payment-${kind}`,
                error: "mock payment create gate timed out before release",
              },
              runtimeTrace: {
                source: "installed_machine_runtime_trace_cdp",
                checkoutAttemptIdempotencyKey: "checkout:create-failure",
                entry: {
                  id: 1,
                  technicalMessage:
                    "mock payment create gate timed out before release",
                },
              },
            }
          : {
              runtimeTrace: {
                source: "installed_machine_runtime_trace_cdp",
                orderId: `order-${kind}`,
                paymentId: `pay-${kind}`,
                resultKind: terminal.resultKind,
                entry: { id: 1 },
              },
            },
      ...(kind === "create_failure"
        ? {
            createGate: {
              source: "mock_provider_create_gate",
              paymentNo: `payment-${kind}`,
              released: false,
              openedAfterFailure: true,
              error: "mock payment create gate timed out before release",
            },
          }
        : {}),
      ...(kind === "query_failure"
        ? {
            recovery: {
              queryFault: {
                source: "mock_provider_query_fault_boundary",
                paymentNo: `payment-${kind}`,
              },
              reconciliationAttempt: {
                paymentId: `pay-${kind}`,
                status: "network_error",
                errorCode: "query_failed",
              },
              closeAction: { action: "close_or_reverse_uncertain_payment" },
            },
          }
        : {}),
      ...(kind === "expired"
        ? {
            expiryInjection: {
              source: "testbed_payment_expiry_time_injection",
              beforePaymentStatus: "pending",
            },
          }
        : {}),
      assertions: { duplicatePaymentCount: 0 },
    })),
    subsequentSale: {
      order: {
        id: "order-paid",
        paymentId: "pay-paid",
        inventoryId: "inventory-1",
      },
      inventory: { beforeOnHandQty: 3, afterOnHandQty: 2, movementCount: 1 },
      terminal: {
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
        fulfillmentState: "dispensed",
      },
      serial: { protocol: ["VEND", "F0", "F1", "F2"], stopped: true },
    },
    assertions: { duplicatePaymentCount: 0 },
  };
}
