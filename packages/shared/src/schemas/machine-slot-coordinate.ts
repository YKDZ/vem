import { z } from "zod";

export const MACHINE_SLOT_HARDWARE_LAYOUT = {
  minRowNo: 1,
  bands: [
    { maxRowNo: 6, maxCellNo: 5 },
    { maxRowNo: 8, maxCellNo: 4 },
    { maxRowNo: 9, maxCellNo: 3 },
  ],
} as const;

export const MACHINE_SLOT_MIN_ROW_NO = MACHINE_SLOT_HARDWARE_LAYOUT.minRowNo;
export const MACHINE_SLOT_MAX_ROW_NO =
  MACHINE_SLOT_HARDWARE_LAYOUT.bands[
    MACHINE_SLOT_HARDWARE_LAYOUT.bands.length - 1
  ].maxRowNo;
export const MACHINE_SLOT_LOWER_MAX_ROW_NO =
  MACHINE_SLOT_HARDWARE_LAYOUT.bands[0].maxRowNo;
export const MACHINE_SLOT_LOWER_MAX_CELL_NO =
  MACHINE_SLOT_HARDWARE_LAYOUT.bands[0].maxCellNo;
export const MACHINE_SLOT_UPPER_MAX_CELL_NO =
  MACHINE_SLOT_HARDWARE_LAYOUT.bands[
    MACHINE_SLOT_HARDWARE_LAYOUT.bands.length - 1
  ].maxCellNo;

export const machineSlotRowNoSchema = z
  .int()
  .min(MACHINE_SLOT_MIN_ROW_NO)
  .max(MACHINE_SLOT_MAX_ROW_NO);

export const machineSlotCellNoSchema = z
  .int()
  .min(1)
  .max(MACHINE_SLOT_LOWER_MAX_CELL_NO);

export type MachineSlotCoordinateInput = {
  rowNo?: number;
  cellNo?: number;
};

export function getMachineSlotMaxCellNo(rowNo: number): number | null {
  if (!Number.isInteger(rowNo)) return null;
  if (rowNo < MACHINE_SLOT_HARDWARE_LAYOUT.minRowNo) return null;
  for (const band of MACHINE_SLOT_HARDWARE_LAYOUT.bands) {
    if (rowNo <= band.maxRowNo) return band.maxCellNo;
  }
  return null;
}

export function machineSlotCoordinateErrorMessage(
  input: MachineSlotCoordinateInput,
): string | null {
  if (typeof input.rowNo !== "number" || !Number.isInteger(input.rowNo)) {
    return "rowNo must be an integer";
  }
  if (
    input.rowNo < MACHINE_SLOT_MIN_ROW_NO ||
    input.rowNo > MACHINE_SLOT_MAX_ROW_NO
  ) {
    return `rowNo ${input.rowNo} is out of hardware bounds (${MACHINE_SLOT_MIN_ROW_NO}-${MACHINE_SLOT_MAX_ROW_NO})`;
  }
  if (typeof input.cellNo !== "number" || !Number.isInteger(input.cellNo)) {
    return "cellNo must be an integer";
  }
  const maxCellNo = getMachineSlotMaxCellNo(input.rowNo);
  if (maxCellNo === null) {
    return `rowNo ${input.rowNo} is out of hardware bounds (${MACHINE_SLOT_MIN_ROW_NO}-${MACHINE_SLOT_MAX_ROW_NO})`;
  }
  if (input.cellNo < 1 || input.cellNo > maxCellNo) {
    return `cellNo ${input.cellNo} is out of hardware bounds for row ${input.rowNo} (1-${maxCellNo})`;
  }
  return null;
}

export function isValidMachineSlotCoordinate(
  input: MachineSlotCoordinateInput,
): boolean {
  return machineSlotCoordinateErrorMessage(input) === null;
}

function formatCoordinatePart(value: number | undefined): string {
  return typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : "--";
}

export function formatMachineSlotCoordinate(
  input: MachineSlotCoordinateInput,
): string {
  return `行 ${formatCoordinatePart(input.rowNo)} / 格 ${formatCoordinatePart(input.cellNo)}`;
}

export function machineSlotCoordinateCode(
  input: MachineSlotCoordinateInput,
): string {
  return `R${formatCoordinatePart(input.rowNo)}C${formatCoordinatePart(input.cellNo)}`;
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
    path: message.startsWith("rowNo") ? ["rowNo"] : ["cellNo"],
    message,
  });
}
