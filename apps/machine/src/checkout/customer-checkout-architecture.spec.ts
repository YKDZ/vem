import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const machineRoot = fileURLToPath(new URL("../..", import.meta.url));

function readSource(path: string): string {
  return readFileSync(`${machineRoot}/${path}`, "utf8");
}

function daemonEventConsumptionOffenders(source: string): string[] {
  return [
    [/\bdaemonClient\s*\.\s*subscribeEvents\b/, "daemonClient.subscribeEvents"],
    [/\bdaemonEventSchema\b/, "daemonEventSchema"],
    [/\bDaemonEvent\b/, "DaemonEvent"],
    [/\bUnknownDaemonEvent\b/, "UnknownDaemonEvent"],
    [/\bdaemonEvent\b/, "daemonEvent"],
    [/\bdaemon event\b/, "daemon event"],
    [/\bLowerController\b/, "LowerController"],
    [/\blower-controller\b/, "lower-controller"],
  ].flatMap(([pattern, label]) =>
    (pattern as RegExp).test(source) ? [label as string] : [],
  );
}

function directRouteWriterOffenders(source: string): string[] {
  return [
    [/\buseRouter\s*\(/, "useRouter"],
    [/\brouter\s*\.\s*(?:push|replace|back|go)\b/, "router write"],
    [/\$router\s*\.\s*(?:push|replace|back|go)\b/, "$router write"],
    [
      /\b(?:window\.)?location\s*\.\s*(?:assign|replace|reload)\b/,
      "location write",
    ],
    [
      /\bhistory\s*\.\s*(?:back|forward|go|pushState|replaceState)\b/,
      "history write",
    ],
  ].flatMap(([pattern, label]) =>
    (pattern as RegExp).test(source) ? [label as string] : [],
  );
}

function machineSourceFiles(directory = `${machineRoot}/src`): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return machineSourceFiles(path);
    if (!entry.isFile() || !/\.(?:ts|vue)$/.test(entry.name)) return [];
    return [path.slice(machineRoot.length + 1)];
  });
}

const audioBoundaryAllowlist = new Set([
  "src/audio-coordinator/audio-coordinator.ts",
  "src/audio-playback/machine-audio-playback.ts",
]);

