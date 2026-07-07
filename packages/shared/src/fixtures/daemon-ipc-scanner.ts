import type { DaemonIpcScannerStatus } from "../schemas/daemon-ipc";

export const validDaemonIpcScannerStatuses = {
  readySerial: {
    online: true,
    adapter: "serial_text",
    port: "COM4",
    level: "ok",
    code: "SCANNER_READY",
    message: "scanner ready",
    updatedAt: "2026-06-11T06:16:32.320Z",
  },
  disabled: {
    online: false,
    adapter: "disabled",
    port: null,
    level: "offline",
    code: "SCANNER_DISABLED",
    message: "scanner disabled",
    updatedAt: "2026-06-11T06:17:00.000Z",
  },
} satisfies Record<string, DaemonIpcScannerStatus>;

export const invalidDaemonIpcScannerStatuses = {
  unknownField: {
    ...validDaemonIpcScannerStatuses.readySerial,
    extraDaemonField: true,
  },
  missingCode: {
    online: true,
    adapter: "serial_text",
    port: "COM4",
    level: "ok",
    message: "scanner ready",
    updatedAt: "2026-06-11T06:16:32.320Z",
  },
} as const;
