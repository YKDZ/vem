import {
  adminMachineCommandResponseSchema,
  adminMachineRemoteOpResponseSchema,
  adminMachineResponseSchema,
  adminMachineSlotResponseSchema,
} from "@vem/shared";
import { describe, expect, it } from "vitest";

import {
  mapCreateMachineDtoToInsert,
  mapCreateMachineSlotDtoToInsert,
  mapEnvironmentControlDtoToCommandInsert,
  mapUpdateMachineDtoToPatch,
  toAdminMachineCommandResponse,
  toAdminMachineRemoteOpResponse,
  toAdminMachineResponse,
  toAdminMachineSlotResponse,
} from "./machines.contract-mappers";

describe("Machine Operations admin contract mappers", () => {
  it("maps parsed admin machine DTOs into explicit machine insert values", () => {
    const insert = mapCreateMachineDtoToInsert({
      code: "M-001",
      name: "Lobby Machine",
      locationLabel: undefined,
      geoLocation: {
        latitude: 31.2,
        longitude: 121.5,
        timezone: "Asia/Shanghai",
      },
    });

    expect(insert).toEqual({
      code: "M-001",
      name: "Lobby Machine",
      locationLabel: null,
      geoLatitude: 31.2,
      geoLongitude: 121.5,
      geoTimezone: "Asia/Shanghai",
    });
    expect(insert).not.toHaveProperty("geoLocation");
  });

  it("keeps omitted and nullable machine geo location distinct for update patches", () => {
    expect(mapUpdateMachineDtoToPatch({ name: "Lobby" })).toMatchObject({
      name: "Lobby",
      geoLatitude: undefined,
      geoLongitude: undefined,
      geoTimezone: undefined,
    });

    expect(mapUpdateMachineDtoToPatch({ geoLocation: null })).toMatchObject({
      geoLatitude: null,
      geoLongitude: null,
      geoTimezone: null,
    });
  });

  it("maps parsed slot DTOs into explicit slot insert values", () => {
    expect(
      mapCreateMachineSlotDtoToInsert("550e8400-e29b-41d4-a716-446655440001", {
        layerNo: 1,
        cellNo: 2,
        slotCode: "A2",
        capacity: 10,
        status: "enabled",
      }),
    ).toEqual({
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      layerNo: 1,
      cellNo: 2,
      slotCode: "A2",
      capacity: 10,
      status: "enabled",
    });
  });

  it("maps environment control DTOs into explicit command records", () => {
    const now = new Date("2026-07-05T00:00:00.000Z");

    const insert = mapEnvironmentControlDtoToCommandInsert({
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      adminUserId: "550e8400-e29b-41d4-a716-446655440002",
      commandNo: "MCMD202607050001",
      input: { targetTemperatureCelsius: 24, ventSpeed: 2 },
      timeoutSeconds: 30,
      now,
    });

    expect(insert).toEqual({
      commandNo: "MCMD202607050001",
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      type: "environment-control",
      status: "pending",
      payloadJson: {
        commandNo: "MCMD202607050001",
        targetTemperatureCelsius: 24,
        ventSpeed: 2,
        timeoutSeconds: 30,
      },
      timeoutAt: new Date("2026-07-05T00:00:30.000Z"),
      requestedByAdminUserId: "550e8400-e29b-41d4-a716-446655440002",
    });
    expect(insert.payloadJson).not.toHaveProperty("airConditionerOn");
  });

  it("maps database-shaped machine rows into strict admin machine responses", () => {
    const response = toAdminMachineResponse({
      id: "550e8400-e29b-41d4-a716-446655440001",
      code: "M001",
      name: "Lobby",
      locationLabel: null,
      geoLatitude: 31.2304,
      geoLongitude: 121.4737,
      geoTimezone: "Asia/Shanghai",
      status: "offline",
      mqttClientId: null,
      lastSeenAt: null,
      createdAt: new Date("2026-07-05T00:00:00.000Z"),
      updatedAt: new Date("2026-07-05T00:01:00.000Z"),
    });

    expect(adminMachineResponseSchema.parse(response)).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440001",
      code: "M001",
      name: "Lobby",
      locationLabel: null,
      geoLocation: {
        latitude: 31.2304,
        longitude: 121.4737,
        timezone: "Asia/Shanghai",
      },
      status: "offline",
      mqttClientId: null,
      lastSeenAt: null,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:01:00.000Z",
    });
    expect(response).not.toHaveProperty("geoLatitude");
    expect(response).not.toHaveProperty("deletedAt");
  });

  it("maps database-shaped slot and command rows into strict admin responses", () => {
    const slot = toAdminMachineSlotResponse({
      id: "550e8400-e29b-41d4-a716-446655440003",
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      layerNo: 1,
      cellNo: 2,
      slotCode: "A2",
      capacity: 10,
      status: "enabled",
      createdAt: new Date("2026-07-05T00:00:00.000Z"),
      updatedAt: new Date("2026-07-05T00:01:00.000Z"),
      deletedAt: null,
    } as never);
    const command = toAdminMachineCommandResponse({
      id: "550e8400-e29b-41d4-a716-446655440004",
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      commandNo: "MCMD202607050001",
      type: "environment-control",
      status: "sent",
      payloadJson: { airConditionerOn: true },
      resultJson: null,
      lastError: null,
      createdAt: new Date("2026-07-05T00:00:00.000Z"),
      updatedAt: new Date("2026-07-05T00:01:00.000Z"),
    } as never);

    expect(adminMachineSlotResponseSchema.parse(slot).createdAt).toBe(
      "2026-07-05T00:00:00.000Z",
    );
    expect(adminMachineCommandResponseSchema.parse(command)).toMatchObject({
      id: "550e8400-e29b-41d4-a716-446655440004",
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      status: "sent",
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:01:00.000Z",
    });
  });

  it("maps database-shaped machine remote ops into strict admin responses", () => {
    const response = toAdminMachineRemoteOpResponse({
      id: "550e8400-e29b-41d4-a716-446655440005",
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      type: "export_logs",
      status: "pending",
      requestedAt: new Date("2026-07-05T00:00:00.000Z"),
      requestedByAdminUserId: "550e8400-e29b-41d4-a716-446655440002",
      acceptedAt: null,
      finishedAt: null,
      failedReason: null,
      resultJson: null,
    } as never);

    expect(adminMachineRemoteOpResponseSchema.parse(response)).toMatchObject({
      id: "550e8400-e29b-41d4-a716-446655440005",
      machineId: "550e8400-e29b-41d4-a716-446655440001",
      requestedAt: "2026-07-05T00:00:00.000Z",
      requestedByAdminUserId: "550e8400-e29b-41d4-a716-446655440002",
    });
  });
});
