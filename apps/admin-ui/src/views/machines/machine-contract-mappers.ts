import {
  createMachineSchema,
  createMachineSlotSchema,
  machineEnvironmentControlRequestSchema,
  machineSlotCoordinateCode,
  type AdminCreateMachineRequest,
  type AdminCreateMachineSlotRequest,
  type MachineEnvironmentControlRequest,
  type MachineSlotStatus,
} from "@vem/shared";
import { z } from "zod";

export type MachineForm = {
  code: string;
  name: string;
  locationLabel: string;
  includeGeoLocation: boolean;
  geoLatitude: number | null;
  geoLongitude: number | null;
  geoTimezone: string;
};

export type EnvironmentControlForm = {
  includeAirConditioner: boolean;
  airConditionerOn: boolean;
  includeTargetTemperature: boolean;
  targetTemperatureCelsius: number;
};

export type SlotForm = {
  layerNo: number;
  cellNo: number;
  capacity: number;
  status: MachineSlotStatus;
};

const machineFormSchema = z.strictObject({
  code: z.string(),
  name: z.string(),
  locationLabel: z.string(),
  includeGeoLocation: z.boolean(),
  geoLatitude: z.number().nullable(),
  geoLongitude: z.number().nullable(),
  geoTimezone: z.string(),
});

const environmentControlFormSchema = z.strictObject({
  includeAirConditioner: z.boolean(),
  airConditionerOn: z.boolean(),
  includeTargetTemperature: z.boolean(),
  targetTemperatureCelsius: z.number(),
});

const slotFormSchema = z.strictObject({
  layerNo: z.number(),
  cellNo: z.number(),
  capacity: z.number(),
  status: z.enum(["enabled", "disabled", "faulted"]),
});

function emptyStringToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function mapMachineFormToContract(
  form: MachineForm,
): AdminCreateMachineRequest {
  const parsed = machineFormSchema.parse(form);
  if (
    parsed.includeGeoLocation &&
    (typeof parsed.geoLatitude !== "number" ||
      typeof parsed.geoLongitude !== "number")
  ) {
    throw new Error("Machine Geo Location is incomplete");
  }
  const geoLocation = parsed.includeGeoLocation
    ? {
        latitude: parsed.geoLatitude as number,
        longitude: parsed.geoLongitude as number,
        timezone: parsed.geoTimezone.trim(),
      }
    : null;
  const contract = {
    code: parsed.code.trim(),
    name: parsed.name.trim(),
    locationLabel: emptyStringToNull(parsed.locationLabel),
    geoLocation,
  } satisfies z.input<typeof createMachineSchema>;
  return createMachineSchema.parse(contract);
}

export function mapEnvironmentControlFormToContract(
  form: EnvironmentControlForm,
): MachineEnvironmentControlRequest {
  const parsed = environmentControlFormSchema.parse(form);
  const contract = {
    ...(parsed.includeAirConditioner
      ? { airConditionerOn: parsed.airConditionerOn }
      : {}),
    ...(parsed.includeTargetTemperature
      ? { targetTemperatureCelsius: parsed.targetTemperatureCelsius }
      : {}),
  } satisfies z.input<typeof machineEnvironmentControlRequestSchema>;
  return machineEnvironmentControlRequestSchema.parse(contract);
}

export function mapSlotFormToContract(
  form: SlotForm,
): AdminCreateMachineSlotRequest {
  const parsed = slotFormSchema.parse(form);
  const contract = {
    layerNo: parsed.layerNo,
    cellNo: parsed.cellNo,
    slotCode: machineSlotCoordinateCode(parsed),
    capacity: parsed.capacity,
    status: parsed.status,
  } satisfies z.input<typeof createMachineSlotSchema>;
  return createMachineSlotSchema.parse(contract);
}
