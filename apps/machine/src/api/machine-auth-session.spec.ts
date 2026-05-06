import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearMachineAuthToken,
  getMachineAuthSessionState,
  getMachineAuthToken,
  setMachineAuthToken,
} from "./machine-auth-session";

const BASE_TIME = 1_700_000_000_000;

describe("machine-auth-session", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    clearMachineAuthToken();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearMachineAuthToken();
  });

  it("returns null before any token is set", () => {
    expect(getMachineAuthToken()).toBeNull();
  });

  it("returns token immediately after setting", () => {
    setMachineAuthToken("tok-123", 300);
    expect(getMachineAuthToken()).toBe("tok-123");
  });

  it("returns null when refresh window threshold reached (300-60 = 240s)", () => {
    setMachineAuthToken("tok-123", 300);
    vi.setSystemTime(BASE_TIME + 241_000);
    expect(getMachineAuthToken()).toBeNull();
  });

  it("returns token when within refresh window (240s - 1ms)", () => {
    setMachineAuthToken("tok-123", 300);
    vi.setSystemTime(BASE_TIME + 239_999);
    expect(getMachineAuthToken()).toBe("tok-123");
  });

  it("allowRefreshWindow=true still returns token during refresh window", () => {
    setMachineAuthToken("tok-123", 300);
    vi.setSystemTime(BASE_TIME + 241_000);
    expect(getMachineAuthToken({ allowRefreshWindow: true })).toBe("tok-123");
  });

  it("allowRefreshWindow=true returns null after hard expiry", () => {
    setMachineAuthToken("tok-123", 300);
    vi.setSystemTime(BASE_TIME + 301_000);
    expect(getMachineAuthToken({ allowRefreshWindow: true })).toBeNull();
  });

  it("clearMachineAuthToken makes token null and resets timestamps", () => {
    setMachineAuthToken("tok-123", 300);
    clearMachineAuthToken();
    expect(getMachineAuthToken({ allowRefreshWindow: true })).toBeNull();
    const state = getMachineAuthSessionState();
    expect(state.hardExpiresAtMs).toBe(0);
    expect(state.refreshAtMs).toBe(0);
    expect(state.usable).toBe(false);
  });

  it("getMachineAuthSessionState reflects current state", () => {
    setMachineAuthToken("tok-abc", 120);
    const state = getMachineAuthSessionState();
    expect(state.token).toBe("tok-abc");
    expect(state.hardExpiresAtMs).toBe(BASE_TIME + 120_000);
    expect(state.refreshAtMs).toBe(BASE_TIME + 60_000);
    expect(state.usable).toBe(true);
  });

  it("handles expiresInSeconds=0 gracefully", () => {
    setMachineAuthToken("tok-zero", 0);
    // refresh window = now + 0 = immediate expiry
    expect(getMachineAuthToken()).toBeNull();
    // allowRefreshWindow also immediate hard expiry
    expect(getMachineAuthToken({ allowRefreshWindow: true })).toBeNull();
  });

  it("deduplication: second setMachineAuthToken overwrites first", () => {
    setMachineAuthToken("tok-first", 600);
    setMachineAuthToken("tok-second", 120);
    expect(getMachineAuthToken()).toBe("tok-second");
    const state = getMachineAuthSessionState();
    expect(state.hardExpiresAtMs).toBe(BASE_TIME + 120_000);
  });
});
