let machineAuthToken: string | null = null;
let expiresAtMs = 0;

export function setMachineAuthToken(
  token: string,
  expiresInSeconds: number,
): void {
  machineAuthToken = token;
  expiresAtMs = Date.now() + Math.max(0, expiresInSeconds - 30) * 1_000;
}

export function getMachineAuthToken(): string | null {
  if (!machineAuthToken || Date.now() >= expiresAtMs) return null;
  return machineAuthToken;
}

export function clearMachineAuthToken(): void {
  machineAuthToken = null;
  expiresAtMs = 0;
}
