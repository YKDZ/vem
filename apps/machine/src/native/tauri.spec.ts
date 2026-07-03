import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { callTauriCommand } from "./tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Tauri command wrapper", () => {
  it("maps invoke failures to command-scoped errors", async () => {
    invokeMock.mockRejectedValue(new Error("native output unavailable"));

    await expect(callTauriCommand("play_machine_audio")).rejects.toThrow(
      "play_machine_audio failed: native output unavailable",
    );
  });
});