function directAudioBoundaryOffenders(path: string, source: string): string[] {
  if (audioBoundaryAllowlist.has(path)) return [];
  return [
    [/\bnew\s+Audio\s*\(/, "new Audio"],
    [/\.playLocal\s*\(/, "playLocal"],
    [
      /callTauriCommand\s*<[^>]*>\s*\(\s*["'](?:play|stop)_machine_audio["']/,
      "native audio command",
    ],
    [
      /create(?:Browser|TauriNative)MachineAudioPlaybackDriver\s*\(/,
      "playback driver",
    ],
  ].flatMap(([pattern, label]) =>
    (pattern as RegExp).test(source) ? [label as string] : [],
  );
}

describe("customer checkout projection architecture", () => {
  it("keeps removed current transaction models out of the checkout store", () => {
    const checkoutStore = readSource("src/stores/checkout.ts");

    expect(checkoutStore).not.toMatch(/\bcurrentOrder\b/);
    expect(checkoutStore).not.toMatch(/\bflowStep\b/);
    expect(checkoutStore).not.toMatch(/\btransactionObservation\b/);
    expect(checkoutStore).not.toMatch(/\bstatus:\s+null as MachineOrderStatus/);
    expect(checkoutStore).not.toMatch(/\bnormalizeNextAction\b/);
  });

  it("routes current transactions through the projection instead of a raw next-action table", () => {
    const startup = readSource("src/daemon/startup.ts");
    const startupInput = startup.match(
      /export function routeForStartup\(input: \{([\s\S]*?)\}\): StartupRoute/,
    )?.[1];

    expect(startupInput).toContain("restoredTransaction");
    expect(startupInput).not.toMatch(/\n\s*transaction:/);
    expect(startup).toContain("projectCustomerCheckoutView");
    expect(startup).not.toMatch(/\bnextAction\b/);
    expect(startup).not.toMatch(/\bwait_payment\b/);
    expect(startup).not.toMatch(/\bsuccess\b/);
    expect(startup).not.toMatch(/\bpayment_failed\b/);
    expect(startup).not.toMatch(/\brefund_pending\b/);
  });

  it("keeps payment-stage callers on the unified checkout view", () => {
    const paymentView = readSource("src/views/PaymentView.vue");
    const checkoutStore = readSource("src/stores/checkout.ts");

    expect(paymentView).toContain("customerCheckoutView");
    expect(paymentView).not.toContain("checkoutStore.remainingSeconds");
    expect(checkoutStore).not.toMatch(/\bremainingSeconds:\s*\(/);
  });

  it("keeps dispensing and result pages on the unified checkout view", () => {
    const dispensingView = readSource("src/views/DispensingView.vue");
    const resultView = readSource("src/views/ResultView.vue");

    expect(dispensingView).toContain("customerCheckoutView");
    expect(resultView).toContain("customerCheckoutView");
    expect(dispensingView).not.toContain("nextAction");
    expect(resultView).not.toContain("nextAction");
    expect(resultView).not.toContain("@/daemon/client");
    expect(resultView).not.toContain("useConnectivityStore");
  });

  it("keeps customer journey audio on the transition projector and coordinator", () => {
    for (const path of [
      "src/customer-events/events.ts",
      "src/composables/useCustomerEvents.ts",
      "src/composables/useCustomerEventSources.ts",
      "src/stores/audio-cues.ts",
      "src/audio-cues/browser-playback.ts",
      "src/audio-cues/customer-audio-consumer.ts",
    ]) {
      expect(existsSync(`${machineRoot}/${path}`)).toBe(false);
    }

    for (const path of machineSourceFiles()) {
      if (path.endsWith(".spec.ts")) continue;
      const source = readSource(path);
      expect(source).not.toMatch(/\bCustomerExperienceEvent\b/);
      expect(source).not.toMatch(/\buseCustomerEvents\b/);
      expect(source).not.toMatch(/\buseCustomerEventSources\b/);
      expect(source).not.toMatch(/\buseAudioCueStore\b/);
      expect(source).not.toMatch(/\bemitCustomerEvent\b/);
      expect(source).not.toMatch(/\.requestCue\s*\(/);
    }

    const runtime = readSource("src/runtime/customer-journey-audio-runtime.ts");
    const projector = readSource(
      "src/customer-journey/transition-projector.ts",
    );
    const coordinator = readSource(
      "src/audio-coordinator/audio-coordinator.ts",
    );
    expect(daemonEventConsumptionOffenders(runtime)).toEqual([]);
    expect(projector).toContain("pickup.warning");
    expect(projector).toContain("pickup.urgent");
    expect(coordinator).toContain("onTerminal");
  });

  it("forbids page and runtime callers from bypassing the audio coordinator boundary", () => {
    for (const path of machineSourceFiles()) {
      if (path.endsWith(".spec.ts")) continue;
      const offenders = directAudioBoundaryOffenders(path, readSource(path));
      expect({ path, offenders }).toEqual({ path, offenders: [] });
    }
  });

  it("rejects injected direct playback in the journey runtime module", () => {
    expect(
      directAudioBoundaryOffenders(
        "src/runtime/customer-journey-audio-runtime.ts",
        "await driver.playLocal('/audio/injected.mp3')",
      ),
    ).toEqual(["playLocal"]);
  });

  it("detects direct daemon event-stream consumption in customer checkout surfaces", () => {
    expect(
      daemonEventConsumptionOffenders(`
        daemonClient.subscribeEvents({ onEvent: applyEvent });
        const event = daemonEventSchema.parse(raw);
      `),
    ).toEqual(["daemonClient.subscribeEvents", "daemonEventSchema"]);
  });

  it("recursively keeps production route writes in the navigation authority", () => {
    const routeWriterAllowlist = new Set([
      "src/router/transaction-route-authority.ts",
    ]);
    const debugRouteWriterAllowlist = new Set([
      "src/dev/ui-debug-daemon.ts",
      "src/views/dev/UiDebugView.vue",
    ]);

    for (const path of machineSourceFiles()) {
      if (path.endsWith(".spec.ts")) continue;
      if (path.startsWith("src/dev/") || path.startsWith("src/views/dev/")) {
        if (debugRouteWriterAllowlist.has(path)) continue;
        expect({
          path,
          offenders: directRouteWriterOffenders(readSource(path)),
        }).toEqual({
          path,
          offenders: [],
        });
        continue;
      }
      if (routeWriterAllowlist.has(path)) continue;
      expect({
        path,
        offenders: directRouteWriterOffenders(readSource(path)),
      }).toEqual({
        path,
        offenders: [],
      });
    }
  });
});
