let machineAuthToken: string | null = null;
let hardExpiresAtMs = 0;
let refreshAtMs = 0;

export function setMachineAuthToken(
  token: string,
  expiresInSeconds: number,
): void {
  const now = Date.now();
  machineAuthToken = token;
  hardExpiresAtMs = now + Math.max(0, expiresInSeconds) * 1_000;
  refreshAtMs = now + Math.max(0, expiresInSeconds - 60) * 1_000;
}

export function getMachineAuthToken(
  options: { allowRefreshWindow?: boolean } = {},
): string | null {
  if (!machineAuthToken) return null;
  const threshold = options.allowRefreshWindow ? hardExpiresAtMs : refreshAtMs;
  if (Date.now() >= threshold) return null;
  return machineAuthToken;
}

export function getMachineAuthSessionState(): {
  token: string | null;
  hardExpiresAtMs: number;
  refreshAtMs: number;
  usable: boolean;
} {
  return {
    token: getMachineAuthToken({ allowRefreshWindow: true }),
    hardExpiresAtMs,
    refreshAtMs,
    usable: Boolean(getMachineAuthToken({ allowRefreshWindow: true })),
  };
}

export function clearMachineAuthToken(): void {
  machineAuthToken = null;
  hardExpiresAtMs = 0;
  refreshAtMs = 0;
}
