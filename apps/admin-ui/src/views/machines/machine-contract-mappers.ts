import {
  createMachineSchema,
  createMachineSlotSchema,
  machineEnvironmentControlRequestSchema,
  machineSlotCoordinateCode,
  updateMachineSchema,
  type AdminCreateMachineRequest,
  type AdminUpdateMachineRequest,
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

export type MachineBasicsForm = Omit<MachineForm, "code">;

export type EnvironmentControlForm = {
  airConditionerOn: boolean;
  targetTemperatureCelsius: number;
  ventSpeed: number;
};

export type EnvironmentControlAction =
  | "airConditionerOn"
  | "targetTemperatureCelsius"
  | "ventSpeed";

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
  airConditionerOn: z.boolean(),
  targetTemperatureCelsius: z.number(),
  ventSpeed: z.number().int().min(0).max(4),
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
  let geoLocation: z.input<typeof createMachineSchema>["geoLocation"] = null;
  if (parsed.includeGeoLocation) {
    if (
      typeof parsed.geoLatitude !== "number" ||
      typeof parsed.geoLongitude !== "number"
    ) {
      throw new Error("Machine Geo Location is incomplete");
    }
    geoLocation = {
      latitude: parsed.geoLatitude,
      longitude: parsed.geoLongitude,
      timezone: parsed.geoTimezone.trim(),
    };
  }
  const contract = {
    code: parsed.code.trim(),
    name: parsed.name.trim(),
    locationLabel: emptyStringToNull(parsed.locationLabel),
    geoLocation,
  } satisfies z.input<typeof createMachineSchema>;
  return createMachineSchema.parse(contract);
}

export function mapMachineBasicsFormToUpdateContract(
  form: MachineBasicsForm,
): AdminUpdateMachineRequest {
  const parsed = machineFormSchema.omit({ code: true }).parse(form);
  let geoLocation: z.input<typeof updateMachineSchema>["geoLocation"] = null;
  if (parsed.includeGeoLocation) {
    if (
      typeof parsed.geoLatitude !== "number" ||
      typeof parsed.geoLongitude !== "number"
    ) {
      throw new Error("Machine Geo Location is incomplete");
    }
    geoLocation = {
      latitude: parsed.geoLatitude,
      longitude: parsed.geoLongitude,
      timezone: parsed.geoTimezone.trim(),
    };
  }
  const contract = {
    name: parsed.name.trim(),
    locationLabel: emptyStringToNull(parsed.locationLabel),
    geoLocation,
  } satisfies z.input<typeof updateMachineSchema>;
  return updateMachineSchema.parse(contract);
}

export function mapEnvironmentControlFormToContract(
  form: EnvironmentControlForm,
  action: EnvironmentControlAction,
  value: boolean | number,
): MachineEnvironmentControlRequest {
  environmentControlFormSchema.parse(form);
  if (action === "airConditionerOn") {
    return machineEnvironmentControlRequestSchema.parse({
      airConditionerOn: z.boolean().parse(value),
    });
  }

  if (action === "targetTemperatureCelsius") {
    return machineEnvironmentControlRequestSchema.parse({
      targetTemperatureCelsius: z.number().min(18).max(30).parse(value),
    });
  }

  return machineEnvironmentControlRequestSchema.parse({
    ventSpeed: z.number().int().min(0).max(4).parse(value),
  });
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
