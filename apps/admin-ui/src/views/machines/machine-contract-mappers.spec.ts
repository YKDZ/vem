import { describe, expect, it } from "vitest";

import {
  environmentControlFormFromProjection,
  mapEnvironmentControlFormToContract,
  mapMachineBasicsFormToUpdateContract,
  mapMachineFormToContract,
  mapSlotFormToContract,
} from "./machine-contract-mappers";

describe("Machine Operations form contract mappers", () => {
  it("initializes controls only from the daemon heartbeat projection", () => {
    expect(
      environmentControlFormFromProjection({
        sensorStatus: "ok",
        control: {
          snapshot: {
            schemaVersion: "vem-environment-control/v1",
            revision: 7,
            settings: {
              airConditionerEnabled: true,
              targetTemperatureCelsius: 26,
              baseVentSpeed: 3,
            },
            desired: {
              airConditionerEnabled: true,
              targetTemperatureCelsius: 26,
              ventSpeed: 0,
            },
            confirmed: {
              airConditionerEnabled: true,
              targetTemperatureCelsius: 26,
              ventSpeed: 0,
            },
            convergence: "applied",
            reasonCode: "hardware_confirmed",
            message: null,
            lastAction: null,
            updatedAt: "2026-08-24T10:00:00.000Z",
            lastAttemptAt: "2026-08-24T10:00:00.000Z",
            confirmedAt: "2026-08-24T10:00:00.000Z",
          },
          observedAt: "2026-08-24T10:00:05.000Z",
          stale: false,
        },
      }),
    ).toEqual({
      airConditionerOn: true,
      targetTemperatureCelsius: 26,
      ventSpeed: 3,
    });
    expect(
      environmentControlFormFromProjection({ sensorStatus: "unknown" }),
    ).toBeNull();
  });

  it("maps machine form fields into the shared admin machine contract", () => {
    expect(
      mapMachineFormToContract({
        code: " M-001 ",
        name: " Lobby ",
        locationLabel: "",
        includeGeoLocation: true,
        geoLatitude: 31.2,
        geoLongitude: 121.5,
        geoTimezone: " Asia/Shanghai ",
      }),
    ).toEqual({
      code: "M-001",
      name: "Lobby",
      locationLabel: null,
      geoLocation: {
        latitude: 31.2,
        longitude: 121.5,
        timezone: "Asia/Shanghai",
      },
    });
  });

  it("maps disabled geo location to an explicit null", () => {
    expect(
      mapMachineFormToContract({
        code: "M-001",
        name: "Lobby",
        locationLabel: "1F",
        includeGeoLocation: false,
        geoLatitude: null,
        geoLongitude: null,
        geoTimezone: "Asia/Shanghai",
      }),
    ).toMatchObject({ geoLocation: null });
  });

  it("maps machine detail basics update without editable machine code", () => {
    expect(
      mapMachineBasicsFormToUpdateContract({
        name: " Lobby ",
        locationLabel: " 位置 A ",
        includeGeoLocation: false,
        geoLatitude: null,
        geoLongitude: null,
        geoTimezone: "Asia/Shanghai",
      }),
    ).toEqual({
      name: "Lobby",
      locationLabel: "位置 A",
      geoLocation: null,
    });
  });

  it("maps environment control checkboxes into the shared command contract", () => {
    expect(
      mapEnvironmentControlFormToContract(
        {
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
          ventSpeed: 2,
        },
        "airConditionerOn",
        true,
      ),
    ).toEqual({ airConditionerOn: true });

    expect(
      mapEnvironmentControlFormToContract(
        {
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
          ventSpeed: 2,
        },
        "targetTemperatureCelsius",
        27,
      ),
    ).toEqual({ targetTemperatureCelsius: 27 });

    expect(
      mapEnvironmentControlFormToContract(
        {
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
          ventSpeed: 2,
        },
        "ventSpeed",
        4,
      ),
    ).toEqual({ ventSpeed: 4 });
  });

  it("maps slot forms through hardware coordinate validation", () => {
    expect(
      mapSlotFormToContract({
        rowNo: 1,
        cellNo: 2,
        capacity: 10,
        status: "enabled",
      }),
    ).toEqual({
      rowNo: 1,
      cellNo: 2,
      capacity: 10,
      status: "enabled",
    });
    expect(() =>
      mapSlotFormToContract({
        rowNo: 7,
        cellNo: 5,
        capacity: 10,
        status: "enabled",
      }),
    ).toThrow();
  });

  it("rejects out-of-range independent action values", () => {
    expect(() =>
      mapEnvironmentControlFormToContract(
        {
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
          ventSpeed: 2,
        },
        "targetTemperatureCelsius",
        31,
      ),
    ).toThrow();

    expect(() =>
      mapEnvironmentControlFormToContract(
        {
          airConditionerOn: false,
          targetTemperatureCelsius: 24,
          ventSpeed: 2,
        },
        "ventSpeed",
        5,
      ),
    ).toThrow();
  });
});
