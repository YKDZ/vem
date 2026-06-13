import { z } from "zod";

export const MACHINE_SLOT_MIN_LAYER_NO = 1;
export const MACHINE_SLOT_MAX_LAYER_NO = 10;
export const MACHINE_SLOT_LOWER_MAX_LAYER_NO = 6;
export const MACHINE_SLOT_LOWER_MAX_CELL_NO = 5;
export const MACHINE_SLOT_UPPER_MAX_CELL_NO = 4;

export const machineSlotLayerNoSchema = z
  .int()
  .min(MACHINE_SLOT_MIN_LAYER_NO)
  .max(MACHINE_SLOT_MAX_LAYER_NO);

export const machineSlotCellNoSchema = z
  .int()
  .min(1)
  .max(MACHINE_SLOT_LOWER_MAX_CELL_NO);

export type MachineSlotCoordinateInput = {
  layerNo?: number;
  cellNo?: number;
};

export function getMachineSlotMaxCellNo(layerNo: number): number | null {
  if (!Number.isInteger(layerNo)) return null;
  if (
    layerNo >= MACHINE_SLOT_MIN_LAYER_NO &&
    layerNo <= MACHINE_SLOT_LOWER_MAX_LAYER_NO
  ) {
    return MACHINE_SLOT_LOWER_MAX_CELL_NO;
  }
  if (
    layerNo > MACHINE_SLOT_LOWER_MAX_LAYER_NO &&
    layerNo <= MACHINE_SLOT_MAX_LAYER_NO
  ) {
    return MACHINE_SLOT_UPPER_MAX_CELL_NO;
  }
  return null;
}

export function machineSlotCoordinateErrorMessage(
  input: MachineSlotCoordinateInput,
): string | null {
  if (typeof input.layerNo !== "number" || !Number.isInteger(input.layerNo)) {
    return "layerNo must be an integer";
  }
  if (
    input.layerNo < MACHINE_SLOT_MIN_LAYER_NO ||
    input.layerNo > MACHINE_SLOT_MAX_LAYER_NO
  ) {
    return `layerNo ${input.layerNo} is out of hardware bounds (${MACHINE_SLOT_MIN_LAYER_NO}-${MACHINE_SLOT_MAX_LAYER_NO})`;
  }
  if (typeof input.cellNo !== "number" || !Number.isInteger(input.cellNo)) {
    return "cellNo must be an integer";
  }
  const maxCellNo = getMachineSlotMaxCellNo(input.layerNo);
  if (maxCellNo === null) {
    return `layerNo ${input.layerNo} is out of hardware bounds (${MACHINE_SLOT_MIN_LAYER_NO}-${MACHINE_SLOT_MAX_LAYER_NO})`;
  }
  if (input.cellNo < 1 || input.cellNo > maxCellNo) {
    return `cellNo ${input.cellNo} is out of hardware bounds for row ${input.layerNo} (1-${maxCellNo})`;
  }
  return null;
}

export function isValidMachineSlotCoordinate(
  input: MachineSlotCoordinateInput,
): boolean {
  return machineSlotCoordinateErrorMessage(input) === null;
}

export function addMachineSlotCoordinateIssue(
  input: MachineSlotCoordinateInput,
  ctx: {
    addIssue(issue: {
      code: "custom";
      path: Array<keyof MachineSlotCoordinateInput>;
      message: string;
    }): void;
  },
): void {
  const message = machineSlotCoordinateErrorMessage(input);
  if (!message) return;
  ctx.addIssue({
    code: "custom",
    path: message.startsWith("layerNo") ? ["layerNo"] : ["cellNo"],
    message,
  });
}
