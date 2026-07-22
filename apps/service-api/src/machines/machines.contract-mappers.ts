import type {
  AdminMachineCommandResponse,
  AdminMachineRemoteOpResponse,
  AdminMachineResponse,
  AdminMachineSlotResponse,
  MachineEnvironmentControlRequest,
  MachineHeartbeatStatusPayload,
} from "@vem/shared";
import type {
  AdminCreateMachineRequest,
  AdminCreateMachineSlotRequest,
  AdminUpdateMachineRequest,
} from "@vem/shared";

import {
  machineCommands,
  machineRemoteOps,
  machines,
  machineSlots,
} from "@vem/db";

type MachineInsert = typeof machines.$inferInsert;
type MachineSlotInsert = typeof machineSlots.$inferInsert;
type MachineCommandInsert = typeof machineCommands.$inferInsert;
type Patch<T> = { [K in keyof T]?: T[K] | undefined };
type MachinePatch = Patch<MachineInsert>;
type ContractFieldCoverage<T> = Record<keyof T, unknown>;

type MachineGeoLocation = {
  latitude: number;
  longitude: number;
  timezone: string;
};

type EnvironmentControlCommandInput = {
  machineId: string;
  adminUserId: string;
  commandNo: string;
  input: MachineEnvironmentControlRequest;
  timeoutSeconds: number;
  now: Date;
};

type MachineResponseRow = Pick<
  typeof machines.$inferSelect,
  | "id"
  | "code"
  | "name"
  | "locationLabel"
  | "geoLatitude"
  | "geoLongitude"
  | "geoTimezone"
  | "status"
  | "mqttClientId"
  | "lastSeenAt"
  | "createdAt"
  | "updatedAt"
>;
type MachineCommandResponseRow = typeof machineCommands.$inferSelect;
type MachineRemoteOpResponseRow = typeof machineRemoteOps.$inferSelect;
type MachineResponseExtras = {
  latestHeartbeatStatus?: AdminMachineResponse["latestHeartbeatStatus"];
  latestHeartbeatReportedAt?: Date | string | null;
  latestEnvironment?: AdminMachineResponse["latestEnvironment"];
  reportedRuntimeConfiguration?: AdminMachineResponse["reportedRuntimeConfiguration"];
  latestEnvironmentCommand?: MachineCommandResponseRow | null;
};

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null;
}

function toJsonRecordOrNull(
  value: unknown,
): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  return typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function machineGeoLocationValues(
  geoLocation: MachineGeoLocation | null | undefined,
): Pick<MachineInsert, "geoLatitude" | "geoLongitude" | "geoTimezone"> {
  if (geoLocation === undefined) {
    return {
      geoLatitude: undefined,
      geoLongitude: undefined,
      geoTimezone: undefined,
    };
  }
  return geoLocation === null
    ? { geoLatitude: null, geoLongitude: null, geoTimezone: null }
    : {
        geoLatitude: geoLocation.latitude,
        geoLongitude: geoLocation.longitude,
        geoTimezone: geoLocation.timezone,
      };
}

function machineGeoLocationFromRow(
  row: Pick<MachineResponseRow, "geoLatitude" | "geoLongitude" | "geoTimezone">,
): MachineGeoLocation | null {
  if (
    typeof row.geoLatitude !== "number" ||
    typeof row.geoLongitude !== "number" ||
    typeof row.geoTimezone !== "string"
  ) {
    return null;
  }
  return {
    latitude: row.geoLatitude,
    longitude: row.geoLongitude,
    timezone: row.geoTimezone,
  };
}

export function mapCreateMachineDtoToInsert(
  input: AdminCreateMachineRequest,
): MachineInsert {
  const dto = {
    code: input.code,
    name: input.name,
    locationLabel: input.locationLabel,
    geoLocation: input.geoLocation,
  } satisfies ContractFieldCoverage<AdminCreateMachineRequest>;

  const insert = {
    code: dto.code,
    name: dto.name,
    locationLabel: dto.locationLabel ?? null,
    ...machineGeoLocationValues(dto.geoLocation),
  } satisfies MachineInsert;
  return insert;
}

export function mapUpdateMachineDtoToPatch(
  input: AdminUpdateMachineRequest,
): MachinePatch {
  const dto = {
    code: input.code,
    name: input.name,
    locationLabel: input.locationLabel,
    geoLocation: input.geoLocation,
    status: input.status,
    mqttClientId: input.mqttClientId,
  } satisfies ContractFieldCoverage<AdminUpdateMachineRequest>;

  const patch = {
    code: dto.code,
    name: dto.name,
    locationLabel: dto.locationLabel,
    ...machineGeoLocationValues(dto.geoLocation),
    status: dto.status,
    mqttClientId: dto.mqttClientId,
    updatedAt: new Date(),
  } satisfies MachinePatch;
  return patch;
}

export function mapCreateMachineSlotDtoToInsert(
  machineId: string,
  input: AdminCreateMachineSlotRequest,
): MachineSlotInsert {
  const dto = {
    rowNo: input.rowNo,
    cellNo: input.cellNo,
    capacity: input.capacity,
    status: input.status,
  } satisfies ContractFieldCoverage<AdminCreateMachineSlotRequest>;

  const insert = {
    machineId,
    rowNo: dto.rowNo,
    cellNo: dto.cellNo,
    capacity: dto.capacity,
    status: dto.status,
  } satisfies MachineSlotInsert;
  return insert;
}

