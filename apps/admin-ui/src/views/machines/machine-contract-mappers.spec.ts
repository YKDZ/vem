import { describe, expect, it } from "vitest";

import {
  mapEnvironmentControlFormToContract,
  mapMachineBasicsFormToUpdateContract,
  mapMachineFormToContract,
  mapSlotFormToContract,
} from "./machine-contract-mappers";

describe("Machine Operations form contract mappers", () => {
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
      mapEnvironmentControlFormToContract({
        includeAirConditioner: false,
        airConditionerOn: false,
        includeTargetTemperature: true,
        targetTemperatureCelsius: 24,
      }),
    ).toEqual({ targetTemperatureCelsius: 24 });
  });

  it("maps slot forms through hardware coordinate validation", () => {
    expect(
      mapSlotFormToContract({
        layerNo: 1,
        cellNo: 2,
        capacity: 10,
        status: "enabled",
      }),
    ).toEqual({
      layerNo: 1,
      cellNo: 2,
      slotCode: "R1C2",
      capacity: 10,
      status: "enabled",
    });
    expect(() =>
      mapSlotFormToContract({
        layerNo: 7,
        cellNo: 5,
        capacity: 10,
        status: "enabled",
      }),
    ).toThrow();
  });
});
