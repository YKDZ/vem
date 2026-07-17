import type { Pinia } from "pinia";

import type { DaemonEvent, UnknownDaemonEvent } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useSaleCapabilityStore } from "@/stores/sale-capability";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

const CAPABILITY_POLL_INTERVAL_MS = 15_000;
const RECONCILIATION_ATTEMPTS = 3;
const RECONCILIATION_INITIAL_DELAY_MS = 250;
const RECONCILIATION_MAX_DELAY_MS = 1_000;

type RuntimeCoordinator = {
  subscription: { close(): void } | null;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
  reconciliation: Promise<void> | null;
  reconciliationRetryTimer: ReturnType<typeof globalThis.setTimeout> | null;
};

const coordinators = new WeakMap<Pinia, RuntimeCoordinator>();

function coordinatorFor(pinia: Pinia): RuntimeCoordinator {
  const existing = coordinators.get(pinia);
  if (existing) return existing;
  const coordinator: RuntimeCoordinator = {
    subscription: null,
    pollTimer: null,
    reconciliation: null,
    reconciliationRetryTimer: null,
  };
  coordinators.set(pinia, coordinator);
  return coordinator;
}

function dispatchDaemonEvent(pinia: Pinia, event: DaemonEvent): void {
  const machineStore = useMachineStore(pinia);
  const connectivityStore = useConnectivityStore(pinia);
  const catalogStore = useCatalogStore(pinia);
  const checkoutStore = useCheckoutStore(pinia);
  const mqttStore = useMqttStore(pinia);
  const remoteOpsStore = useRemoteOpsStore(pinia);
  const saleCapabilityStore = useSaleCapabilityStore(pinia);
  const scannerStore = useScannerStore(pinia);
  const visionStore = useVisionStore(pinia);

  if (event.type === "health_changed") {
    machineStore.applyHealth(event.snapshot);
    connectivityStore.applyHealth(event.snapshot);
    return;
  }
  if (event.type === "sale_start_capability_changed") {
    saleCapabilityStore.invalidate(event);
    return;
  }
  if (event.type === "scanner_health_changed") {
    scannerStore.applyStatus(event.snapshot);
    return;
  }
  if (event.type === "scanner_code") {
    scannerStore.applyScan(event.maskedCode, event.scannedAtMs);
    return;
  }
  if (event.type === "mqtt_changed") {
    mqttStore.applyMqttEvent(event);
    if (event.connected) {
      void Promise.allSettled([
        connectivityStore.refresh(),
        catalogStore.refresh(),
      ]);
    }
    return;
  }
  if (event.type === "vision_changed") {
    visionStore.applyStatus({
      enabled: event.enabled,
      online: event.online,
      message: event.message,
      updatedAt: event.updatedAt,
      latestDiagnosticPayload: event.latestDiagnosticPayload ?? null,
    });
    return;
  }
  if (event.type === "transaction_changed") {
    void checkoutStore.refreshCurrentTransaction();
    void catalogStore.refresh().catch(() => undefined);
    return;
  }
  if (event.type === "remote_op_result") {
    void remoteOpsStore.refresh();
    void catalogStore.refresh().catch(() => undefined);
  }
}

async function reconciliationDelay(
  coordinator: RuntimeCoordinator,
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    coordinator.reconciliationRetryTimer = globalThis.setTimeout(() => {
      coordinator.reconciliationRetryTimer = null;
      resolve();
    }, milliseconds);
  });
}

async function reconcileAfterStreamReconnect(
  pinia: Pinia,
  coordinator: RuntimeCoordinator,
): Promise<void> {
  const connectivityStore = useConnectivityStore(pinia);
  const catalogStore = useCatalogStore(pinia);
  const checkoutStore = useCheckoutStore(pinia);
  const mqttStore = useMqttStore(pinia);
  const saleCapabilityStore = useSaleCapabilityStore(pinia);
  let retryDelayMs = RECONCILIATION_INITIAL_DELAY_MS;

  for (let attempt = 0; attempt < RECONCILIATION_ATTEMPTS; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each forced IPC read must finish before deciding whether this bounded reconciliation needs another attempt.
      await daemonClient.initialize(true);
      // oxlint-disable-next-line no-await-in-loop -- all projections belong to the same reconnect observation and must settle before retrying it.
      const results = await Promise.allSettled([
        connectivityStore.refresh(),
        saleCapabilityStore.refresh(),
        catalogStore.refresh(),
        mqttStore.refresh(),
        checkoutStore.refreshCurrentTransaction(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (!failed) return;
      throw failed.reason;
    } catch (error) {
      connectivityStore.markStale(error);
      saleCapabilityStore.markStale(error);
      if (attempt + 1 >= RECONCILIATION_ATTEMPTS) return;
      // oxlint-disable-next-line no-await-in-loop -- bounded exponential backoff keeps the single coordinator from overlapping reconnect attempts.
      await reconciliationDelay(coordinator, retryDelayMs);
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        RECONCILIATION_MAX_DELAY_MS,
      );
    }
  }
}

function scheduleStreamReconciliation(pinia: Pinia): void {
  const coordinator = coordinatorFor(pinia);
  if (coordinator.reconciliation) return;
  const reconciliation = reconcileAfterStreamReconnect(pinia, coordinator);
  coordinator.reconciliation = reconciliation;
  void reconciliation.finally(() => {
    if (coordinator.reconciliation === reconciliation) {
      coordinator.reconciliation = null;
    }
  });
}

function recordUnknownDaemonEvent(
  pinia: Pinia,
  event: UnknownDaemonEvent,
): void {
  useConnectivityStore(pinia).recordUnknownEvent(event);
}

export function startMachineRuntime(pinia: Pinia): void {
  const coordinator = coordinatorFor(pinia);
  if (coordinator.subscription) return;

  const saleCapabilityStore = useSaleCapabilityStore(pinia);
  const connectivityStore = useConnectivityStore(pinia);
  void saleCapabilityStore.refresh();
  coordinator.subscription = daemonClient.subscribeEvents({
    onEvent: (event) => {
      dispatchDaemonEvent(pinia, event);
    },
    onUnknownEvent: (event) => {
      recordUnknownDaemonEvent(pinia, event);
    },
    onError: (error) => {
      connectivityStore.markStale(error);
      saleCapabilityStore.markStale(error);
    },
    onStale: () => {
      connectivityStore.markStale();
      saleCapabilityStore.markStale("daemon event stream disconnected");
    },
    onReconnect: () => {
      scheduleStreamReconciliation(pinia);
    },
  });
  coordinator.pollTimer = globalThis.setInterval(() => {
    void saleCapabilityStore.refresh();
  }, CAPABILITY_POLL_INTERVAL_MS);
}

export function stopMachineRuntime(pinia: Pinia): void {
  const coordinator = coordinators.get(pinia);
  if (!coordinator) return;
  coordinator.subscription?.close();
  coordinator.subscription = null;
  if (coordinator.pollTimer !== null) {
    globalThis.clearInterval(coordinator.pollTimer);
    coordinator.pollTimer = null;
  }
  if (coordinator.reconciliationRetryTimer !== null) {
    globalThis.clearTimeout(coordinator.reconciliationRetryTimer);
    coordinator.reconciliationRetryTimer = null;
  }
  coordinator.reconciliation = null;
}
