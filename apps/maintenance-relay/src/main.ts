import { NftablesRelayBackend, SyncconfWireGuardBackend } from "./backends.js";
import { HttpRelayControlPlane } from "./control-plane.js";
import { FileRelayJournalStore } from "./journal.js";
import { RelayManagementHealthServer } from "./management-health.js";
import { MaintenanceRelayReconciler } from "./reconciler.js";
import {
  parseRelayRuntimeConfig,
  readRelayCredential,
} from "./runtime-config.js";
import { MaintenanceRelayRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const config = parseRelayRuntimeConfig(process.env);
  const credential = await readRelayCredential(config.credentialFile);
  const reconciler = new MaintenanceRelayReconciler({
    wireGuard: new SyncconfWireGuardBackend(
      config.interfaceName,
      config.relayTunnelAddress,
      { privateKeyPath: config.privateKeyFile },
    ),
    firewall: new NftablesRelayBackend(config.interfaceName),
    journal: new FileRelayJournalStore(config.journalPath),
    transport: config.transport,
  });
  const runtime = new MaintenanceRelayRuntime(
    new HttpRelayControlPlane(config.serviceApiBaseUrl, credential, {
      allowInsecureHttp: config.transport.mode === "insecure-http",
    }),
    reconciler,
  );
  const health = new RelayManagementHealthServer(
    config.transport,
    config.healthPort,
  );
  await health.start();
  const pollForever = async (): Promise<never> => {
    try {
      await runtime.poll();
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return await new Promise<never>((resolve) => {
      setTimeout(resolve, config.pollIntervalMs);
    }).then(pollForever);
  };
  await pollForever();
}

void main();
