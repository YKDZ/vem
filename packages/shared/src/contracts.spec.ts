import { describe, expect, it } from "vitest";

import {
  HARDWARE_ERROR_HANDLING,
  auditLogPageResponseSchema,
  auditLogResponseSchema,
  adminInventoryMovementPageResponseSchema,
  adminInventoryPageResponseSchema,
  adminInventoryResponseSchema,
  adminPermissionCodeListResponseSchema,
  adminRolePageResponseSchema,
  adminRoleResponseSchema,
  adminUserListQuerySchema,
  adminUserPageResponseSchema,
  adminUserResponseSchema,
  adminMaintenanceWorkOrderResolveRequestSchema,
  adminMaintenanceWorkOrderResponseSchema,
  adminStockReconciliationCaseDetailResponseSchema,
  adminStockReconciliationCasePageResponseSchema,
  adminStockReconciliationResolveRequestSchema,
  adminMachineContractNoBodySchema,
  adminMachineResponseSchema,
  adminMachineSlotResponseSchema,
  adminUserStatuses,
  canonicalJson,
  createAdminUserSchema,
  createMachineSchema,
  createMachineSlotSchema,
  createMachineOrderSchema,
  createInventorySchema,
  createProductVariantSchema,
  createProductSchema,
  createProtectedFulfillmentDrillSchema,
  createProtectedPaymentDrillSchema,
  createRoleSchema,
  dashboardSalesTrendResponseSchema,
  dashboardSummarySchema,
  dashboardTopProductsResponseSchema,
  dispenseCommandPayloadSchema,
  hardwareErrorCodes,
  environmentControlCommandPayloadSchema,
  environmentControlResultPayloadSchema,
  heartbeatPayloadSchema,
  machineReportedRuntimeConfigurationSchema,
  machineEnvironmentControlRequestSchema,
  machineAuthTokenRequestSchema,
  machineClaimRequestSchema,
  generateMachineClaimCodeRequestSchema,
  generateMachineClaimCodeResponseSchema,
  machineClaimCodeListResponseSchema,
  machineClaimCodeSnapshotSchema,
  machineClaimCodePurposes,
  machineClaimCodeStates,
  machineProvisioningProfileSchema,
  machinePlanogramVersionSnapshotSchema,
  machinePaymentOptionsResponseSchema,
  machineSaleViewItemSchema,
  machineSlotStatuses,
  formatMachineSlotCoordinate,
  isValidMachineSlotCoordinate,
  getMachineSlotMaxCellNo,
  machineSlotCoordinateCode,
  maintenanceWorkOrderStatuses,
  mqttSignedEnvelopeSchema,
  notificationReadResponseSchema,
  notificationTypeSchema,
  orderInvestigationResponseSchema,
  orderRecoveryActionResponseSchema,
  orderRecoveryActionSchema,
  orderStatuses,
  paymentAdminPageResponseSchema,
  paymentCodeAttemptAdminActionSchema,
  paymentCodeAttemptAdminPageResponseSchema,
  paymentIncidentActionRequestSchema,
  paymentIncidentActionResponseSchema,
  paymentOperatorReasonSchema,
  paymentStatuses,
  paymentCodeAttemptStatuses,
  paymentEventAdminPageResponseSchema,
  paymentProviderConfigSchema,
  paymentProviderConfigListResponseSchema,
  paymentProviderNotifyUrlCheckSchema,
  paymentProviderNotifyUrlCheckListResponseSchema,
  paymentChannelPolicyResponseSchema,
  supportedPaymentChannelKeys,
  updatePaymentChannelPolicySchema,
  paymentProviderListResponseSchema,
  paymentMachinePreflightSchema,
  externalNaturalEnvironmentSchema,
  updateAdminUserSchema,
  updateProductSchema,
  updateProductVariantSchema,
  updateMachineSchema,
  paymentCodeAttemptQuerySchema,
  paymentCodeSubmitResponseSchema,
  paymentCodeSubmitSchema,
  paymentOpsMetricsSchema,
  paymentOpsReadinessSchema,
  paymentReconciliationAttemptAdminPageResponseSchema,
  paymentWebhookAttemptAdminPageResponseSchema,
  paymentProviderStatuses,
  paymentProviderSensitiveConfigSchema,
  updatePaymentProviderConfigSchema,
  updatePaymentProviderSchema,
  paymentReconciliationAttemptQuerySchema,
  publishMachinePlanogramVersionSchema,
  protectedFulfillmentDrillRecoveryActionSchema,
  protectedFulfillmentDrillScenarioSchema,
  protectedPaymentDrillRecoveryActionSchema,
  protectedPaymentDrillScenarioSchema,
  roleListQuerySchema,
  roleStatuses,
  rotateMachineCredentialsResponseSchema,
  refillInventorySchema,
  refundAdminPageResponseSchema,
  adjustInventorySchema,
  upsertNotificationTargetSchema,
  upsertPaymentProviderConfigSchema,
  updateRoleSchema,
  wechatPayPublicConfigSchema,
} from "./index";

