import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

const CLAIM_RECONNECT_ATTEMPTS = 8;
const CLAIM_RECONNECT_INITIAL_DELAY_MS = 100;
const CLAIM_RECONNECT_MAX_DELAY_MS = 1_000;

type ClaimRecoveryClient = {
  initialize(force?: boolean): Promise<unknown>;
  getEffectiveRuntimeConfiguration(): Promise<EffectiveMachineRuntimeConfiguration>;
};

export function hasClaimedMachineIdentity(
  configuration: EffectiveMachineRuntimeConfiguration,
  expectedMachineCode: string | null,
): boolean {
  const cachedMachine =
    configuration.sourceDocuments.profileCache?.profile.machine ?? null;
  const machine = configuration.machine;
  return Boolean(
    cachedMachine &&
    machine &&
    cachedMachine.id === machine.id &&
    cachedMachine.code === machine.code &&
    (expectedMachineCode === null || machine.code === expectedMachineCode),
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, milliseconds);
  });
}

export async function recoverPersistedClaim(
  client: ClaimRecoveryClient,
  expectedMachineCode: string | null,
  options: {
    wait?: (milliseconds: number) => Promise<void>;
    attempts?: number;
  } = {},
): Promise<EffectiveMachineRuntimeConfiguration | null> {
  const attempts = options.attempts ?? CLAIM_RECONNECT_ATTEMPTS;
  const wait = options.wait ?? delay;

  async function recoverAttempt(
    attempt: number,
    retryDelayMs: number,
  ): Promise<EffectiveMachineRuntimeConfiguration | null> {
    try {
      await client.initialize(true);
      const configuration = await client.getEffectiveRuntimeConfiguration();
      if (hasClaimedMachineIdentity(configuration, expectedMachineCode)) {
        return configuration;
      }
    } catch {
      // The daemon may still be recreating its loopback IPC listener.
    }

    if (attempt + 1 >= attempts) {
      return null;
    }

    await wait(retryDelayMs);
    return recoverAttempt(
      attempt + 1,
      Math.min(retryDelayMs * 2, CLAIM_RECONNECT_MAX_DELAY_MS),
    );
  }

  return recoverAttempt(0, CLAIM_RECONNECT_INITIAL_DELAY_MS);
}
