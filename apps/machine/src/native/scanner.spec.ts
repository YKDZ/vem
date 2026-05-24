import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeOptionalMock, isTauriRuntimeMock, listenMock } = vi.hoisted(
  () => ({
    invokeOptionalMock: vi.fn(),
    isTauriRuntimeMock: vi.fn(),
    listenMock: vi.fn(),
  }),
);

vi.mock("./tauri", () => ({
  invokeOptional: invokeOptionalMock,
  isTauriRuntime: isTauriRuntimeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import {
  listenPaymentCodeScanned,
  scannerSelfCheck,
  startScanner,
} from "./scanner";

beforeEach(() => {
  vi.clearAllMocks();
  isTauriRuntimeMock.mockReturnValue(false);
});

describe("native scanner bridge", () => {
  it("returns browser fallback self-check when optional invoke is unavailable", async () => {
    invokeOptionalMock.mockResolvedValue(null);

    const result = await scannerSelfCheck();

    expect(result.online).toBe(false);
    expect(result.adapter).toBe("browser");
  });

  it("forwards start_scanner via optional invoke", async () => {
    invokeOptionalMock.mockResolvedValue(null);

    await startScanner();

    expect(invokeOptionalMock).toHaveBeenCalledWith("start_scanner");
  });

  it("forwards tauri scanner event payload to handler", async () => {
    isTauriRuntimeMock.mockReturnValue(true);
    const unlisten = vi.fn();
    listenMock.mockImplementation(async (_event, handler) => {
      handler({
        payload: {
          authCode: "28763443825664394",
          maskedCode: "2876****4394",
          source: "tauri_scanner",
          scannedAtMs: 1,
        },
      });
      return unlisten;
    });
    const handler = vi.fn();

    const dispose = await listenPaymentCodeScanned(handler);

    expect(handler).toHaveBeenCalledWith({
      authCode: "28763443825664394",
      maskedCode: "2876****4394",
      source: "tauri_scanner",
      scannedAtMs: 1,
    });
    expect(dispose).toBe(unlisten);
  });
});
