import { NftablesRelayBackend, SyncconfWireGuardBackend } from "./backends";
import { HttpRelayControlPlane } from "./control-plane";
import { FileRelayJournalStore } from "./journal";
import { MaintenanceRelayReconciler } from "./reconciler";
import { MaintenanceRelayRuntime } from "./runtime";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const interfaceName = process.env["MAINTENANCE_RELAY_INTERFACE"] ?? "wg0";
  const pollIntervalMs = Number(
    process.env["MAINTENANCE_RELAY_POLL_INTERVAL_MS"] ?? "5000",
  );
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new Error(
      "MAINTENANCE_RELAY_POLL_INTERVAL_MS must be an integer >= 1000",
    );
  }
  const reconciler = new MaintenanceRelayReconciler({
    wireGuard: new SyncconfWireGuardBackend(interfaceName),
    firewall: new NftablesRelayBackend(interfaceName),
    journal: new FileRelayJournalStore(
      process.env["MAINTENANCE_RELAY_JOURNAL_PATH"] ??
        "/var/lib/vem/maintenance-relay/journal.json",
    ),
  });
  const runtime = new MaintenanceRelayRuntime(
    new HttpRelayControlPlane(
      requiredEnv("SERVICE_API_BASE_URL"),
      requiredEnv("MAINTENANCE_RELAY_CREDENTIAL"),
    ),
    reconciler,
  );
  const pollForever = async (): Promise<never> => {
    try {
      await runtime.poll();
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return await new Promise<never>((resolve) => {
      setTimeout(resolve, pollIntervalMs);
    }).then(pollForever);
  };
  await pollForever();
}

void main();