export function mapEnvironmentControlDtoToCommandInsert(
  input: EnvironmentControlCommandInput,
): MachineCommandInsert {
  const dto = {
    airConditionerOn: input.input.airConditionerOn,
    targetTemperatureCelsius: input.input.targetTemperatureCelsius,
    ventSpeed: input.input.ventSpeed,
  } satisfies ContractFieldCoverage<MachineEnvironmentControlRequest>;

  const payloadJson = {
    commandNo: input.commandNo,
    ...(dto.airConditionerOn === undefined
      ? {}
      : { airConditionerOn: dto.airConditionerOn }),
    ...(dto.targetTemperatureCelsius === undefined
      ? {}
      : { targetTemperatureCelsius: dto.targetTemperatureCelsius }),
    ...(dto.ventSpeed === undefined ? {} : { ventSpeed: dto.ventSpeed }),
    timeoutSeconds: input.timeoutSeconds,
  };

  const insert = {
    commandNo: input.commandNo,
    machineId: input.machineId,
    type: "environment-control",
    status: "pending",
    payloadJson,
    timeoutAt: new Date(input.now.getTime() + input.timeoutSeconds * 1_000),
    requestedByAdminUserId: input.adminUserId,
  } satisfies MachineCommandInsert;
  return insert;
}

export function toAdminMachineResponse(
  row: MachineResponseRow & MachineResponseExtras,
): AdminMachineResponse {
  const response = {
    id: row.id,
    code: row.code,
    name: row.name,
    locationLabel: row.locationLabel,
    geoLocation: machineGeoLocationFromRow(row),
    status: row.status,
    mqttClientId: row.mqttClientId,
    lastSeenAt: toIsoStringOrNull(row.lastSeenAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    ...(row.latestHeartbeatStatus === undefined
      ? {}
      : { latestHeartbeatStatus: row.latestHeartbeatStatus }),
    ...(row.latestHeartbeatReportedAt === undefined
      ? {}
      : {
          latestHeartbeatReportedAt: toIsoStringOrNull(
            row.latestHeartbeatReportedAt,
          ),
        }),
    ...(row.latestEnvironment === undefined
      ? {}
      : { latestEnvironment: row.latestEnvironment }),
    ...(row.reportedRuntimeConfiguration === undefined
      ? {}
      : { reportedRuntimeConfiguration: row.reportedRuntimeConfiguration }),
    ...(row.latestEnvironmentCommand === undefined
      ? {}
      : {
          latestEnvironmentCommand: row.latestEnvironmentCommand
            ? toAdminMachineCommandResponse(row.latestEnvironmentCommand)
            : null,
        }),
  } satisfies AdminMachineResponse;
  return response;
}

export function toAdminMachineHeartbeatStatus(
  status: MachineHeartbeatStatusPayload | null | undefined,
): AdminMachineResponse["latestHeartbeatStatus"] {
  if (!status) return null;
  return {
    ...(status.appVersion === undefined
      ? {}
      : { appVersion: status.appVersion }),
    ...(status.os === undefined ? {} : { os: status.os }),
    ...(status.network === undefined ? {} : { network: status.network }),
    ...(status.mqttConnected === undefined
      ? {}
      : { mqttConnected: status.mqttConnected }),
    ...(status.hardwareStatus === undefined
      ? {}
      : { hardwareStatus: status.hardwareStatus }),
    ...(status.wholeMachineMaintenanceLock === undefined
      ? {}
      : { wholeMachineMaintenanceLock: status.wholeMachineMaintenanceLock }),
    ...(status.doorOpen === undefined ? {} : { doorOpen: status.doorOpen }),
    ...(status.localQueueSize === undefined
      ? {}
      : { localQueueSize: status.localQueueSize }),
    ...(status.lastCommandNo === undefined
      ? {}
      : { lastCommandNo: status.lastCommandNo }),
  };
}

export function toAdminMachineSlotResponse(
  row: typeof machineSlots.$inferSelect,
): AdminMachineSlotResponse {
  const response = {
    id: row.id,
    machineId: row.machineId,
    rowNo: row.rowNo,
    cellNo: row.cellNo,
    capacity: row.capacity,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    deletedAt: row.deletedAt ? toIsoString(row.deletedAt) : null,
  } satisfies AdminMachineSlotResponse;
  return response;
}

export function toAdminMachineCommandResponse(
  row: MachineCommandResponseRow,
): AdminMachineCommandResponse {
  const response = {
    id: row.id,
    machineId: row.machineId,
    commandNo: row.commandNo,
    type: row.type,
    status: row.status,
    payloadJson: toJsonRecordOrNull(row.payloadJson),
    resultJson: toJsonRecordOrNull(row.resultJson),
    lastError: row.lastError,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  } satisfies AdminMachineCommandResponse;
  return response;
}

export function toAdminMachineRemoteOpResponse(
  row: MachineRemoteOpResponseRow,
): AdminMachineRemoteOpResponse {
  const response = {
    id: row.id,
    machineId: row.machineId,
    type: row.type,
    status: row.status,
    requestedAt: toIsoString(row.requestedAt),
    requestedByAdminUserId: row.requestedByAdminUserId,
    acceptedAt: toIsoStringOrNull(row.acceptedAt),
    finishedAt: toIsoStringOrNull(row.finishedAt),
    failedReason: row.failedReason,
    resultJson: toJsonRecordOrNull(row.resultJson),
  } satisfies AdminMachineRemoteOpResponse;
  return response;
}
