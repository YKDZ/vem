import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { invokeOptional, isTauriRuntime } from "./tauri";

export type ScannerSelfCheckResult = {
  online: boolean;
  adapter: string;
  port?: string | null;
  message: string;
  checkedAtMs: number;
};

export type PaymentCodeScannedEvent = {
  authCode: string;
  maskedCode: string;
  source: "tauri_scanner";
  scannedAtMs: number;
};

export async function scannerSelfCheck(): Promise<ScannerSelfCheckResult> {
  const result =
    await invokeOptional<ScannerSelfCheckResult>("scanner_self_check");
  return (
    result ?? {
      online: false,
      adapter: "browser",
      port: null,
      message: "当前运行环境不是 Tauri，无法访问本地串口扫码模块",
      checkedAtMs: Date.now(),
    }
  );
}

export async function startScanner(): Promise<void> {
  await invokeOptional<void>("start_scanner");
}

export async function listenPaymentCodeScanned(
  handler: (event: PaymentCodeScannedEvent) => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => undefined;
  }
  return await listen<PaymentCodeScannedEvent>(
    "payment-code-scanned",
    (event) => {
      handler(event.payload);
    },
  );
}