describe("shared API contract", () => {
  it("uses backend order status values", () => {
    expect(orderStatuses).toContain("pending_payment");
    expect(orderStatuses).toContain("fulfilled");
    expect(orderStatuses).not.toContain("pending");
    expect(orderStatuses).not.toContain("completed");
  });

  it("uses backend status enums for management forms", () => {
    expect(machineSlotStatuses).toEqual(["enabled", "disabled", "faulted"]);
    expect(paymentProviderStatuses).toEqual(["enabled", "disabled"]);
    expect(adminUserStatuses).toEqual(["active", "disabled"]);
    expect(roleStatuses).toEqual(["active", "disabled"]);
  });

  it("defines the global payment channel policy contract", () => {
    expect(supportedPaymentChannelKeys).toEqual([
      "qr_code:alipay",
      "payment_code:alipay",
      "qr_code:wechat_pay",
      "payment_code:wechat_pay",
    ]);

    const payload = {
      channels: supportedPaymentChannelKeys.map((channelKey, index) => ({
        channelKey,
        enabled: channelKey !== "payment_code:wechat_pay",
        rank: index + 1,
      })),
      defaultChannelKey: "qr_code:alipay",
    };

    expect(updatePaymentChannelPolicySchema.parse(payload)).toEqual(payload);
    expect(
      paymentChannelPolicyResponseSchema.parse({
        ...payload,
        updatedAt: "2026-07-08T00:00:00.000Z",
        updatedByAdminUserId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toMatchObject(payload);
    expect(() =>
      updatePaymentChannelPolicySchema.parse({
        channels: [
          ...payload.channels,
          { channelKey: "qr_code:alipay", enabled: true, rank: 5 },
        ],
        defaultChannelKey: "qr_code:alipay",
      }),
    ).toThrow();
    expect(() =>
      updatePaymentChannelPolicySchema.parse({
        channels: payload.channels.map((channel, index) => ({
          ...channel,
          rank: index === 0 ? 2 : channel.rank,
        })),
        defaultChannelKey: "qr_code:alipay",
      }),
    ).toThrow();
    expect(() =>
      updatePaymentChannelPolicySchema.parse({
        channels: payload.channels,
        defaultChannelKey: "qr_code:mock",
      }),
    ).toThrow();
  });

  it("rejects legacy provider-embedded payment-code switches in merchant config write contracts", () => {
    const providerConfigPayload = {
      providerCode: "alipay",
      merchantNo: "2088000000000000",
      appId: "2021000000000000",
      publicConfigJson: {
        mode: "sandbox",
        gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        keyType: "PKCS8",
      },
      status: "enabled",
    };

    expect(
      upsertPaymentProviderConfigSchema.parse(providerConfigPayload),
    ).toMatchObject(providerConfigPayload);
    const { providerCode: _providerCode, ...updateProviderConfigPayload } =
      providerConfigPayload;
    expect(
      updatePaymentProviderConfigSchema.parse(updateProviderConfigPayload),
    ).toEqual(updateProviderConfigPayload);
    expect(() =>
      upsertPaymentProviderConfigSchema.parse({
        ...providerConfigPayload,
        publicConfigJson: {
          ...providerConfigPayload.publicConfigJson,
          paymentCodeEnabled: true,
        },
      }),
    ).toThrow();
    expect(
      updatePaymentProviderConfigSchema.parse({
        ...updateProviderConfigPayload,
        publicConfigJson: {
          ...providerConfigPayload.publicConfigJson,
          paymentCodePollIntervalSeconds: 4,
          paymentCodeMaxConfirmSeconds: 45,
          paymentCodeReverseRetryIntervalSeconds: 2,
          paymentCodeReverseMaxAttempts: 3,
        },
      }),
    ).toEqual({
      ...updateProviderConfigPayload,
      publicConfigJson: {
        ...providerConfigPayload.publicConfigJson,
        paymentCodePollIntervalSeconds: 4,
        paymentCodeMaxConfirmSeconds: 45,
        paymentCodeReverseRetryIntervalSeconds: 2,
        paymentCodeReverseMaxAttempts: 3,
      },
    });
    expect(
      upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        status: "disabled",
        publicConfigJson: {
          paymentCodeSignType: "HMAC-SHA256",
          paymentCodeDeviceInfo: "POS-001",
        },
      }),
    ).toMatchObject({
      publicConfigJson: {
        paymentCodeSignType: "HMAC-SHA256",
        paymentCodeDeviceInfo: "POS-001",
      },
    });
  });

  it("keeps admin identity and role contracts strict", () => {
    expect(
      createAdminUserSchema.parse({
        username: "ops01",
        password: "StrongPassword123",
        displayName: "Ops User",
        roleIds: ["550e8400-e29b-41d4-a716-446655440001"],
      }),
    ).toMatchObject({ status: "active" });
    expect(() =>
      createAdminUserSchema.parse({
        username: "ops01",
        password: "StrongPassword123",
        displayName: "Ops User",
        unsupported: true,
      }),
    ).toThrow();
    expect(
      updateAdminUserSchema.parse({
        email: null,
        roleIds: ["550e8400-e29b-41d4-a716-446655440001"],
      }),
    ).toEqual({
      email: null,
      roleIds: ["550e8400-e29b-41d4-a716-446655440001"],
    });
    expect(updateAdminUserSchema.parse({ email: null })).toEqual({
      email: null,
    });
    expect(adminUserListQuerySchema.parse({ page: "2" })).toMatchObject({
      page: 2,
      pageSize: 20,
    });

    expect(
      createRoleSchema.parse({
        code: "ops_manager",
        name: "Ops Manager",
        permissionCodes: ["adminUsers.read", "roles.write"],
      }),
    ).toMatchObject({ status: "active" });
    expect(() =>
      createRoleSchema.parse({
        code: "ops_manager",
        name: "Ops Manager",
        permissionCodes: ["roles.write", "roles.write"],
      }),
    ).toThrow();
    expect(() =>
      updateRoleSchema.parse({
        permissionCodes: ["not.a.permission"],
      }),
    ).toThrow();
    expect(() =>
      updateRoleSchema.parse({
        permissionCodes: ["adminUsers.read", "adminUsers.read"],
      }),
    ).toThrow();
    expect(updateRoleSchema.parse({ name: "Ops Lead" })).toEqual({
      name: "Ops Lead",
    });
    expect(roleListQuerySchema.parse({ pageSize: "50" })).toMatchObject({
      page: 1,
      pageSize: 50,
    });
  });

  it("parses admin identity, role, and permission key responses", () => {
    const adminUser = adminUserResponseSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440001",
      username: "ops01",
      displayName: "Ops User",
      mobile: null,
      email: null,
      status: "active",
      roles: ["550e8400-e29b-41d4-a716-446655440010"],
      lastLoginAt: null,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:10:00.000Z",
    });
    expect(adminUser.roles).toEqual(["550e8400-e29b-41d4-a716-446655440010"]);
    expect(() =>
      adminUserResponseSchema.parse({ ...adminUser, passwordHash: "secret" }),
    ).toThrow();
    expect(
      adminUserPageResponseSchema.parse({
        items: [adminUser],
        page: 1,
        pageSize: 20,
        total: 1,
      }).total,
    ).toBe(1);

    const role = adminRoleResponseSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440002",
      code: "ops_manager",
      name: "Ops Manager",
      description: null,
      isBuiltin: false,
      status: "active",
      permissionCodes: ["adminUsers.read", "roles.write"],
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:10:00.000Z",
    });
    expect(role.permissionCodes).toEqual(["adminUsers.read", "roles.write"]);
    expect(
      adminRolePageResponseSchema.parse({
        items: [role],
        page: 1,
        pageSize: 20,
        total: 1,
      }).items,
    ).toHaveLength(1);
    expect(
      adminPermissionCodeListResponseSchema.parse(["roles.write"]),
    ).toEqual(["roles.write"]);
  });

  it("keeps order recovery and maintenance admin actions strict", () => {
    expect(
      orderRecoveryActionSchema.parse({
        action: "confirm_not_dispensed",
        note: "operator found the item still in the slot",
      }),
    ).toEqual({
      action: "confirm_not_dispensed",
      note: "operator found the item still in the slot",
    });
    expect(() =>
      orderRecoveryActionSchema.parse({
        action: "request_refund",
        note: "operator confirmed no dispense",
        directDatabasePatch: true,
      }),
    ).toThrow();

    expect(
      adminMaintenanceWorkOrderResolveRequestSchema.parse({
        resolutionNote: "replaced jammed spring and verified dispense",
      }),
    ).toEqual({
      resolutionNote: "replaced jammed spring and verified dispense",
    });
    expect(() =>
      adminMaintenanceWorkOrderResolveRequestSchema.parse({
        resolutionNote: "   ",
      }),
    ).toThrow();
    expect(() =>
      adminMaintenanceWorkOrderResolveRequestSchema.parse({
        resolutionNote: "resolved",
        status: "closed_by_ui",
      }),
    ).toThrow();
  });

  it("keeps payment incident actions minimal and strict", () => {
    expect(
      paymentIncidentActionRequestSchema.parse({
        action: "close_or_reverse_uncertain_payment",
        reason: "operator confirmed provider still has no successful trade",
      }),
    ).toEqual({
      action: "close_or_reverse_uncertain_payment",
      reason: "operator confirmed provider still has no successful trade",
    });
    expect(
      paymentIncidentActionRequestSchema.parse({
        action: "query_refund",
        refundId: "550e8400-e29b-41d4-a716-446655440041",
        reason: "check refund after provider accepted request",
      }),
    ).toMatchObject({ action: "query_refund" });
    expect(() =>
      paymentIncidentActionRequestSchema.parse({
        action: "query_payment",
        reason: "check uncertain payment",
        rawProviderPayload: { trade_status: "WAIT_BUYER_PAY" },
      }),
    ).toThrow();
    expect(() =>
      paymentIncidentActionRequestSchema.parse({
        action: "query_refund",
        reason: "missing refund id",
      }),
    ).toThrow();

    expect(
      paymentIncidentActionResponseSchema.parse({
        action: "mark_manual_handling",
        status: "manual_handling",
        handled: true,
        message: "已标记人工处理",
        protectedDiagnostics: {
          paymentNo: "PAY-1",
          providerCode: "alipay",
        },
      }),
    ).toMatchObject({
      action: "mark_manual_handling",
      status: "manual_handling",
      handled: true,
    });
  });

  it("names uncertain payment states distinctly", () => {
    expect(paymentStatuses).toContain("unknown");
    expect(paymentCodeAttemptStatuses).toContain("reversal_unknown");
    expect(
      orderInvestigationResponseSchema.parse({
        order: {
          id: "550e8400-e29b-41d4-a716-446655440050",
          orderNo: "ORD-UNCERTAIN",
          machineId: "550e8400-e29b-41d4-a716-446655440051",
          machineCode: "M001",
          status: "manual_handling",
          paymentState: "payment_unknown",
          fulfillmentState: "manual_handling",
          totalAmountCents: 500,
          currency: "CNY",
          paidAt: null,
          dispensedAt: null,
          canceledAt: null,
          createdAt: "2026-07-05T00:00:00.000Z",
        },
        items: [],
        payments: [
          {
            id: "550e8400-e29b-41d4-a716-446655440052",
            paymentNo: "PAY-UNKNOWN",
            orderId: "550e8400-e29b-41d4-a716-446655440050",
            method: "payment_code",
            status: "unknown",
            amountCents: 500,
            expiresAt: null,
            paidAt: null,
            failedReason: "provider query timed out",
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:01:00.000Z",
          },
        ],
        paymentEvents: [],
        paymentWebhookAttempts: [],
        paymentReconciliationAttempts: [],
        paymentCodeAttempts: [
          {
            id: "550e8400-e29b-41d4-a716-446655440053",
            paymentId: "550e8400-e29b-41d4-a716-446655440052",
            orderId: "550e8400-e29b-41d4-a716-446655440050",
            attemptNo: 1,
            idempotencyKey: "idem-1",
            status: "reversal_unknown",
            isActive: true,
            amountCents: 500,
            currency: "CNY",
            authCodeMasked: "2876****4394",
            source: "serial_text",
            submittedAt: "2026-07-05T00:00:10.000Z",
            lastCheckedAt: "2026-07-05T00:00:30.000Z",
            reversedAt: null,
            finishedAt: null,
            manualReason: "provider timeout",
            protectedDiagnostics: {
              providerPaymentNo: "PCA-1",
              providerTradeNo: null,
              providerStatus: "UNKNOWN",
              failureCode: "PAYMENT_CODE_REVERSE_UNKNOWN",
              failureMessage: "撤销结果未知",
            },
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:01:00.000Z",
          },
        ],
        vendingCommands: [],
        fulfillmentProjection: {
          state: "manual_handling",
          latestCommand: null,
          requiresPhysicalOutcomeConfirmation: false,
          availableRecoveryActions: [],
        },
        inventoryMovements: [],
        stockReconciliationLinks: [],
        refunds: [],
        maintenanceWorkOrders: [],
        adminAuditEntries: [],
        orderStatusEvents: [],
      }).payments[0]?.status,
    ).toBe("unknown");
  });

  it("parses key order recovery, maintenance, and notification responses", () => {
    expect(
      orderRecoveryActionResponseSchema.parse({
        action: "compensation_dispense",
        recoveryActionId: "550e8400-e29b-41d4-a716-446655440010",
        commandId: "550e8400-e29b-41d4-a716-446655440011",
        commandNo: "CMD-2",
        status: "pending",
      }),
    ).toMatchObject({ action: "compensation_dispense", commandNo: "CMD-2" });

    expect(
      adminMaintenanceWorkOrderResponseSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440020",
        workOrderNo: "WO-1",
        machineId: "550e8400-e29b-41d4-a716-446655440021",
        slotId: null,
        orderId: "550e8400-e29b-41d4-a716-446655440022",
        commandId: null,
        title: "Dispense failed",
        description: "Slot needs inspection",
        priority: "high",
        status: "resolved",
        assigneeAdminUserId: "550e8400-e29b-41d4-a716-446655440023",
        resolutionNote: "cleared jam",
        createdAt: "2026-07-05T00:00:00.000Z",
        resolvedAt: "2026-07-05T00:10:00.000Z",
      }),
    ).toMatchObject({ status: "resolved", resolutionNote: "cleared jam" });

    expect(
      notificationReadResponseSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440030",
        status: "read",
        updatedAt: "2026-07-05T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "read" });
  });

  it("parses the order investigation drawer recovery response boundary", () => {
    const response = orderInvestigationResponseSchema.parse({
      order: {
        id: "550e8400-e29b-41d4-a716-446655440100",
        orderNo: "ORD-1",
        machineId: "550e8400-e29b-41d4-a716-446655440101",
        machineCode: "M001",
        status: "manual_handling",
        paymentState: "paid",
        fulfillmentState: "manual_handling",
        totalAmountCents: 500,
        currency: "CNY",
        paidAt: "2026-07-05T00:00:00.000Z",
        dispensedAt: null,
        canceledAt: null,
        createdAt: "2026-07-05T00:00:00.000Z",
      },
      items: [],
      payments: [],
      paymentEvents: [],
      paymentWebhookAttempts: [],
      paymentReconciliationAttempts: [],
      paymentCodeAttempts: [],
      vendingCommands: [],
      fulfillmentProjection: {
        state: "manual_handling",
        latestCommand: null,
        requiresPhysicalOutcomeConfirmation: true,
        availableRecoveryActions: ["confirm_dispensed"],
      },
      inventoryMovements: [],
      stockReconciliationLinks: [],
      refunds: [],
      maintenanceWorkOrders: [],
      adminAuditEntries: [],
      orderStatusEvents: [],
    });

    expect(response.fulfillmentProjection.availableRecoveryActions).toEqual([
      "confirm_dispensed",
    ]);
    expect(() =>
      orderInvestigationResponseSchema.parse({
        ...response,
        fulfillmentProjection: {
          ...response.fulfillmentProjection,
          availableRecoveryActions: ["sql_patch"],
        },
      }),
    ).toThrow();
  });

  it("enforces hardware slot coordinate bounds across machine contracts", () => {
    expect(getMachineSlotMaxCellNo(1)).toBe(5);
    expect(getMachineSlotMaxCellNo(6)).toBe(5);
    expect(getMachineSlotMaxCellNo(7)).toBe(4);
    expect(getMachineSlotMaxCellNo(8)).toBe(4);
    expect(getMachineSlotMaxCellNo(9)).toBe(3);
    expect(getMachineSlotMaxCellNo(10)).toBeNull();
    expect(isValidMachineSlotCoordinate({ layerNo: 7, cellNo: 4 })).toBe(true);
    expect(isValidMachineSlotCoordinate({ layerNo: 9, cellNo: 3 })).toBe(true);
    expect(isValidMachineSlotCoordinate({ layerNo: 7, cellNo: 5 })).toBe(false);
    expect(isValidMachineSlotCoordinate({ layerNo: 9, cellNo: 4 })).toBe(false);
    expect(isValidMachineSlotCoordinate({ layerNo: 10, cellNo: 1 })).toBe(
      false,
    );
    expect(formatMachineSlotCoordinate({ layerNo: 7, cellNo: 4 })).toBe(
      "行 7 / 格 4",
    );
    expect(machineSlotCoordinateCode({ layerNo: 7, cellNo: 4 })).toBe("R7C4");

    expect(() =>
      createMachineSlotSchema.parse({
        layerNo: 7,
        cellNo: 5,
        slotCode: "G5",
        capacity: 8,
        status: "enabled",
      }),
    ).toThrow();
    expect(() =>
      dispenseCommandPayloadSchema.parse({
        commandNo: "CMD-1",
        orderNo: "ORD-1",
        slot: { layerNo: 12, cellNo: 1, slotCode: "R12C1" },
        quantity: 1,
        timeoutSeconds: 30,
      }),
    ).toThrow();
  });

  it("uses Machine Location Label in machine write contracts", () => {
    expect(
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        locationLabel: "1F",
      }),
    ).toEqual({
      code: "M001",
      name: "Lobby",
      locationLabel: "1F",
    });
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        locationText: "1F",
      }),
    ).toThrow();
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        locationLabel: "1F",
        status: "online",
      }),
    ).toThrow();
  });

  describe("admin inventory intervention contracts", () => {
    const inventoryId = "550e8400-e29b-41d4-a716-446655440000";
    const machineId = "550e8400-e29b-41d4-a716-446655440001";
    const slotId = "550e8400-e29b-41d4-a716-446655440002";
    const variantId = "550e8400-e29b-41d4-a716-446655440003";

    it("rejects unsupported fields on stock-changing inventory requests", () => {
      expect(() =>
        createInventorySchema.parse({
          machineId,
          slotId,
          variantId,
          onHandQty: 10,
          unsupportedColumn: true,
        }),
      ).toThrow();
      expect(() =>
        refillInventorySchema.parse({
          inventoryId,
          quantity: 5,
          reason: "manual",
        }),
      ).toThrow();
      expect(() =>
        adjustInventorySchema.parse({
          inventoryId,
          deltaQty: -1,
          note: "counted stock",
          onHandQty: 0,
        }),
      ).toThrow();
    });

    it("keeps quantity defaults and optional notes contract-bound", () => {
      expect(
        createInventorySchema.parse({
          machineId,
          slotId,
          variantId,
          onHandQty: 10,
        }),
      ).toEqual({
        machineId,
        slotId,
        variantId,
        onHandQty: 10,
        reservedQty: 0,
        lowStockThreshold: 1,
      });
      expect(refillInventorySchema.parse({ inventoryId, quantity: 2 })).toEqual(
        { inventoryId, quantity: 2 },
      );
      expect(
        adjustInventorySchema.parse({
          inventoryId,
          deltaQty: -1,
        }),
      ).toEqual({
        inventoryId,
        deltaQty: -1,
      });
    });

    it("parses key inventory responses with nullable relationships", () => {
      const inventory = adminInventoryResponseSchema.parse({
        id: inventoryId,
        machineId,
        machineCode: "M001",
        slotId,
        slotCode: "A1",
        variantId,
        productId: "550e8400-e29b-41d4-a716-446655440004",
        sku: "SKU-1",
        productName: "Tea",
        onHandQty: 10,
        reservedQty: 2,
        availableQty: 8,
        lowStockThreshold: 3,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });
      expect(inventory.availableQty).toBe(8);

      const movements = adminInventoryMovementPageResponseSchema.parse({
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440005",
            inventoryId,
            deltaQty: 5,
            reason: "refill",
            orderId: null,
            orderNo: null,
            operatorAdminUserId: null,
            note: null,
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      expect(movements.items[0]?.note).toBeNull();

      expect(
        adminInventoryPageResponseSchema.parse({
          items: [inventory],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.machineCode,
      ).toBe("M001");
    });

    it("parses stock reconciliation resolution variants and response evidence", () => {
      expect(
        adminStockReconciliationResolveRequestSchema.parse({
          action: "reject_machine_stock",
          note: "payload conflicts",
        }),
      ).toEqual({
        action: "reject_machine_stock",
        note: "payload conflicts",
      });
      const manualCorrection =
        adminStockReconciliationResolveRequestSchema.parse({
          action: "manual_correct",
          note: "counted on site",
          correctedOnHandQty: 4,
          clearBlocker: true,
        });
      expect(manualCorrection.action).toBe("manual_correct");
      if (manualCorrection.action !== "manual_correct") {
        throw new Error("expected manual correction resolution");
      }
      expect(manualCorrection.correctedOnHandQty).toBe(4);
      expect(() =>
        adminStockReconciliationResolveRequestSchema.parse({
          action: "manual_correct",
          note: "counted on site",
        }),
      ).toThrow();
      expect(() =>
        adminStockReconciliationResolveRequestSchema.parse({
          action: "accept_machine_stock",
          note: "counted by machine",
          correctedOnHandQty: 4,
        }),
      ).toThrow();
      expect(() =>
        adminStockReconciliationResolveRequestSchema.parse({
          action: "reject_machine_stock",
          note: "   ",
        }),
      ).toThrow();
      expect(() =>
        adminStockReconciliationResolveRequestSchema.parse({
          action: "accept_machine_stock",
          note: "x".repeat(501),
        }),
      ).toThrow();

      const detail = adminStockReconciliationCaseDetailResponseSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440006",
        caseTable: "machine_raw_stock_movements",
        rawMovementId: null,
        machineId,
        machineCode: "M001",
        movementId: "MOVE-1",
        movementType: "stock_count_correction",
        quantity: 4,
        source: "local_maintenance",
        attributedTo: null,
        occurredAt: "2026-06-01T00:00:00.000Z",
        receivedAt: "2026-06-01T00:01:00.000Z",
        reconciliationReason: "weak_attribution",
        platformReviewStatus: "open",
        slot: {
          id: slotId,
          code: "A1",
          status: "enabled",
          saleEligibility: {
            eligible: false,
            slotSalesState: "needs_platform_review",
            reason: "weak_attribution",
          },
        },
        inventory: null,
        blocker: null,
        planogramVersion: "PLAN-1",
        evidence: {
          rawPayload: { movementId: "MOVE-1" },
          normalizedPayload: { movementId: "MOVE-1" },
          inventory: null,
          linkedOrder: null,
          linkedCommand: null,
        },
        resolution: {
          action: "manual_correct",
          note: "counted on site",
          clearedBlocker: true,
          inventoryMovement: {
            inventoryId,
            deltaQty: -2,
            reason: "hardware_sync",
            note: "counted on site",
          },
        },
      });
      expect(detail.resolution?.clearedBlocker).toBe(true);

      expect(
        adminStockReconciliationCasePageResponseSchema.parse({
          items: [
            {
              id: detail.id,
              caseTable: detail.caseTable,
              rawMovementId: detail.rawMovementId,
              machineId: detail.machineId,
              machineCode: detail.machineCode,
              movementId: detail.movementId,
              movementType: detail.movementType,
              quantity: detail.quantity,
              source: detail.source,
              attributedTo: detail.attributedTo,
              occurredAt: detail.occurredAt,
              receivedAt: detail.receivedAt,
              reconciliationReason: detail.reconciliationReason,
              platformReviewStatus: detail.platformReviewStatus,
              slot: detail.slot,
              inventory: detail.inventory,
              blocker: detail.blocker,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.inventory,
      ).toBeNull();
    });
  });

  describe("admin payment operation contracts", () => {
    const configId = "550e8400-e29b-41d4-a716-446655440010";
    const providerId = "550e8400-e29b-41d4-a716-446655440011";

    it("uses strict provider update and operator action contracts", () => {
      expect(
        updatePaymentProviderSchema.parse({
          name: "Wechat Pay",
          status: "enabled",
          capabilities: { qrCode: true },
        }),
      ).toEqual({
        name: "Wechat Pay",
        status: "enabled",
        capabilities: { qrCode: true },
      });

      expect(() =>
        updatePaymentProviderSchema.parse({
          name: "Wechat Pay",
          status: "enabled",
          adminOnlyShortcut: true,
        }),
      ).toThrow();

      expect(
        paymentOperatorReasonSchema.parse({
          reason: "customer sees paid but platform is pending",
        }),
      ).toEqual({
        reason: "customer sees paid but platform is pending",
      });
      expect(() =>
        paymentOperatorReasonSchema.parse({ reason: "   " }),
      ).toThrow();
    });

    it("validates provider-specific public configuration by provider", () => {
      expect(
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "alipay",
          merchantNo: "mch-1",
          appId: "app-1",
          publicConfigJson: {
            mode: "sandbox",
            gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
            keyType: "PKCS8",
            qrExpiresMinutes: 10,
          },
          sensitiveConfigJson: {
            privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
          },
        }).publicConfigJson,
      ).toMatchObject({ mode: "sandbox", keyType: "PKCS8" });

      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "alipay",
          publicConfigJson: {
            mode: "sandbox",
            gatewayUrl: "not-a-url",
          },
          sensitiveConfigJson: {
            privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
          },
        }),
      ).toThrow();

      for (const publicConfigJson of [
        {
          mode: "production",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        },
        {
          mode: "sandbox",
          gatewayUrl: "https://openapi.alipay.com/gateway.do",
        },
      ]) {
        expect(() =>
          upsertPaymentProviderConfigSchema.parse({
            providerCode: "alipay",
            publicConfigJson,
            sensitiveConfigJson: {
              privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
            },
          }),
        ).toThrow(/gateway/i);
      }

      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          publicConfigJson: {
            merchantCertificateSerialNo: "merchant-serial",
            gatewayUrl: "https://alipay.example.com",
          },
          sensitiveConfigJson: {
            platformCertificatePem: "-----BEGIN CERTIFICATE-----\ncert",
          },
        }),
      ).toThrow();
    });

    it("keeps sensitive secret updates optional and named", () => {
      expect(
        updatePaymentProviderConfigSchema.parse({
          merchantNo: null,
          publicConfigJson: {
            qrExpiresMinutes: 5,
          },
        }),
      ).toEqual({
        merchantNo: null,
        publicConfigJson: {
          qrExpiresMinutes: 5,
        },
      });

      expect(
        paymentProviderSensitiveConfigSchema.parse({
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
          apiV3Key: "x".repeat(32),
          apiV2Key: null,
        }),
      ).toEqual({
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
        apiV3Key: "x".repeat(32),
        apiV2Key: null,
      });

      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({
          nestedSecret: { value: "unsupported" },
        }),
      ).toThrow();
    });

    it("limits Contract JSON Field openness to named payment fields", () => {
      const parsed = paymentProviderConfigSchema.parse({
        id: configId,
        providerId,
        providerCode: "wechat_pay",
        providerName: "Wechat Pay",
        machineId: null,
        merchantNo: "mch-1",
        appId: "app-1",
        publicConfigJson: {
          merchantCertificateSerialNo: "merchant-serial",
          platformCertificateSerialNo: "platform-serial",
        },
        derivedNotifyUrl:
          "https://example.com/api/payments/webhooks/wechat_pay",
        secretStatusJson: {
          apiV3Key: {
            configured: true,
            updatedAt: "2026-06-01T00:00:00.000Z",
          },
        },
        status: "enabled",
        updatedByAdminUserId: null,
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      });

      expect(parsed.publicConfigJson).toHaveProperty(
        "merchantCertificateSerialNo",
      );
      expect(() =>
        paymentProviderConfigSchema.parse({
          ...parsed,
          incidentEvidence: { raw: true },
        }),
      ).toThrow();
      expect(() =>
        paymentProviderNotifyUrlCheckSchema.parse({
          providerCode: "wechat_pay",
          notifyUrl: "https://example.com/api/payments/webhooks/wechat_pay",
          usesHttps: true,
          isLocalhost: false,
          pathMatchesWebhookRoute: true,
          reachable: true,
          statusCode: 200,
          errorCode: null,
          checkedAt: "2026-06-01T00:00:00.000Z",
          rawProbe: { open: true },
        }),
      ).toThrow();
      expect(() =>
        wechatPayPublicConfigSchema.parse({ unknownGatewayFlag: true }),
      ).toThrow();
    });

    it("parses payment read response pages through shared contracts", () => {
      const paymentPage = paymentAdminPageResponseSchema.parse({
        items: [
          {
            id: "550e8400-e29b-41d4-a716-446655440101",
            paymentNo: "PAY-1",
            orderId: "550e8400-e29b-41d4-a716-446655440102",
            orderNo: "ORD-1",
            providerCode: "wechat_pay",
            method: "qr_code",
            status: "pending",
            amountCents: 1000,
            paymentUrl: "https://pay.example.com/qrcode",
            expiresAt: null,
            paidAt: null,
            failedReason: null,
            createdAt: "2026-07-05T00:00:00.000Z",
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });
      expect(paymentPage.items[0]?.paymentNo).toBe("PAY-1");

      expect(
        paymentProviderListResponseSchema.parse([
          {
            id: providerId,
            code: "wechat_pay",
            name: "Wechat Pay",
            type: "wechat_pay",
            status: "enabled",
            capabilities: { qrCode: true },
          },
        ])[0]?.capabilities,
      ).toHaveProperty("qrCode");
      expect(
        paymentProviderConfigListResponseSchema.parse([
          {
            id: configId,
            providerId,
            providerCode: "wechat_pay",
            providerName: "Wechat Pay",
            machineId: null,
            merchantNo: "mch-1",
            appId: null,
            publicConfigJson: { qrExpiresMinutes: 10 },
            derivedNotifyUrl:
              "https://example.com/api/payments/webhooks/wechat_pay",
            secretStatusJson: {},
            status: "enabled",
            updatedByAdminUserId: null,
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:00:00.000Z",
          },
        ])[0]?.publicConfigJson,
      ).toHaveProperty("qrExpiresMinutes");
      expect(
        paymentProviderNotifyUrlCheckListResponseSchema.parse([
          {
            providerCode: "wechat_pay",
            notifyUrl: "https://example.com/api/payments/webhooks/wechat_pay",
            usesHttps: true,
            isLocalhost: false,
            pathMatchesWebhookRoute: true,
            reachable: true,
            statusCode: 200,
            errorCode: null,
            checkedAt: "2026-07-05T00:00:00.000Z",
          },
        ]),
      ).toHaveLength(1);
    });

    it("parses payment incident trail response pages through shared contracts", () => {
      expect(
        paymentEventAdminPageResponseSchema.parse({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440201",
              paymentId: "550e8400-e29b-41d4-a716-446655440202",
              paymentNo: "PAY-1",
              orderId: "550e8400-e29b-41d4-a716-446655440203",
              orderNo: "ORD-1",
              providerId,
              providerCode: "wechat_pay",
              eventType: "payment.succeeded",
              providerEventId: null,
              signatureValid: true,
              handledAt: null,
              createdAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.signatureValid,
      ).toBe(true);
      expect(
        paymentWebhookAttemptAdminPageResponseSchema.parse({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440211",
              orderId: null,
              providerCode: null,
              eventKind: "unknown",
              eventType: null,
              paymentNo: null,
              refundNo: null,
              orderNo: null,
              signatureValid: null,
              businessValid: null,
              handled: false,
              duplicate: false,
              failureReason: null,
              remoteIp: null,
              httpStatus: null,
              createdAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.eventKind,
      ).toBe("unknown");
      expect(
        paymentReconciliationAttemptAdminPageResponseSchema.parse({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440221",
              paymentId: "550e8400-e29b-41d4-a716-446655440222",
              paymentNo: "PAY-1",
              orderId: "550e8400-e29b-41d4-a716-446655440223",
              orderNo: "ORD-1",
              providerCode: "wechat_pay",
              trigger: "manual",
              attemptNo: 1,
              status: "pending",
              providerPaymentStatus: null,
              errorCode: null,
              errorMessage: null,
              nextRetryAt: null,
              startedAt: "2026-07-05T00:00:00.000Z",
              finishedAt: null,
              createdAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.trigger,
      ).toBe("manual");
      expect(
        refundAdminPageResponseSchema.parse({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440231",
              refundNo: "REF-1",
              paymentId: "550e8400-e29b-41d4-a716-446655440232",
              orderId: "550e8400-e29b-41d4-a716-446655440233",
              paymentNo: "PAY-1",
              orderNo: "ORD-1",
              providerCode: "wechat_pay",
              status: "processing",
              amountCents: 1000,
              reason: "dispense_failed",
              providerRefundNo: null,
              refundedAt: null,
              latestReconciliationStatus: null,
              latestProviderRefundStatus: null,
              latestReconciliationError: null,
              latestReconciliationAt: null,
              reconciliationAttempts: [],
              createdAt: "2026-07-05T00:00:00.000Z",
              updatedAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.refundNo,
      ).toBe("REF-1");
      expect(
        paymentCodeAttemptAdminPageResponseSchema.parse({
          items: [
            {
              id: "550e8400-e29b-41d4-a716-446655440241",
              orderId: "550e8400-e29b-41d4-a716-446655440242",
              orderNo: "ORD-1",
              paymentNo: "PAY-1",
              providerCode: "wechat_pay",
              attemptNo: 1,
              providerPaymentNo: "PCA-1",
              status: "submitting",
              authCodeMasked: "123***",
              source: "scanner",
              providerTradeNo: null,
              providerStatus: null,
              failureCode: null,
              failureMessage: null,
              manualReason: null,
              submittedAt: null,
              lastCheckedAt: null,
              reversedAt: null,
              finishedAt: null,
              createdAt: "2026-07-05T00:00:00.000Z",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }).items[0]?.attemptNo,
      ).toBe(1);
    });
  });

  it("parses audit and dashboard read responses through shared contracts", () => {
    const auditLog = auditLogResponseSchema.parse({
      id: "550e8400-e29b-41d4-a716-446655440301",
      adminUserId: null,
      action: "orders.recover",
      resourceType: "order",
      resourceId: "550e8400-e29b-41d4-a716-446655440302",
      beforeJson: null,
      afterJson: { action: "confirm_not_dispensed" },
      createdAt: "2026-07-05T00:00:00.000Z",
    });
    expect(
      auditLogPageResponseSchema.parse({
        items: [auditLog],
        total: 1,
        page: 1,
        pageSize: 20,
      }).items[0]?.afterJson,
    ).toHaveProperty("action");
    expect(() =>
      auditLogResponseSchema.parse({ ...auditLog, broadResponseShortcut: {} }),
    ).toThrow();

    expect(
      dashboardSummarySchema.parse({
        todaySalesCents: 1000,
        todayOrderCount: 1,
        lowStockCount: 0,
        onlineMachineCount: 1,
        pendingIssueCount: 0,
      }).todayOrderCount,
    ).toBe(1);
    expect(
      dashboardSalesTrendResponseSchema.parse([
        { date: "2026-07-05", salesCents: 1000, orderCount: 1 },
      ]),
    ).toHaveLength(1);
    expect(
      dashboardTopProductsResponseSchema.parse([
        {
          variantId: "550e8400-e29b-41d4-a716-446655440303",
          productName: "Tea",
          sku: "TEA-1",
          quantity: 1,
          salesCents: 1000,
        },
      ])[0]?.sku,
    ).toBe("TEA-1");
  });

  it("does not apply create defaults to Machine partial update contracts", () => {
    expect(updateMachineSchema.parse({ geoLocation: null })).toEqual({
      geoLocation: null,
    });
  });

  it("uses managed media asset references for product display image writes", () => {
    const displayImageMediaAssetId = "550e8400-e29b-41d4-a716-446655440124";

    expect(
      createProductSchema.parse({
        name: "基础短袖",
        displayImageMediaAssetId,
      }),
    ).toEqual({
      name: "基础短袖",
      displayImageMediaAssetId,
      status: "draft",
      sortOrder: 0,
    });

    expect(() =>
      createProductSchema.parse({
        name: "基础短袖",
        coverImageUrl: "https://example.com/free-form.jpg",
      }),
    ).toThrow();

    expect(
      updateProductSchema.parse({ displayImageMediaAssetId: null }),
    ).toEqual({ displayImageMediaAssetId: null });
  });

  it("uses strict admin Product Variant Catalog write contracts", () => {
    const productId = "550e8400-e29b-41d4-a716-446655440224";
    const tryOnSilhouetteMediaAssetId = "550e8400-e29b-41d4-a716-446655440125";

    expect(
      createProductVariantSchema.parse({
        productId,
        sku: "TSHIRT-M-WHITE",
        priceCents: 1000,
        tryOnSilhouetteMediaAssetId,
      }),
    ).toEqual({
      productId,
      sku: "TSHIRT-M-WHITE",
      priceCents: 1000,
      status: "active",
      tryOnSilhouetteMediaAssetId,
    });

    expect(() =>
      createProductVariantSchema.parse({
        productId,
        sku: "TSHIRT-M-WHITE",
        priceCents: 1000,
        freeFormImageUrl: "https://example.com/free-form.png",
      }),
    ).toThrow();

    expect(
      updateProductVariantSchema.parse({
        costCents: null,
        tryOnSilhouetteMediaAssetId: null,
      }),
    ).toEqual({
      costCents: null,
      tryOnSilhouetteMediaAssetId: null,
    });
  });

  it("validates nullable all-or-nothing Machine Geo Location in machine write contracts", () => {
    expect(
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        geoLocation: {
          latitude: 31.2304,
          longitude: 121.4737,
          timezone: "Asia/Shanghai",
        },
      }).geoLocation,
    ).toEqual({
      latitude: 31.2304,
      longitude: 121.4737,
      timezone: "Asia/Shanghai",
    });
    expect(
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        geoLocation: null,
      }).geoLocation,
    ).toBeNull();
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        geoLocation: { latitude: 31.2304, timezone: "Asia/Shanghai" },
      }),
    ).toThrow();
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        geoLocation: {
          latitude: 91,
          longitude: 121.4737,
          timezone: "Asia/Shanghai",
        },
      }),
    ).toThrow();
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        geoLocation: {
          latitude: 31.2304,
          longitude: 181,
          timezone: "Asia/Shanghai",
        },
      }),
    ).toThrow();
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        geoLocation: {
          latitude: 31.2304,
          longitude: 121.4737,
          timezone: "Shanghai",
        },
      }),
    ).toThrow();
  });

  it("uses strict admin Machine Operations API contracts", () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440001";
    const now = "2026-07-05T00:00:00.000Z";
    const claimCodeSnapshot = {
      id: "550e8400-e29b-41d4-a716-446655440002",
      machineId,
      machineCode: "M001",
      purpose: "reclaim",
      state: "pending",
      expiresAt: "2026-07-05T01:00:00.000Z",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      createdAt: now,
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
    };

    expect(
      adminMachineResponseSchema.parse({
        id: machineId,
        code: "M001",
        name: "Lobby",
        locationLabel: null,
        geoLocation: null,
        status: "offline",
        mqttClientId: null,
        lastSeenAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    ).toEqual({
      id: machineId,
      code: "M001",
      name: "Lobby",
      locationLabel: null,
      geoLocation: null,
      status: "offline",
      mqttClientId: null,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    });

    expect(() =>
      adminMachineResponseSchema.parse({
        id: machineId,
        code: "M001",
        name: "Lobby",
        locationLabel: null,
        geoLocation: null,
        status: "online",
        mqttClientId: null,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
        latestHeartbeatStatus: {
          network: "online",
          mqttConnected: true,
          hardwareStatus: "ok",
          hardwarePortPath: "COM5",
        },
      }),
    ).toThrow();

    expect(() =>
      adminMachineSlotResponseSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440003",
        machineId,
        layerNo: 1,
        cellNo: 1,
        slotCode: "A1",
        capacity: 10,
        status: "enabled",
        inventoryShortcut: true,
      }),
    ).toThrow();
    expect(() =>
      createMachineSlotSchema.parse({
        layerNo: 1,
        cellNo: 1,
        slotCode: "A1",
        capacity: 10,
        status: "enabled",
        inventoryShortcut: true,
      }),
    ).toThrow();
    expect(() =>
      machineEnvironmentControlRequestSchema.parse({
        airConditionerOn: true,
        diagnosticMode: true,
      }),
    ).toThrow();

    expect(generateMachineClaimCodeRequestSchema.parse({})).toEqual({
      purpose: "first_claim",
    });
    expect(
      machineClaimCodeListResponseSchema.parse({
        items: [claimCodeSnapshot],
      }),
    ).toEqual({ items: [claimCodeSnapshot] });
    expect(adminMachineContractNoBodySchema.parse({})).toEqual({});
    expect(() =>
      adminMachineContractNoBodySchema.parse({ reason: "manual" }),
    ).toThrow();
    expect(
      rotateMachineCredentialsResponseSchema.parse({
        machineId,
        machineCode: "M001",
        machineSecret: "m".repeat(32),
        mqttSigningSecret: "s".repeat(32),
        secretVersion: 2,
      }),
    ).toMatchObject({ machineCode: "M001", secretVersion: 2 });
  });

  it("defines External Natural Environment unconfigured as HTTP-success payload", () => {
    expect(
      externalNaturalEnvironmentSchema.parse({
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      }),
    ).toEqual({
      status: "unconfigured",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      checkedAt: "2026-06-30T14:00:00.000Z",
      diagnostic: {
        reason: "machine_geo_location_missing",
        message: "Machine Geo Location is not configured",
      },
    });

    expect(() =>
      externalNaturalEnvironmentSchema.parse({
        status: "ready",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      externalNaturalEnvironmentSchema.parse({
        status: "unconfigured",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
        weather: { status: "ready", temperatureCelsius: 28 },
        sun: { status: "ready", sunriseAt: "2026-06-30T21:00:00.000Z" },
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      }),
    ).toThrow();
  });

  it("defines External Natural Environment ready as normalized weather, sun, and calendar data", () => {
    expect(
      externalNaturalEnvironmentSchema.parse({
        status: "ready",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
        localTime: {
          status: "ready",
          timezone: "Asia/Shanghai",
          localDate: "2026-06-30",
          localClock: "22:00:00",
        },
        weather: {
          status: "ready",
          temperatureCelsius: 28,
          conditionText: "Sunny",
          conditionCode: "305",
          observedAt: "2026-06-30T13:50:00.000Z",
          windScale: 8,
          windSpeedKph: 65,
          weatherConditionClasses: ["strong_wind", "light_rain"],
          primaryWeatherConditionClass: "strong_wind",
        },
        sun: {
          status: "ready",
          sunriseAt: "2026-06-29T21:53:00.000Z",
          sunsetAt: "2026-06-30T10:02:00.000Z",
        },
        calendar: {
          status: "ready",
          localDate: "2026-06-30",
          festivals: [],
          primaryFestival: null,
          solarTerm: null,
        },
      }),
    ).toEqual({
      status: "ready",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      checkedAt: "2026-06-30T14:00:00.000Z",
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: "2026-06-30",
        localClock: "22:00:00",
      },
      weather: {
        status: "ready",
        temperatureCelsius: 28,
        conditionText: "Sunny",
        conditionCode: "305",
        observedAt: "2026-06-30T13:50:00.000Z",
        windScale: 8,
        windSpeedKph: 65,
        weatherConditionClasses: ["strong_wind", "light_rain"],
        primaryWeatherConditionClass: "strong_wind",
      },
      sun: {
        status: "ready",
        sunriseAt: "2026-06-29T21:53:00.000Z",
        sunsetAt: "2026-06-30T10:02:00.000Z",
      },
      calendar: {
        status: "ready",
        localDate: "2026-06-30",
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
      },
    });
  });

  it("defines External Natural Environment stale as normalized cached data with safe diagnostics", () => {
    expect(
      externalNaturalEnvironmentSchema.parse({
        status: "stale",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:10:00.000Z",
        localTime: {
          status: "ready",
          timezone: "Asia/Shanghai",
          localDate: "2026-06-30",
          localClock: "22:10:00",
        },
        weather: {
          status: "stale",
          temperatureCelsius: 28,
          conditionText: "Sunny",
          conditionCode: "100",
          observedAt: "2026-06-30T13:50:00.000Z",
          weatherConditionClasses: ["other"],
          primaryWeatherConditionClass: "other",
          diagnostic: {
            reason: "provider_unavailable",
            message: "External Natural Environment provider is unavailable",
          },
        },
        sun: {
          status: "ready",
          sunriseAt: "2026-06-29T21:53:00.000Z",
          sunsetAt: "2026-06-30T10:02:00.000Z",
        },
        calendar: {
          status: "ready",
          localDate: "2026-06-30",
          festivals: [],
          primaryFestival: null,
          solarTerm: null,
        },
        diagnostic: {
          reason: "provider_unavailable",
          message: "External Natural Environment provider is unavailable",
        },
      }),
    ).toEqual({
      status: "stale",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      checkedAt: "2026-06-30T14:10:00.000Z",
      localTime: {
        status: "ready",
        timezone: "Asia/Shanghai",
        localDate: "2026-06-30",
        localClock: "22:10:00",
      },
      weather: {
        status: "stale",
        temperatureCelsius: 28,
        conditionText: "Sunny",
        conditionCode: "100",
        observedAt: "2026-06-30T13:50:00.000Z",
        weatherConditionClasses: ["other"],
        primaryWeatherConditionClass: "other",
        diagnostic: {
          reason: "provider_unavailable",
          message: "External Natural Environment provider is unavailable",
        },
      },
      sun: {
        status: "ready",
        sunriseAt: "2026-06-29T21:53:00.000Z",
        sunsetAt: "2026-06-30T10:02:00.000Z",
      },
      calendar: {
        status: "ready",
        localDate: "2026-06-30",
        festivals: [],
        primaryFestival: null,
        solarTerm: null,
      },
      diagnostic: {
        reason: "provider_unavailable",
        message: "External Natural Environment provider is unavailable",
      },
    });
  });

  it("accepts structured machine heartbeat payload", () => {
    expect(
      heartbeatPayloadSchema.parse({
        machineCode: "M001",
        reportedAt: "2026-05-05T12:00:00.000Z",
        statusPayload: {
          appVersion: "0.1.0",
          network: "online",
          mqttConnected: true,
          hardwareStatus: "ok",
          localQueueSize: 0,
        },
      }).statusPayload.mqttConnected,
    ).toBe(true);
  });

  it("accepts only safe machine-reported runtime configuration facts", () => {
    const summary = machineReportedRuntimeConfigurationSchema.parse({
      audioCues: {
        enabled: true,
        presenceEnabled: false,
        transactionEnabled: true,
      },
      audioVolume: 72,
      visionRecommendationsEnabled: false,
    });

    expect(summary).toEqual({
      audioCues: {
        enabled: true,
        presenceEnabled: false,
        transactionEnabled: true,
      },
      audioVolume: 72,
      visionRecommendationsEnabled: false,
    });
    expect(() =>
      machineReportedRuntimeConfigurationSchema.parse({
        audioCues: {
          enabled: true,
          presenceEnabled: true,
          transactionEnabled: true,
        },
        audioVolume: 40,
        visionRecommendationsEnabled: true,
        visionWsUrl: "ws://127.0.0.1:7892/ws",
      }),
    ).toThrow();
    expect(() =>
      machineReportedRuntimeConfigurationSchema.parse({
        audioCues: {
          enabled: true,
          presenceEnabled: true,
          transactionEnabled: true,
        },
        audioVolume: 40,
        visionRecommendationsEnabled: true,
        apiBaseUrl: "https://api.example.com",
        mqttPassword: "secret",
        serialPortPath: "COM5",
      }),
    ).toThrow();
  });

  it("accepts whole-machine maintenance lock readiness status in heartbeat payload", () => {
    const result = heartbeatPayloadSchema.parse({
      machineCode: "M001",
      reportedAt: "2026-06-26T08:00:00.000Z",
      statusPayload: {
        hardwareStatus: "faulted",
        wholeMachineMaintenanceLock: {
          code: "WHOLE_MACHINE_HARDWARE_FAULT",
          message: "pickup platform blocked",
          source: "dispense_failure",
          orderNo: "ORD-1",
          commandNo: "CMD-1",
          slotCode: "A1",
          errorCode: "JAMMED",
          createdAt: "2026-06-26T07:55:00.000Z",
        },
      },
    });

    expect(result.statusPayload.wholeMachineMaintenanceLock?.slotCode).toBe(
      "A1",
    );
  });

  it("accepts environment control failure when confirmed switch state is unknown", () => {
    const parsed = environmentControlResultPayloadSchema.parse({
      commandNo: "MCMD-1",
      success: false,
      errorCode: "air_conditioner_switch_failed",
      message: "no matching lower controller candidate responded to handshake",
      airConditionerOn: null,
      targetTemperatureCelsius: null,
      reportedAt: "2026-06-09T10:25:35.327Z",
    });

    expect(parsed.airConditionerOn).toBeNull();
  });

  it("accepts nested machine environment readings in heartbeat payload", () => {
    const parsed = heartbeatPayloadSchema.parse({
      machineCode: "M001",
      reportedAt: "2026-05-05T12:00:00.000Z",
      statusPayload: {
        environment: {
          temperatureCelsius: 24,
          humidityRh: 53,
          sampledAt: "2026-05-05T12:00:00.000Z",
          sensorStatus: "ok",
          airConditionerOn: false,
          targetTemperatureCelsius: null,
        },
      },
    });

    expect(parsed.statusPayload.environment?.sensorStatus).toBe("ok");
  });

  it("rejects invalid machine environment sensor status", () => {
    expect(() =>
      heartbeatPayloadSchema.parse({
        machineCode: "M001",
        reportedAt: "2026-05-05T12:00:00.000Z",
        statusPayload: {
          environment: {
            sensorStatus: "stale",
          },
        },
      }),
    ).toThrow();
  });

  it("validates machine environment control command requests", () => {
    expect(
      machineEnvironmentControlRequestSchema.parse({ airConditionerOn: true })
        .airConditionerOn,
    ).toBe(true);
    expect(
      machineEnvironmentControlRequestSchema.parse({
        targetTemperatureCelsius: 24,
      }).targetTemperatureCelsius,
    ).toBe(24);
    expect(
      machineEnvironmentControlRequestSchema.parse({
        ventSpeed: 2,
      }).ventSpeed,
    ).toBe(2);
    expect(() => machineEnvironmentControlRequestSchema.parse({})).toThrow();
    expect(() =>
      machineEnvironmentControlRequestSchema.parse({
        targetTemperatureCelsius: 17,
      }),
    ).toThrow();
    expect(() =>
      machineEnvironmentControlRequestSchema.parse({
        targetTemperatureCelsius: 31,
      }),
    ).toThrow();
    expect(() =>
      machineEnvironmentControlRequestSchema.parse({
        ventSpeed: 5,
      }),
    ).toThrow();
  });

  it("validates environment control command payloads", () => {
    expect(
      environmentControlCommandPayloadSchema.parse({
        commandNo: "MCMD-1",
        airConditionerOn: true,
        targetTemperatureCelsius: 24,
        ventSpeed: 2,
        timeoutSeconds: 5,
      }).targetTemperatureCelsius,
    ).toBe(24);
    expect(() =>
      environmentControlCommandPayloadSchema.parse({
        commandNo: "MCMD-1",
        timeoutSeconds: 5,
      }),
    ).toThrow();
    expect(() =>
      environmentControlCommandPayloadSchema.parse({
        commandNo: "MCMD-1",
        targetTemperatureCelsius: 31,
        timeoutSeconds: 5,
      }),
    ).toThrow();
  });

  it("validates environment control result payloads", () => {
    expect(
      environmentControlResultPayloadSchema.parse({
        commandNo: "MCMD1",
        success: true,
        reportedAt: "2026-05-05T12:00:00.000Z",
        airConditionerOn: true,
        targetTemperatureCelsius: 24,
      }).success,
    ).toBe(true);

    expect(
      environmentControlResultPayloadSchema.parse({
        commandNo: "MCMD2",
        success: false,
        reportedAt: "2026-05-05T12:00:00.000Z",
        errorCode: "E1",
        message: "hardware rejected command",
      }).message,
    ).toBe("hardware rejected command");
  });

  it("validates machine auth token request", () => {
    expect(
      machineAuthTokenRequestSchema.parse({
        machineCode: "M001",
        machineSecret: "local-machine-shared-secret-change-before-production",
      }).machineCode,
    ).toBe("M001");
  });

  it("keeps machine claim code secrets out of normal snapshots", () => {
    expect(machineClaimCodeStates).toEqual([
      "pending",
      "consumed",
      "expired",
      "revoked",
      "locked",
    ]);
    expect(machineClaimCodePurposes).toEqual(["first_claim", "reclaim"]);

    const snapshot = {
      id: "550e8400-e29b-41d4-a716-446655440111",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      purpose: "first_claim",
      state: "pending",
      expiresAt: "2026-06-08T16:40:00.000Z",
      failedAttemptCount: 0,
      maxFailedAttempts: 5,
      createdAt: "2026-06-08T16:30:00.000Z",
      consumedAt: null,
      revokedAt: null,
      lockedAt: null,
    };

    expect(machineClaimCodeSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() =>
      machineClaimCodeSnapshotSchema.parse({
        ...snapshot,
        claimCode: "ABCD-2345",
      }),
    ).toThrow();
    expect(
      generateMachineClaimCodeResponseSchema.parse({
        ...snapshot,
        claimCode: "ABCD-2345",
      }).claimCode,
    ).toBe("ABCD-2345");
  });

  it("accepts only the narrow claim code contract", () => {
    expect(
      machineClaimRequestSchema.parse({
        claimCode: "ABCD-2345",
      }).claimCode,
    ).toBe("ABCD-2345");

    const profile = {
      machine: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        code: "M001",
        name: "Lobby",
        status: "offline",
        locationLabel: "1F",
      },
      credentials: {
        machineSecret:
          "vms_local-machine-shared-secret-change-before-production",
        machineSecretVersion: 2,
        mqttSigningSecret:
          "vms_local-mqtt-shared-secret-change-before-production",
        mqttConnection: {
          url: "mqtt://localhost:1883",
          clientId: "vem-machine-M001",
          username: "machine-client",
          password: "mqtt-password",
        },
      },
      apiBaseUrl: "http://127.0.0.1:3000/api",
      runtimeEndpoints: {
        apiBasePath: "/api",
        machineAuthTokenPath: "/api/machine-auth/token",
        machineApiBasePath: "/api/machines/M001",
        mqttTopicPrefix: "vem/machines/M001",
      },
      hardwareProfile: {
        profile: "production",
        controller: { required: true, protocol: "vem-vending-controller" },
        paymentScanner: { required: true, supportsPaymentCode: true },
        vision: { required: false, supportsRecommendations: true },
      },
      hardwareModel: "vem-prod-24",
      hardwareSlotTopology: {
        identity: "vem-prod-24",
        version: "2026-06-adr0026",
      },
      paymentCapability: {
        profile: "production",
        qrCodeEnabled: true,
        paymentCodeEnabled: true,
        serverTime: "2026-06-08T16:30:00.000Z",
      },
      metadata: {
        profileVersion: 1,
        profileRevision: 2,
        claimCodeId: "550e8400-e29b-41d4-a716-446655440111",
        claimedAt: "2026-06-08T16:30:00.000Z",
        serverTime: "2026-06-08T16:30:00.000Z",
      },
    };

    expect(machineProvisioningProfileSchema.parse(profile)).toEqual(profile);
    for (const contaminated of [
      { ...profile, privateKeyPem: "platform-private-key" },
      {
        ...profile,
        credentials: {
          ...profile.credentials,
          appCertPem: "platform-app-certificate",
        },
      },
      {
        ...profile,
        paymentCapability: {
          ...profile.paymentCapability,
          paymentProviderCredentials: { privateKeyPem: "platform-private-key" },
        },
      },
    ]) {
      expect(() =>
        machineProvisioningProfileSchema.parse(contaminated),
      ).toThrow();
    }
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        machine: {
          ...profile.machine,
          locationText: "1F",
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        machine: {
          ...profile.machine,
          geoLocation: {
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          },
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        planogram: { slots: [] },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        hardwareSlotTopology: {
          ...profile.hardwareSlotTopology,
          slots: [{ slotCode: "A1", capacity: 8 }],
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        stockQuantities: [{ slotCode: "A1", quantity: 3 }],
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        catalog: {
          items: [
            {
              slotCode: "A1",
              productName: "矿泉水",
              quantity: 3,
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        paymentCapability: {
          ...profile.paymentCapability,
          mockEnabled: true,
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        paymentCapability: {
          ...profile.paymentCapability,
          facePayEnabled: true,
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        paymentCapability: {
          profile: "production",
          options: [
            {
              optionKey: "qr_code:alipay",
              providerCode: "alipay",
              method: "face_pay",
              displayName: "刷脸支付",
              description: "首次生产默认不启用刷脸支付",
              icon: "alipay",
              recommended: true,
              disabled: false,
              disabledReason: null,
            },
          ],
          defaultOptionKey: "qr_code:alipay",
          defaultProviderCode: "alipay",
          serverTime: "2026-06-08T16:30:00.000Z",
        },
      }),
    ).toThrow();
    expect(() =>
      machineProvisioningProfileSchema.parse({
        ...profile,
        paymentCapability: {
          ...profile.paymentCapability,
          merchantPrivateKey: "should-not-be-in-profile",
        },
      }),
    ).toThrow();
    expect(JSON.stringify(profile)).not.toContain("merchant");
    expect(JSON.stringify(profile)).not.toContain("COM");
    expect(JSON.stringify(profile)).not.toContain("cameraDevice");
  });

  it("accepts machine planogram version lifecycle snapshots", () => {
    const snapshot = machinePlanogramVersionSnapshotSchema.parse({
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      planogramVersion: "PLAN-2026-06-04",
      status: "published",
      publishedAt: "2026-06-04T12:00:00.000Z",
      acknowledgedAt: null,
      activeAt: null,
      slots: [
        {
          slotId: "550e8400-e29b-41d4-a716-446655440001",
          slotCode: "A1",
          layerNo: 1,
          cellNo: 1,
          inventoryId: "550e8400-e29b-41d4-a716-446655440002",
          variantId: "550e8400-e29b-41d4-a716-446655440003",
          productId: "550e8400-e29b-41d4-a716-446655440004",
          productName: "矿泉水",
          productDescription: null,
          coverImageUrl:
            "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
          categoryId: null,
          categoryName: null,
          sku: "WATER-001",
          size: "550ml",
          color: null,
          priceCents: 200,
          productSortOrder: 1,
          targetGender: null,
          capacity: 8,
          parLevel: 6,
        },
      ],
    });

    expect(snapshot.status).toBe("published");
    expect(snapshot.activeAt).toBeNull();
    expect(() =>
      machinePlanogramVersionSnapshotSchema.parse({
        ...snapshot,
        status: "pending_ack",
      }),
    ).toThrow();
  });

  it("rejects arbitrary planogram cover image URLs", () => {
    const slot = {
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440002",
      variantId: "550e8400-e29b-41d4-a716-446655440003",
      productId: "550e8400-e29b-41d4-a716-446655440004",
      productName: "矿泉水",
      productDescription: null,
      coverImageUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      categoryId: null,
      categoryName: null,
      sku: "WATER-001",
      size: "550ml",
      color: null,
      priceCents: 200,
      productSortOrder: 1,
      targetGender: null,
      capacity: 8,
      parLevel: 6,
    };

    expect(
      publishMachinePlanogramVersionSchema.parse({
        planogramVersion: "PLAN-2026-06-04",
        slots: [slot],
      }).slots[0]?.coverImageUrl,
    ).toBe(slot.coverImageUrl);
    expect(() =>
      publishMachinePlanogramVersionSchema.parse({
        planogramVersion: "PLAN-2026-06-04",
        slots: [
          {
            ...slot,
            coverImageUrl:
              "http://service.test/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      publishMachinePlanogramVersionSchema.parse({
        planogramVersion: "PLAN-2026-06-04",
        slots: [
          {
            ...slot,
            coverImageUrl: "https://example.com/free-form.jpg",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      publishMachinePlanogramVersionSchema.parse({
        planogramVersion: "PLAN-2026-06-04",
        slots: [
          {
            ...slot,
            coverImageUrl:
              "https://evil.example/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts variant try-on silhouettes only as managed media URLs", () => {
    const slot = {
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440002",
      variantId: "550e8400-e29b-41d4-a716-446655440003",
      productId: "550e8400-e29b-41d4-a716-446655440004",
      productName: "基础短袖",
      productDescription: null,
      coverImageUrl: null,
      tryOnSilhouetteUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
      categoryId: null,
      categoryName: "T恤",
      sku: "TSHIRT-M-WHITE",
      size: "M",
      color: "白色",
      priceCents: 200,
      productSortOrder: 1,
      targetGender: null,
      capacity: 8,
      parLevel: 6,
    };

    expect(
      publishMachinePlanogramVersionSchema.parse({
        planogramVersion: "PLAN-2026-06-04",
        slots: [slot],
      }).slots[0]?.tryOnSilhouetteUrl,
    ).toBe(slot.tryOnSilhouetteUrl);
    expect(
      machineSaleViewItemSchema.parse({
        ...slot,
        machineCode: "M001",
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      }).tryOnSilhouetteUrl,
    ).toBe(slot.tryOnSilhouetteUrl);
    expect(() =>
      machineSaleViewItemSchema.parse({
        ...slot,
        machineCode: "M001",
        tryOnSilhouetteUrl: "https://example.com/free-form.png",
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      }),
    ).toThrow();
    expect(() =>
      machineSaleViewItemSchema.parse({
        ...slot,
        machineCode: "M001",
        tryOnSilhouetteUrl:
          "https://evil.example/api/media-assets/550e8400-e29b-41d4-a716-446655440125/content",
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      }),
    ).toThrow();
  });

  it("accepts machine sale view slot sales states", () => {
    const base = {
      machineCode: "M001",
      slotId: "550e8400-e29b-41d4-a716-446655440001",
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
      inventoryId: "550e8400-e29b-41d4-a716-446655440002",
      variantId: "550e8400-e29b-41d4-a716-446655440003",
      productId: "550e8400-e29b-41d4-a716-446655440004",
      productName: "矿泉水",
      productDescription: null,
      coverImageUrl:
        "/api/media-assets/550e8400-e29b-41d4-a716-446655440124/content",
      categoryId: null,
      categoryName: null,
      sku: "WATER-001",
      size: null,
      color: null,
      priceCents: 200,
      productSortOrder: 1,
      targetGender: null,
      capacity: 8,
      parLevel: 6,
      physicalStock: 1,
      saleableStock: 1,
    };

    for (const slotSalesState of [
      "sale_ready",
      "sold_out",
      "suspect",
      "frozen",
      "needs_count",
      "blocked_for_planogram_change",
      "movement_rejected",
      "needs_platform_review",
    ]) {
      expect(
        machineSaleViewItemSchema.parse({ ...base, slotSalesState })
          .slotSalesState,
      ).toBe(slotSalesState);
    }
    expect(() =>
      machineSaleViewItemSchema.parse({ ...base, slotSalesState: "saleable" }),
    ).toThrow();
  });

  describe("canonicalJson", () => {
    it("sorts object keys alphabetically", () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("handles nested objects", () => {
      expect(canonicalJson({ z: { b: 1, a: 2 }, a: true })).toBe(
        '{"a":true,"z":{"a":2,"b":1}}',
      );
    });

    it("handles arrays preserving order", () => {
      expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    });

    it("handles null and primitives", () => {
      expect(canonicalJson(null)).toBe("null");
      expect(canonicalJson(true)).toBe("true");
      expect(canonicalJson(42)).toBe("42");
      expect(canonicalJson("hello")).toBe('"hello"');
    });
  });

  describe("mqttSignedEnvelopeSchema", () => {
    it("accepts a valid envelope", () => {
      const envelope = {
        messageId: "msg-001",
        machineCode: "M001",
        issuedAt: "2026-05-05T12:00:00.000Z",
        nonce: "nonce-1234567890abcdef",
        payload: { commandNo: "CMD1" },
        signature: "a".repeat(32),
      };
      expect(mqttSignedEnvelopeSchema.parse(envelope).machineCode).toBe("M001");
    });

    it("rejects envelope missing signature", () => {
      expect(() =>
        mqttSignedEnvelopeSchema.parse({
          messageId: "msg-001",
          machineCode: "M001",
          issuedAt: "2026-05-05T12:00:00.000Z",
          nonce: "nonce-1234567890abcdef",
          payload: {},
          // no signature
        }),
      ).toThrow();
    });
  });

  describe("paymentProviderSensitiveConfigSchema", () => {
    it("accepts scalar values (string, number, boolean, null)", () => {
      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({
          apiKey: "secret",
          amount: 100,
          enabled: true,
          optional: null,
        }),
      ).not.toThrow();
    });

    it("rejects array values", () => {
      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({ keys: ["a", "b"] }),
      ).toThrow();
    });

    it("rejects nested object values", () => {
      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({
          nested: { foo: "bar" },
        }),
      ).toThrow();
    });
  });

  describe("upsertPaymentProviderConfigSchema", () => {
    it("accepts machineId: null (global config)", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          machineId: null,
          merchantNo: "MCH123",
          status: "disabled",
        }),
      ).not.toThrow();
    });

    it("accepts machineId as a UUID string (machine-specific config)", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "alipay",
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          status: "disabled",
        }),
      ).not.toThrow();
    });

    it("accepts wechat_pay direct merchant config with timing windows", () => {
      const TEST_PRIVATE_KEY_PEM = "dev-test-private-key-not-for-crypto-use";
      const TEST_PUBLIC_KEY_PEM = "dev-test-public-key-not-for-crypto-use";
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        machineId: null,
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        publicConfigJson: {
          mode: "direct_merchant",
          merchantCertificateSerialNo: "MERCHANT_CERT_SERIAL",
          platformCertificateSerialNo: "PLATFORM_CERT_SERIAL",
          qrExpiresMinutes: 15,
          timeoutCompensationSeconds: 120,
        },
        sensitiveConfigJson: {
          apiV3Key: "0123456789abcdef0123456789abcdef",
          privateKeyPem: TEST_PRIVATE_KEY_PEM,
          platformPublicKeyPem: TEST_PUBLIC_KEY_PEM,
        },
      });
      expect(result.providerCode).toBe("wechat_pay");
    });

    it("accepts wechat_pay merchant V2 credentials without channel switches", () => {
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        publicConfigJson: {
          merchantCertificateSerialNo: "MERCHANT_CERT_SERIAL",
          platformCertificateSerialNo: "PLATFORM_CERT_SERIAL",
        },
        sensitiveConfigJson: {
          apiV3Key: "0123456789abcdef0123456789abcdef",
          privateKeyPem: "dev-key",
          platformPublicKeyPem: "dev-pub",
          apiV2Key: "0123456789abcdef0123456789abcdef",
          merchantApiCertPem: "dev-cert",
          merchantApiKeyPem: "dev-cert-key",
        },
      });
      expect(result.providerCode).toBe("wechat_pay");
      expect(result.publicConfigJson).not.toHaveProperty("paymentCodeEnabled");
    });

    it("accepts wechat_pay config using deprecated certificateSerialNo alias for merchant serial", () => {
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        publicConfigJson: {
          certificateSerialNo: "LEGACY_MERCHANT_SERIAL",
          platformCertificateSerialNo: "PLATFORM_CERT_SERIAL",
        },
        sensitiveConfigJson: {
          apiV3Key: "0123456789abcdef0123456789abcdef",
          privateKeyPem: "dev-key",
          platformPublicKeyPem: "dev-pub",
        },
      });
      expect(result.providerCode).toBe("wechat_pay");
    });

    it("allows partial wechat_pay config updates for server-side secret merge", () => {
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        status: "enabled",
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        publicConfigJson: {
          merchantCertificateSerialNo: "MERCHANT_CERT_SERIAL",
        },
      });

      expect(result.providerCode).toBe("wechat_pay");
      expect(result.sensitiveConfigJson).toBeUndefined();
    });

    it("rejects legacy wechat_pay payment-code channel switches", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          merchantNo: "1900000109",
          appId: "wx1234567890abcdef",
          publicConfigJson: {
            merchantCertificateSerialNo: "MERCHANT_CERT_SERIAL",
            platformCertificateSerialNo: "PLATFORM_CERT_SERIAL",
            paymentCodeEnabled: true,
          },
          sensitiveConfigJson: {
            apiV3Key: "0123456789abcdef0123456789abcdef",
            privateKeyPem: "dev-key",
            platformPublicKeyPem: "dev-pub",
          },
        }),
      ).toThrow();
    });

    it("accepts alipay certificate mode sandbox config", () => {
      const TEST_PRIVATE_KEY_PEM =
        "dev-test-alipay-private-key-not-for-crypto-use";
      const TEST_CERTIFICATE_PEM = [
        "-----BEGIN CERTIFICATE-----",
        "ZGV2LXRlc3QtY2VydGlmaWNhdGUtbm90LWZvci1jcnlwdG8tdXNl",
        "-----END CERTIFICATE-----",
      ].join("\n");
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "alipay",
        merchantNo: "2088721101045878",
        appId: "9021000163629927",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
          qrExpiresMinutes: 15,
          timeoutCompensationSeconds: 120,
        },
        sensitiveConfigJson: {
          privateKeyPem: TEST_PRIVATE_KEY_PEM,
          appCertPem: TEST_CERTIFICATE_PEM,
          alipayPublicCertPem: TEST_CERTIFICATE_PEM,
          alipayRootCertPem: TEST_CERTIFICATE_PEM,
        },
      });
      expect(result.providerCode).toBe("alipay");
    });

    it("accepts machine-level disabled override without secrets", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          status: "disabled",
        }),
      ).not.toThrow();
    });

    it("rejects timing windows outside the agreed phase-1 bounds", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "alipay",
          publicConfigJson: {
            qrExpiresMinutes: 0,
            timeoutCompensationSeconds: 9999,
          },
        }),
      ).toThrow();
    });
  });

  describe("createMachineOrderSchema", () => {
    it("rejects machine order items without planogram slot context", () => {
      expect(() =>
        createMachineOrderSchema.parse({
          machineCode: "M001",
          items: [
            {
              inventoryId: "550e8400-e29b-41d4-a716-446655440000",
              quantity: 1,
            },
          ],
          paymentMethod: "mock",
        }),
      ).toThrow();
    });

    it("accepts paymentProviderCode alongside paymentMethod", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "qr_code",
        paymentProviderCode: "wechat_pay",
      });
      expect(result.paymentProviderCode).toBe("wechat_pay");
      expect(result.paymentMethod).toBe("qr_code");
    });

    it("preserves the stable checkout idempotency key", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "qr_code",
        paymentProviderCode: "alipay",
        idempotencyKey: "checkout:attempt-001",
      });

      expect(result.idempotencyKey).toBe("checkout:attempt-001");
    });

    it("accepts mock without paymentProviderCode", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "mock",
      });
      expect(result.paymentMethod).toBe("mock");
      expect(result.paymentProviderCode).toBeUndefined();
    });

    it("rejects mock method with real provider", () => {
      expect(() =>
        createMachineOrderSchema.parse({
          machineCode: "M001",
          items: [
            {
              inventoryId: "550e8400-e29b-41d4-a716-446655440000",
              quantity: 1,
              planogramVersion: "PLAN-1",
              slotId: "550e8400-e29b-41d4-a716-446655440001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "mock",
          paymentProviderCode: "alipay",
        }),
      ).toThrow("mock payment method can only use mock provider");
    });

    it("rejects qr_code without real provider", () => {
      expect(() =>
        createMachineOrderSchema.parse({
          machineCode: "M001",
          items: [
            {
              inventoryId: "550e8400-e29b-41d4-a716-446655440000",
              quantity: 1,
              planogramVersion: "PLAN-1",
              slotId: "550e8400-e29b-41d4-a716-446655440001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "qr_code",
        }),
      ).toThrow(
        "qr_code payment method requires alipay or wechat_pay provider",
      );
    });

    it("accepts payment_code with alipay provider", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
      });
      expect(result.paymentMethod).toBe("payment_code");
      expect(result.paymentProviderCode).toBe("alipay");
    });

    it("accepts null profileSnapshot from machine clients", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
        profileSnapshot: null,
      });
      expect(result.profileSnapshot).toBeNull();
    });

    it("strips sensitive profileSnapshot fields from machine orders", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
        profileSnapshot: {
          personPresent: true,
          heightCm: 172,
          bodyType: "regular",
          upperColor: "blue",
          confidence: 0.91,
          rawImageBase64: "data:image/jpeg;base64,raw",
          identity: { id: "customer-1" },
          faceEmbedding: [0.1, 0.2],
          ageRange: "adult",
          gender: "male",
        },
      });

      expect(result.profileSnapshot).toEqual({
        personPresent: true,
        heightCm: 172,
        bodyType: "regular",
        upperColor: "blue",
        confidence: 0.91,
      });
    });

    it("falls back to null for unknown legacy profileSnapshot shapes", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
        profileSnapshot: {
          ageRange: "adult",
          gender: "female",
          shoulderWidthCm: null,
          legacyModelVersion: "vision-0",
        },
      });

      expect(result.profileSnapshot).toBeNull();
    });

    it("sanitizes invalid profileSnapshot metadata without rejecting machine orders", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440000",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
        profileSnapshot: {
          personPresent: true,
          heightCm: 300,
          bodyType: "x".repeat(64),
          upperColor: "",
          confidence: 2,
        },
      });

      expect(result.profileSnapshot).toEqual({ personPresent: true });
    });

    it("accepts payment_code with mock provider for testbed scanner flow", () => {
      expect(
        createMachineOrderSchema.parse({
          machineCode: "M001",
          items: [
            {
              inventoryId: "550e8400-e29b-41d4-a716-446655440000",
              quantity: 1,
              planogramVersion: "PLAN-1",
              slotId: "550e8400-e29b-41d4-a716-446655440001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "payment_code",
          paymentProviderCode: "mock",
        }).paymentProviderCode,
      ).toBe("mock");
    });

    it("parses payment_code submit and response schemas without leaking auth code", () => {
      const submit = paymentCodeSubmitSchema.parse({
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "scan-20260524-0001",
        source: "serial_text",
        scannerEventId: "evt-scanner-1",
        scannerHealth: {
          online: true,
          adapter: "serial_text",
          port: "/dev/ttyUSB1",
          message: "scanner ready",
        },
      });
      expect(submit.source).toBe("serial_text");
      expect(JSON.stringify(submit)).toContain("scannerHealth");
      expect(JSON.stringify(submit)).toContain("serial_text");
      expect(submit.scannerEventId).toBe("evt-scanner-1");

      const response = paymentCodeSubmitResponseSchema.parse({
        orderNo: "ORD202605240001",
        paymentNo: "PAY202605240001",
        attemptNo: 1,
        status: "user_confirming",
        nextAction: "wait_payment",
        message: "请在手机上确认支付",
        canRetry: false,
        serverTime: "2026-05-24T10:00:00.000Z",
      });
      expect(JSON.stringify(response)).not.toContain("28763443825664394");
    });

    it("preserves exact payment-code payloads and rejects boundary whitespace or unsupported bytes", () => {
      const accepted = paymentCodeSubmitSchema.parse({
        machineCode: "M001",
        authCode: "2876 3443825664394",
        idempotencyKey: "scan-20260524-0002",
        source: "serial_text",
      });
      expect(accepted.authCode).toBe("2876 3443825664394");

      for (const authCode of [
        " 28763443825664394",
        "28763443825664394 ",
        "28763443825664394\t",
        "28763443825664394\u0080",
      ]) {
        expect(() =>
          paymentCodeSubmitSchema.parse({
            machineCode: "M001",
            authCode,
            idempotencyKey: "scan-20260524-0003",
            source: "serial_text",
          }),
        ).toThrow();
      }
    });
  });

  describe("HARDWARE_ERROR_HANDLING defaults", () => {
    it("has a policy for every hardwareErrorCode", () => {
      for (const code of hardwareErrorCodes) {
        expect(HARDWARE_ERROR_HANDLING[code]).toBeDefined();
        expect(typeof HARDWARE_ERROR_HANDLING[code].restoreInventory).toBe(
          "boolean",
        );
      }
    });

    it("has a NULL_ERROR fallback policy with errorCode=null", () => {
      expect(HARDWARE_ERROR_HANDLING["NULL_ERROR"]).toBeDefined();
      expect(HARDWARE_ERROR_HANDLING["NULL_ERROR"].errorCode).toBeNull();
    });
  });

  describe("maintenanceWorkOrderStatuses", () => {
    it("contains exactly the 4 allowed status values", () => {
      expect(maintenanceWorkOrderStatuses).toEqual([
        "open",
        "in_progress",
        "resolved",
        "canceled",
      ]);
    });
  });

  describe("upsertNotificationTargetSchema", () => {
    it("accepts wechat target with valid webhookUrl", () => {
      expect(() =>
        upsertNotificationTargetSchema.parse({
          name: "WeChat Group",
          type: "wechat",
          configJson: {
            webhookUrl:
              "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc",
          },
        }),
      ).not.toThrow();
    });

    it("rejects wechat target with invalid webhookUrl", () => {
      expect(() =>
        upsertNotificationTargetSchema.parse({
          name: "WeChat Group",
          type: "wechat",
          configJson: { webhookUrl: "not-a-url" },
        }),
      ).toThrow();
    });
  });

  describe("notificationTypeSchema", () => {
    it("includes payment ops notification types", () => {
      expect(() =>
        notificationTypeSchema.parse("payment_webhook_invalid"),
      ).not.toThrow();
      expect(() =>
        notificationTypeSchema.parse("payment_reconciliation_failed"),
      ).not.toThrow();
      expect(() =>
        notificationTypeSchema.parse("payment_refund_failed"),
      ).not.toThrow();
      expect(() =>
        notificationTypeSchema.parse("payment_certificate_expiring"),
      ).not.toThrow();
      expect(() =>
        notificationTypeSchema.parse("payment_provider_unready"),
      ).not.toThrow();
    });
  });

  describe("payment ops schemas", () => {
    it("keeps the customer payment-options contract environment-neutral", () => {
      const result = machinePaymentOptionsResponseSchema.parse({
        options: [],
        defaultOptionKey: null,
        defaultProviderCode: null,
        providerEnvironment: {
          environment: "sandbox",
          readiness: "ready",
          errorCategory: "none",
        },
        serverTime: "2026-05-06T10:00:00.000Z",
      });

      expect(result).not.toHaveProperty("providerEnvironment");
      expect(JSON.stringify(result)).not.toMatch(/sandbox|production/i);
    });

    it("paymentOpsReadinessSchema parses ready status with all checks", () => {
      const result = paymentOpsReadinessSchema.parse({
        status: "ready",
        checkedAt: "2026-05-06T10:00:00.000Z",
        environment: "production",
        providerEnvironment: {
          environment: "production",
          readiness: "ready",
          errorCategory: "none",
        },
        checks: [
          {
            code: "mock_provider_disabled",
            severity: "critical",
            passed: true,
            message: "Mock payment is disabled",
            evidence: { envPaymentMockEnabled: false },
          },
        ],
      });
      expect(result.status).toBe("ready");
      expect(result.providerEnvironment.environment).toBe("production");
      expect(result.checks).toHaveLength(1);
    });

    it("paymentOpsReadinessSchema parses blocked status with critical check", () => {
      const result = paymentOpsReadinessSchema.parse({
        status: "blocked",
        checkedAt: "2026-05-06T10:00:00.000Z",
        environment: "development",
        checks: [
          {
            code: "real_provider_config_present",
            severity: "critical",
            passed: false,
            message: "No real provider config is enabled",
            evidence: {},
          },
        ],
      });
      expect(result.status).toBe("blocked");
    });

    it("paymentOpsMetricsSchema rejects negative failure rate", () => {
      expect(() =>
        paymentOpsMetricsSchema.parse({
          measuredAt: "2026-05-06T10:00:00.000Z",
          windowMinutes: 60,
          paymentFailureRate: -0.1,
          paymentFailedCount: 0,
          paymentTotalCount: 0,
          webhookSignatureInvalidCount: 0,
          webhookBusinessInvalidCount: 0,
          reconciliationErrorCount: 0,
          refundFailedCount: 0,
          refundProcessingOverdueCount: 0,
          certificateExpiringCount: 0,
          paymentCodeUnknownCount: 0,
          paymentCodeReverseFailedCount: 0,
          paymentCodeDuplicateRejectedCount: 0,
          scannerOfflineMachineCount: 0,
        }),
      ).toThrow();
    });

    it("paymentMachinePreflightSchema parses machine preflight result", () => {
      const result = paymentMachinePreflightSchema.parse({
        machineId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        machineCode: "M001",
        status: "ready",
        availableProviders: [
          {
            optionKey: "qr_code:alipay",
            providerCode: "alipay",
            method: "qr_code",
            displayName: "支付宝",
            description: "请使用支付宝扫码支付",
            icon: "alipay",
          },
        ],
        defaultOptionKey: "qr_code:alipay",
        defaultProviderCode: "alipay",
        checks: [],
        checkedAt: "2026-05-06T10:00:00.000Z",
      });
      expect(result.status).toBe("ready");
      expect(result.availableProviders).toHaveLength(1);
    });

    it("heartbeatPayloadSchema accepts production dispense path evidence", () => {
      const result = heartbeatPayloadSchema.parse({
        machineCode: "M001",
        reportedAt: "2026-06-26T04:00:00.000Z",
        statusPayload: {
          hardwareAdapter: "serial",
          hardwarePortPath: "tcp://127.0.0.1:17991",
          hardwareStatus: "ok",
        },
      });

      expect(result.statusPayload.hardwareAdapter).toBe("serial");
      expect(result.statusPayload.hardwarePortPath).toBe(
        "tcp://127.0.0.1:17991",
      );
    });

    it("paymentMachinePreflightSchema accepts payment_code options", () => {
      const result = paymentMachinePreflightSchema.parse({
        machineId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        machineCode: "M001",
        status: "ready",
        availableProviders: [
          {
            optionKey: "payment_code:wechat_pay",
            providerCode: "wechat_pay",
            method: "payment_code",
            displayName: "微信付款码",
            description: "请出示微信付款码并靠近扫码窗口",
            icon: "wechat",
          },
        ],
        defaultOptionKey: "payment_code:wechat_pay",
        defaultProviderCode: "wechat_pay",
        checks: [],
        checkedAt: "2026-05-06T10:00:00.000Z",
      });
      expect(result.availableProviders[0]?.method).toBe("payment_code");
    });

    it("rejects whitespace-only payment_code admin action reasons", () => {
      expect(() =>
        paymentCodeAttemptAdminActionSchema.parse({ reason: "   " }),
      ).toThrow();
    });

    it("parses payment_code attempt query schema", () => {
      const result = paymentCodeAttemptQuerySchema.parse({
        orderNo: "ORD202605240001",
        providerCode: "alipay",
        status: "manual_handling",
        manualOnly: true,
      });
      expect(result.manualOnly).toBe(true);
    });

    it("parses machine status poll reconciliation attempt filters", () => {
      const result = paymentReconciliationAttemptQuerySchema.parse({
        paymentNo: "PAY202606260001",
        trigger: "machine_status_poll",
      });
      expect(result.trigger).toBe("machine_status_poll");
    });

    it("parses protected payment drill contracts and requires operator reasons", () => {
      expect(
        protectedPaymentDrillScenarioSchema.parse("payment_code_unknown"),
      ).toBe("payment_code_unknown");
      expect(
        createProtectedPaymentDrillSchema.parse({
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "qr_reconcile_failed",
          reason: "pre-launch payment recovery rehearsal",
        }),
      ).toEqual({
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        scenario: "qr_reconcile_failed",
        reason: "pre-launch payment recovery rehearsal",
      });
      expect(() =>
        createProtectedPaymentDrillSchema.parse({
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "qr_reconcile_failed",
          reason: " ",
        }),
      ).toThrow();
      expect(() =>
        createProtectedPaymentDrillSchema.parse({
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "qr_reconcile_failed",
          reason: "pre-launch payment recovery rehearsal",
          targetOrderId: "550e8400-e29b-41d4-a716-446655440001",
        }),
      ).toThrow();
      expect(() =>
        protectedPaymentDrillRecoveryActionSchema.parse({
          action: "request_refund",
          reason: "",
        }),
      ).toThrow();
      expect(() =>
        protectedPaymentDrillRecoveryActionSchema.parse({
          action: "request_refund",
          reason: "operator rehearsed refund recovery",
          targetOrderId: "550e8400-e29b-41d4-a716-446655440001",
        }),
      ).toThrow();
      expect(() =>
        protectedPaymentDrillRecoveryActionSchema.parse({
          action: "request_refund",
          reason: "operator rehearsed refund recovery",
          extra: "must be rejected",
        }),
      ).toThrow();
    });

    it("parses protected fulfillment drill contracts and rejects target orders", () => {
      expect(
        protectedFulfillmentDrillScenarioSchema.parse(
          "unknown_dispense_result",
        ),
      ).toBe("unknown_dispense_result");
      expect(
        createProtectedFulfillmentDrillSchema.parse({
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "dispense_failed",
          reason: "pre-launch fulfillment recovery rehearsal",
        }),
      ).toEqual({
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        scenario: "dispense_failed",
        reason: "pre-launch fulfillment recovery rehearsal",
      });
      expect(() =>
        createProtectedFulfillmentDrillSchema.parse({
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "dispense_failed",
          reason: " ",
        }),
      ).toThrow();
      expect(() =>
        createProtectedFulfillmentDrillSchema.parse({
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario: "dispense_failed",
          reason: "pre-launch fulfillment recovery rehearsal",
          targetOrderId: "550e8400-e29b-41d4-a716-446655440001",
        }),
      ).toThrow();
      expect(
        protectedFulfillmentDrillRecoveryActionSchema.parse({
          action: "confirm_not_dispensed",
          reason: "operator confirmed the drill item did not dispense",
        }),
      ).toEqual({
        action: "confirm_not_dispensed",
        reason: "operator confirmed the drill item did not dispense",
      });
      expect(() =>
        protectedFulfillmentDrillRecoveryActionSchema.parse({
          action: "request_refund",
          reason: "",
        }),
      ).toThrow();
      expect(() =>
        protectedFulfillmentDrillRecoveryActionSchema.parse({
          action: "request_refund",
          reason: "operator rehearsed refund recovery",
          targetOrderId: "550e8400-e29b-41d4-a716-446655440001",
        }),
      ).toThrow();
      expect(() =>
        protectedFulfillmentDrillRecoveryActionSchema.parse({
          action: "request_refund",
          reason: "operator rehearsed refund recovery",
          extra: "must be rejected",
        }),
      ).toThrow();
    });
  });
});
