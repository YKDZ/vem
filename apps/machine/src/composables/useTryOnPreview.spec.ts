import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openVisionTryOnSessionMock } = vi.hoisted(() => ({
  openVisionTryOnSessionMock: vi.fn(),
}));

vi.mock("@/native/vision", () => ({
  openVisionTryOnSession: openVisionTryOnSessionMock,
  isVisionTryOnCapabilityDegraded: () => false,
}));

import { installCustomerErrorEvidenceTrace } from "@/runtime/customer-error-evidence";
import { createMachineRuntimeTrace } from "@/runtime/machine-runtime-trace";

import { useTryOnPreview } from "./useTryOnPreview";

describe("useTryOnPreview", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  afterEach(() => {
    installCustomerErrorEvidenceTrace(null);
  });

  it("records bounded technical evidence while keeping the start copy customer-safe", async () => {
    const trace = createMachineRuntimeTrace();
    installCustomerErrorEvidenceTrace(trace);
    const error = Object.assign(new Error("vision handshake failed"), {
      statusCode: 502,
      responseCode: "vision_unavailable",
      responseBody: "x".repeat(3_000),
      cause: new Error("camera unavailable"),
    });
    openVisionTryOnSessionMock.mockRejectedValue(error);
    const preview = useTryOnPreview();

    await preview.startPreview();

    expect(preview.errorMessage.value).toBe("设备暂不可用，请联系工作人员");
    expect(trace.entries()).toContainEqual(
      expect.objectContaining({
        type: "customer_error",
        stage: "device",
        customerMessage: "设备暂不可用，请联系工作人员",
        operation: "try_on.start_preview",
        technical: expect.objectContaining({
          message: "vision handshake failed",
          statusCode: 502,
          responseCode: "vision_unavailable",
          cause: "camera unavailable",
          responseBody: expect.stringMatching(/…$/),
        }),
        tryOnSessionId: null,
        tryOnCatalogKey: null,
        tryOnVariantId: null,
      }),
    );
  });

  it("records session-stop failures through the same recorder without exposing them", async () => {
    const trace = createMachineRuntimeTrace();
    installCustomerErrorEvidenceTrace(trace);
    const stopError = Object.assign(new Error("vision stop IPC failed"), {
      statusCode: 503,
      responseCode: "vision_stop_failed",
      responseBody: "stop response",
      cause: new Error("socket closed"),
    });
    const stop = vi.fn().mockRejectedValue(stopError);
    openVisionTryOnSessionMock.mockResolvedValue({
      sessionId: "try-on-1",
      previewUrl: "http://127.0.0.1:7892/try-on/try-on-1.mjpeg",
      streamType: "mjpeg",
      stop,
    });
    const preview = useTryOnPreview();

    await preview.startPreview();
    await preview.stopPreview();

    expect(preview.errorMessage.value).toBeNull();
    expect(trace.entries()).toContainEqual(
      expect.objectContaining({
        type: "customer_error",
        stage: "device",
        operation: "try_on.stop_preview",
        technical: expect.objectContaining({
          message: "vision stop IPC failed",
          statusCode: 503,
          responseCode: "vision_stop_failed",
          responseBody: "stop response",
          cause: "socket closed",
        }),
        tryOnSessionId: "try-on-1",
        tryOnCatalogKey: null,
        tryOnVariantId: null,
      }),
    );
  });

  it("correlates a failed preview validation with the returned try-on session", async () => {
    const trace = createMachineRuntimeTrace();
    installCustomerErrorEvidenceTrace(trace);
    openVisionTryOnSessionMock.mockResolvedValue({
      sessionId: "try-on-invalid-url",
      previewUrl: "https://vision.example/try-on/remote.mjpeg",
      streamType: "mjpeg",
      stop: vi.fn().mockResolvedValue(undefined),
    });
    const preview = useTryOnPreview();

    await preview.startPreview({
      catalogKey: "catalog-1",
      variantId: "variant-1",
    });

    expect(trace.entries()).toContainEqual(
      expect.objectContaining({
        type: "customer_error",
        operation: "try_on.start_preview",
        tryOnSessionId: "try-on-invalid-url",
        tryOnCatalogKey: "catalog-1",
        tryOnVariantId: "variant-1",
      }),
    );
  });

  it("records stale session cleanup failures without changing the current preview", async () => {
    const trace = createMachineRuntimeTrace();
    installCustomerErrorEvidenceTrace(trace);
    let resolveStaleSession!: (session: {
      sessionId: string;
      previewUrl: string;
      streamType: "mjpeg";
      stop: (reason?: "replaced") => Promise<void>;
    }) => void;
    const staleSession = new Promise<{
      sessionId: string;
      previewUrl: string;
      streamType: "mjpeg";
      stop: (reason?: "replaced") => Promise<void>;
    }>((resolve) => {
      resolveStaleSession = resolve;
    });
    const staleStopError = new Error("stale vision stop failed");
    const currentStop = vi.fn().mockResolvedValue(undefined);
    openVisionTryOnSessionMock
      .mockImplementationOnce(() => staleSession)
      .mockResolvedValueOnce({
        sessionId: "try-on-current",
        previewUrl: "http://127.0.0.1:7892/try-on/current.mjpeg",
        streamType: "mjpeg",
        stop: currentStop,
      });
    const preview = useTryOnPreview();

    const staleStart = preview.startPreview({
      catalogKey: "catalog-stale",
      variantId: "variant-stale",
    });
    await Promise.resolve();
    await preview.startPreview({
      catalogKey: "catalog-current",
      variantId: "variant-current",
    });
    resolveStaleSession({
      sessionId: "try-on-stale",
      previewUrl: "http://127.0.0.1:7892/try-on/stale.mjpeg",
      streamType: "mjpeg",
      stop: vi.fn().mockRejectedValue(staleStopError),
    });
    await staleStart;

    expect(preview.previewUrl.value).toBe(
      "http://127.0.0.1:7892/try-on/current.mjpeg",
    );
    expect(preview.errorMessage.value).toBeNull();
    expect(trace.entries()).toContainEqual(
      expect.objectContaining({
        type: "customer_error",
        operation: "try_on.cleanup_stale_session",
        tryOnSessionId: "try-on-stale",
        tryOnCatalogKey: "catalog-stale",
        tryOnVariantId: "variant-stale",
        technical: expect.objectContaining({
          message: "stale vision stop failed",
        }),
      }),
    );
  });
});
