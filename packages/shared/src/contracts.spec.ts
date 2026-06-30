import { describe, expect, it } from "vitest";

import {
  HARDWARE_ERROR_HANDLING,
  adminUserStatuses,
  canonicalJson,
  createMachineSchema,
  createMachineSlotSchema,
  createMachineOrderSchema,
  createProtectedFulfillmentDrillSchema,
  createProtectedPaymentDrillSchema,
  dispenseCommandPayloadSchema,
  hardwareErrorCodes,
  environmentControlCommandPayloadSchema,
  environmentControlResultPayloadSchema,
  heartbeatPayloadSchema,
  machineEnvironmentControlRequestSchema,
  machineAuthTokenRequestSchema,
  machineClaimRequestSchema,
  generateMachineClaimCodeResponseSchema,
  machineClaimCodeSnapshotSchema,
  machineClaimCodePurposes,
  machineClaimCodeStates,
  machineProvisioningProfileSchema,
  machinePlanogramVersionSnapshotSchema,
  machineSaleViewItemSchema,
  machineSlotStatuses,
  formatMachineSlotCoordinate,
  isValidMachineSlotCoordinate,
  getMachineSlotMaxCellNo,
  machineSlotCoordinateCode,
  maintenanceWorkOrderStatuses,
  mqttSignedEnvelopeSchema,
  notificationTypeSchema,
  orderStatuses,
  paymentCodeAttemptAdminActionSchema,
  paymentMachinePreflightSchema,
  externalNaturalEnvironmentSchema,
  updateMachineSchema,
  paymentCodeAttemptQuerySchema,
  paymentCodeSubmitResponseSchema,
  paymentCodeSubmitSchema,
  paymentOpsMetricsSchema,
  paymentOpsReadinessSchema,
  paymentProviderStatuses,
  paymentProviderSensitiveConfigSchema,
  paymentReconciliationAttemptQuerySchema,
  protectedFulfillmentDrillRecoveryActionSchema,
  protectedFulfillmentDrillScenarioSchema,
  protectedPaymentDrillRecoveryActionSchema,
  protectedPaymentDrillScenarioSchema,
  roleStatuses,
  upsertNotificationTargetSchema,
  upsertPaymentProviderConfigSchema,
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

  it("enforces hardware slot coordinate bounds across machine contracts", () => {
    expect(getMachineSlotMaxCellNo(1)).toBe(5);
    expect(getMachineSlotMaxCellNo(6)).toBe(5);
    expect(getMachineSlotMaxCellNo(7)).toBe(4);
    expect(getMachineSlotMaxCellNo(10)).toBe(4);
    expect(getMachineSlotMaxCellNo(11)).toBe(4);
    expect(isValidMachineSlotCoordinate({ layerNo: 7, cellNo: 4 })).toBe(true);
    expect(isValidMachineSlotCoordinate({ layerNo: 11, cellNo: 4 })).toBe(true);
    expect(isValidMachineSlotCoordinate({ layerNo: 7, cellNo: 5 })).toBe(false);
    expect(isValidMachineSlotCoordinate({ layerNo: 11, cellNo: 5 })).toBe(
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
      status: "offline",
    });
    expect(() =>
      createMachineSchema.parse({
        code: "M001",
        name: "Lobby",
        locationText: "1F",
      }),
    ).toThrow();
  });

  it("does not apply create defaults to Machine partial update contracts", () => {
    expect(updateMachineSchema.parse({ geoLocation: null })).toEqual({
      geoLocation: null,
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

  it("defines External Natural Environment unconfigured as HTTP-success payload without weather or sun data", () => {
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
        weather: { temperatureCelsius: 28 },
        sun: { sunriseAt: "2026-06-30T21:00:00.000Z" },
        diagnostic: {
          reason: "machine_geo_location_missing",
          message: "Machine Geo Location is not configured",
        },
      }),
    ).toThrow();
  });

  it("defines External Natural Environment ready as normalized local time, weather, and sun data", () => {
    expect(
      externalNaturalEnvironmentSchema.parse({
        status: "ready",
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        machineCode: "M001",
        checkedAt: "2026-06-30T14:00:00.000Z",
        localTime: {
          timezone: "Asia/Shanghai",
          localDate: "2026-06-30",
          localClock: "22:00:00",
        },
        weather: {
          temperatureCelsius: 28,
          conditionText: "Sunny",
          observedAt: "2026-06-30T13:50:00.000Z",
        },
        sun: {
          sunriseAt: "2026-06-29T21:53:00.000Z",
          sunsetAt: "2026-06-30T10:02:00.000Z",
        },
      }),
    ).toEqual({
      status: "ready",
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      machineCode: "M001",
      checkedAt: "2026-06-30T14:00:00.000Z",
      localTime: {
        timezone: "Asia/Shanghai",
        localDate: "2026-06-30",
        localClock: "22:00:00",
      },
      weather: {
        temperatureCelsius: 28,
        conditionText: "Sunny",
        observedAt: "2026-06-30T13:50:00.000Z",
      },
      sun: {
        sunriseAt: "2026-06-29T21:53:00.000Z",
        sunsetAt: "2026-06-30T10:02:00.000Z",
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
        saleReadiness: {
          state: "locked",
          blockingCodes: ["WHOLE_MACHINE_HARDWARE_FAULT"],
        },
      },
    });

    expect(result.statusPayload.saleReadiness?.state).toBe("locked");
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
  });

  it("validates environment control command payloads", () => {
    expect(
      environmentControlCommandPayloadSchema.parse({
        commandNo: "MCMD-1",
        airConditionerOn: true,
        targetTemperatureCelsius: 24,
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

  it("accepts only approved machine provisioning profile categories", () => {
    expect(
      machineClaimRequestSchema.parse({ claimCode: "ABCD-2345" }).claimCode,
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
      paymentCapability: {
        profile: "production",
        qrCodeEnabled: true,
        paymentCodeEnabled: true,
        serverTime: "2026-06-08T16:30:00.000Z",
      },
      metadata: {
        profileVersion: 1,
        claimCodeId: "550e8400-e29b-41d4-a716-446655440111",
        claimedAt: "2026-06-08T16:30:00.000Z",
        serverTime: "2026-06-08T16:30:00.000Z",
      },
    };

    expect(machineProvisioningProfileSchema.parse(profile)).toEqual(profile);
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
          coverImageUrl: null,
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
      coverImageUrl: null,
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

    it("accepts wechat_pay payment_code config with V2 credentials", () => {
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        publicConfigJson: {
          merchantCertificateSerialNo: "MERCHANT_CERT_SERIAL",
          platformCertificateSerialNo: "PLATFORM_CERT_SERIAL",
          paymentCodeEnabled: true,
          paymentCodePollIntervalSeconds: 3,
          paymentCodeMaxConfirmSeconds: 30,
          paymentCodeReverseDelaySeconds: 0,
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

    it("rejects enabled wechat_pay config missing platformCertificateSerialNo", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          status: "enabled",
          merchantNo: "1900000109",
          appId: "wx1234567890abcdef",
          publicConfigJson: {
            merchantCertificateSerialNo: "MERCHANT_CERT_SERIAL",
            // platformCertificateSerialNo intentionally omitted
          },
          sensitiveConfigJson: {
            apiV3Key: "0123456789abcdef0123456789abcdef",
            privateKeyPem: "dev-key",
            platformPublicKeyPem: "dev-pub",
          },
        }),
      ).toThrow();
    });

    it("rejects enabled wechat_pay payment_code config missing V2 credentials", () => {
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
      ).toThrow("wechat_pay payment_code requires apiV2Key");
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

    it("rejects payment_code with mock provider", () => {
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
          paymentMethod: "payment_code",
          paymentProviderCode: "mock",
        }),
      ).toThrow(
        /payment_code payment method requires alipay or wechat_pay provider/,
      );
    });

    it("parses payment_code submit and response schemas without leaking auth code", () => {
      const submit = paymentCodeSubmitSchema.parse({
        machineCode: "M001",
        authCode: "28763443825664394",
        idempotencyKey: "scan-20260524-0001",
        source: "serial_text",
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
    it("paymentOpsReadinessSchema parses ready status with all checks", () => {
      const result = paymentOpsReadinessSchema.parse({
        status: "ready",
        checkedAt: "2026-05-06T10:00:00.000Z",
        environment: "production",
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
