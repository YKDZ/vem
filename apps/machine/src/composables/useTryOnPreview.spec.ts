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

    expect(preview.errorMessage.value).toBe(
      "虚拟试穿预览启动失败，请联系维护人员检查视觉服务与摄像头。",
    );
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
      }),
    );
  });
});
