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

type RuntimeCoordinator = {
  subscription: { close(): void } | null;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
};

const coordinators = new WeakMap<Pinia, RuntimeCoordinator>();

function coordinatorFor(pinia: Pinia): RuntimeCoordinator {
  const existing = coordinators.get(pinia);
  if (existing) return existing;
  const coordinator: RuntimeCoordinator = {
    subscription: null,
    pollTimer: null,
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

function refreshAfterStreamReconnect(pinia: Pinia): void {
  const connectivityStore = useConnectivityStore(pinia);
  const catalogStore = useCatalogStore(pinia);
  const checkoutStore = useCheckoutStore(pinia);
  const mqttStore = useMqttStore(pinia);
  const saleCapabilityStore = useSaleCapabilityStore(pinia);
  void Promise.allSettled([
    connectivityStore.refresh(),
    saleCapabilityStore.refresh(),
    catalogStore.refresh(),
    mqttStore.refresh(),
    checkoutStore.refreshCurrentTransaction(),
  ]);
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
      refreshAfterStreamReconnect(pinia);
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
}
