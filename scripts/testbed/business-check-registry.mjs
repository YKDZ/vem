const passedEvidence = Object.freeze({
  trace: true,
  logs: true,
  screenshot: true,
});
const failedEvidence = Object.freeze({
  primaryReason: true,
  diagnostic: true,
  trace: false,
  logs: false,
  screenshot: false,
});

function descriptor({
  name,
  core = false,
  fixtureKey = name,
  runner = null,
  validator,
  blockedReason = null,
}) {
  return Object.freeze({
    name,
    key: name,
    core,
    // Business sets are full-required unless they are deliberately kept out of
    // this registry as supporting evidence.
    fullRequired: true,
    fixtureKey,
    runner: runner && Object.freeze(runner),
    validator,
    blockedReason,
    evidence: Object.freeze({ passed: passedEvidence, failed: failedEvidence }),
  });
}

export const BUSINESS_CHECK_REGISTRY = Object.freeze([
  descriptor({
    name: "commissioning",
    runner: {
      kind: "node",
      script: "scripts/testbed/commissioning-acceptance.mjs",
      args: [],
      reportFileName: "commissioning.json",
      artifactDirectory: "commissioning-artifacts",
    },
    validator: "commissioning",
  }),
  descriptor({
    name: "sale",
    core: true,
    runner: {
      kind: "node",
      script: "scripts/testbed/fast-route-stress-sale.mjs",
      args: [],
      reportFileName: "sale.json",
      artifactDirectory: "sale-artifacts",
    },
    validator: "sale",
  }),
  descriptor({
    name: "scannerPayment",
    runner: {
      kind: "node",
      script: "scripts/testbed/scanner-payment-code-guest-full.mjs",
      args: [],
      reportFileName: "scanner-payment.json",
      artifactDirectory: "scanner-payment-artifacts",
    },
    validator: "scannerPayment",
  }),
  descriptor({
    name: "visionExperience",
    runner: {
      kind: "powershell",
      script: "scripts/testbed/run-full-vision-try-on-track.ps1",
      args: [],
      reportFileName: "vision-experience.json",
      artifactDirectory: "vision-experience-artifacts",
    },
    validator: "visionExperience",
  }),
  descriptor({
    name: "pickupProtocol",
    runner: {
      kind: "node",
      script: "scripts/testbed/delayed-pickup-native-audio-guest-full.mjs",
      args: [],
      reportFileName: "pickup-protocol.json",
      artifactDirectory: "pickup-protocol-artifacts",
    },
    validator: "pickupProtocol",
  }),
  descriptor({
    name: "behaviorAudio",
    fixtureKey: "pickupProtocol",
    runner: {
      kind: "node",
      script: "scripts/testbed/delayed-pickup-native-audio-guest-full.mjs",
      args: [],
      reportFileName: "behavior-audio.json",
      artifactDirectory: "behavior-audio-artifacts",
    },
    validator: "behaviorAudio",
  }),
  descriptor({
    name: "ipcRecovery",
    runner: {
      kind: "node",
      script: "scripts/testbed/installed-ipc-recovery-guest-full.mjs",
      args: [],
      reportFileName: "ipc-recovery.json",
      artifactDirectory: "ipc-recovery-artifacts",
    },
    validator: "ipcRecovery",
  }),
  descriptor({
    name: "fulfillmentRecovery",
    runner: {
      kind: "node",
      script: "scripts/testbed/serial-fulfillment-error-guest-full.mjs",
      args: [],
      reportFileName: "fulfillment-recovery.json",
      artifactDirectory: "fulfillment-recovery-artifacts",
    },
    validator: "fulfillmentRecovery",
  }),
  descriptor({
    name: "paymentRecovery",
    fixtureKey: "sale",
    runner: {
      kind: "node",
      script: "scripts/testbed/payment-recovery-guest-full.mjs",
      args: [],
      reportFileName: "payment-recovery.json",
      artifactDirectory: "payment-recovery-artifacts",
    },
    validator: "paymentRecovery",
  }),
  descriptor({
    name: "hardwareLifecycle",
    runner: {
      kind: "node",
      script: "scripts/testbed/hardware-lifecycle-guest-full.mjs",
      args: [],
      reportFileName: "hardware-lifecycle.json",
      artifactDirectory: "hardware-lifecycle-artifacts",
    },
    validator: "hardwareLifecycle",
  }),
  descriptor({
    name: "localOperations",
    fixtureKey: "sale",
    runner: {
      kind: "node",
      script: "scripts/testbed/local-operations-guest-full.mjs",
      args: [],
      reportFileName: "local-operations.json",
      artifactDirectory: "local-operations-artifacts",
    },
    validator: "localOperations",
  }),
  descriptor({
    name: "environmentControl",
    runner: {
      kind: "node",
      script: "scripts/testbed/environment-control-guest-full.mjs",
      args: [],
      reportFileName: "environment-control.json",
      artifactDirectory: "environment-control-artifacts",
    },
    validator: "environmentControl",
  }),
]);

export function businessCheckByName(name, registry = BUSINESS_CHECK_REGISTRY) {
  return registry.find((descriptor) => descriptor.name === name) ?? null;
}

export function selectBusinessChecks({
  mode,
  focus = [],
  registry = BUSINESS_CHECK_REGISTRY,
}) {
  if (!Array.isArray(focus)) throw new Error("focus must be an array");
  if (mode === "full") {
    if (focus.length > 0)
      throw new Error("--focus is only valid with --mode fast");
    return registry.filter((descriptor) => descriptor.fullRequired);
  }
  if (mode !== "fast")
    throw new Error("business check mode must be fast or full");
  const selected = new Set(focus);
  for (const name of selected) {
    if (!businessCheckByName(name, registry)) {
      throw new Error(`unknown business check set: ${name}`);
    }
  }
  return registry.filter((descriptor) =>
    selected.size > 0 ? selected.has(descriptor.name) : descriptor.core,
  );
}
