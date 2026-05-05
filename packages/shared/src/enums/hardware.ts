import { z } from "zod";

export const hardwareErrorCodeSchema = z.enum([
  "NO_DROP",
  "JAMMED",
  "DOOR_OPEN",
  "MOTOR_TIMEOUT",
  "UNKNOWN",
]);
export type HardwareErrorCode = z.infer<typeof hardwareErrorCodeSchema>;
export const hardwareErrorCodes = hardwareErrorCodeSchema.options;
