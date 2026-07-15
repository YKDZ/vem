// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";

const {
  getVisionCameraMaintenanceContractMock,
  refreshVisionCameraMaintenanceContractMock,
  getVisionCameraMaintenancePreviewBlobMock,
  testVisionCameraRoleMock,
  confirmVisionCameraRoleMock,
} = vi.hoisted(() => ({
  getVisionCameraMaintenanceContractMock: vi.fn(),
  refreshVisionCameraMaintenanceContractMock: vi.fn(),
  getVisionCameraMaintenancePreviewBlobMock: vi.fn(),
  testVisionCameraRoleMock: vi.fn(),
  confirmVisionCameraRoleMock: vi.fn(),
}));

vi.mock("@/daemon/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/daemon/client")>();
  return {
    ...actual,
    daemonClient: {
      getVisionCameraMaintenanceContract:
        getVisionCameraMaintenanceContractMock,
      refreshVisionCameraMaintenanceContract:
        refreshVisionCameraMaintenanceContractMock,
      getVisionCameraMaintenancePreviewBlob:
        getVisionCameraMaintenancePreviewBlobMock,
      testVisionCameraRole: testVisionCameraRoleMock,
      confirmVisionCameraRole: confirmVisionCameraRoleMock,
    },
  };
});

import VisionCameraMaintenancePanel from "./VisionCameraMaintenancePanel.vue";

let mountedApp: App<Element> | null = null;

function contract() {
  return {
    contractVersion: "vem.vision.camera-maintenance/v2",
    generation: "generation-42",
    candidates: [
      {
        id: "usb#top-001",
        label: "Top Camera",
        backendObservation: {
          backend: "directshow",
          index: 3,
          available: true,
          mappingState: "proven",
        },
      },
    ],
    roles: {
      top: {
        role: "top",
        state: "missing",
        ready: false,
        candidateId: "usb#top-001",
        reason: "bound_camera_missing",
        backendObservation: {
          backend: "directshow",
          index: 3,
          available: false,
          mappingState: "proven",
        },
      },
      front: {
        role: "front",
        state: "unbound",
        ready: false,
        reason: "camera_not_confirmed",
      },
    },
  };
}

async function render(props: {
  maintenanceAuthorized: boolean;
  mode: "bring-up" | "maintenance";
}) {
  document.body.innerHTML = '<div id="app"></div>';
  const app = createApp(VisionCameraMaintenancePanel, props);
  mountedApp = app;
  app.mount("#app");
  await nextTick();
  return document.querySelector<HTMLElement>("#app")!;
}

describe("VisionCameraMaintenancePanel", () => {
  beforeEach(() => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:vision-preview"),
      revokeObjectURL: vi.fn(),
    });
    getVisionCameraMaintenanceContractMock.mockResolvedValue(contract());
    refreshVisionCameraMaintenanceContractMock.mockResolvedValue(contract());
    getVisionCameraMaintenancePreviewBlobMock.mockResolvedValue(
      new Blob(["preview"], { type: "image/jpeg" }),
    );
    testVisionCameraRoleMock.mockResolvedValue({
      role: "top",
      candidateId: "usb#top-001",
      generation: "generation-42",
      ok: true,
      frame: { width: 1280, height: 720 },
      backendObservation: {
        backend: "directshow",
        index: 3,
        available: true,
        mappingState: "proven",
      },
      evidence: {
        id: "evidence-1",
        role: "top",
        candidateId: "usb#top-001",
        generation: "generation-42",
        expiresAt: 1_752_570_000,
      },
    });
    confirmVisionCameraRoleMock.mockResolvedValue({
      role: "top",
      state: "ready",
      ready: true,
      candidateId: "usb#top-001",
      backendObservation: {
        backend: "directshow",
        index: 3,
        available: true,
        mappingState: "proven",
      },
    });
  });

  afterEach(() => {
    mountedApp?.unmount();
    mountedApp = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads and renders the contract after maintenance authorization", async () => {
    const host = await render({
      maintenanceAuthorized: true,
      mode: "maintenance",
    });

    expect(getVisionCameraMaintenanceContractMock).toHaveBeenCalled();
    expect(host.textContent).toContain("vem.vision.camera-maintenance/v2");
    expect(host.textContent).toContain("缺失硬件");
    expect(host.textContent).toContain(
      "这会阻塞视觉硬件验收，但不是软件安装失败",
    );
  });

  it("tests and confirms a role using generation-scoped evidence", async () => {
    const host = await render({
      maintenanceAuthorized: true,
      mode: "bring-up",
    });

    const testButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("测试顶部角色"),
    );
    testButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await nextTick();
    await nextTick();

    expect(testVisionCameraRoleMock).toHaveBeenCalledWith("top", {
      candidateId: "usb#top-001",
    });

    const confirmButton = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("确认顶部角色"),
    );
    expect(confirmButton?.hasAttribute("disabled")).toBe(false);
    confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    expect(confirmVisionCameraRoleMock).toHaveBeenCalledWith("top", {
      candidateId: "usb#top-001",
      testEvidenceId: "evidence-1",
      operatorVisualConfirmation: true,
      expectedGeneration: "generation-42",
    });
  });
});
