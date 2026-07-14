<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";

import type {
  DaemonEvent,
  TransactionSnapshot,
  UnknownDaemonEvent,
} from "@/daemon/schemas";

import { runBoundedBootCheck } from "@/daemon/boot-check";
import { daemonClient } from "@/daemon/client";
import { routeForStartup } from "@/daemon/startup";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

const router = useRouter();
const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const mqttStore = useMqttStore();
const scannerStore = useScannerStore();
const visionStore = useVisionStore();
const remoteOpsStore = useRemoteOpsStore();
const naturalContextStore = useNaturalContextStore();
const steps = ref<string[]>([]);

let eventSubscription: { close(): void } | null = null;
let bootGeneration = 0;
let recoveredTransaction: TransactionSnapshot | null = null;

function ownsBoot(signal: AbortSignal, generation: number): boolean {
  return !signal.aborted && generation === bootGeneration;
}

function pushStep(message: string): void {
  steps.value = [...steps.value, message];
}

function dispatchDaemonEvent(event: DaemonEvent): void {
  if (event.type === "health_changed") {
    machineStore.applyHealth(event.snapshot);
    connectivityStore.applyHealth(event.snapshot);
    return;
  }

  if (event.type === "ready_changed") {
    connectivityStore.applyReady(event.snapshot);
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

function recordUnknownDaemonEvent(event: UnknownDaemonEvent): void {
  connectivityStore.recordUnknownEvent(event);
}

async function runBootCheck(): Promise<void> {
  bootGeneration += 1;
  const generation = bootGeneration;
  recoveredTransaction = null;
  await runBoundedBootCheck(async (signal) => {
    try {
      pushStep("连接本机 daemon IPC");
      await daemonClient.initialize();
      if (!ownsBoot(signal, generation)) return;

      pushStep("读取 daemon 健康与交易快照");
      // Start every bounded read concurrently, but recover the transaction
      // first. A later readiness response must never replace an already known
      // customer journey when the boot bound expires.
      const healthRequest = daemonClient.getHealth();
      const readyRequest = daemonClient.getReady();
      const bringUpRequest = daemonClient.getBringUp();
      const saleReadinessRequest = daemonClient.getSaleReadiness();
      const transaction = await daemonClient.getCurrentTransaction();
      if (!ownsBoot(signal, generation)) return;

      const startupTransaction = checkoutStore.shouldIgnoreTransaction(
        transaction,
      )
        ? null
        : transaction;
      recoveredTransaction = startupTransaction;
      if (startupTransaction) {
        checkoutStore.applyTransaction(startupTransaction, { restored: true });
      }

      const [health, ready, bringUp, saleReadiness] = await Promise.all([
        healthRequest,
        readyRequest,
        bringUpRequest,
        saleReadinessRequest,
      ]);
      if (!ownsBoot(signal, generation)) return;
      machineStore.applyHealth(health);
      connectivityStore.applyHealth(health);
      connectivityStore.applyReady(ready);
      connectivityStore.applySaleReadiness(saleReadiness);

      pushStep("同步配置");
      try {
        await machineStore.loadConfig();
        if (!ownsBoot(signal, generation)) return;
      } catch (error) {
        if (!ownsBoot(signal, generation)) return;
        connectivityStore.markStale(error);
        pushStep("daemon 配置读取失败，进入领取页确认配置");
      }

      pushStep("同步目录和展示状态");
      await Promise.allSettled([
        mqttStore.refresh(),
        catalogStore.load(),
        scannerStore.refresh(),
        visionStore.refresh(),
        remoteOpsStore.refresh(),
        naturalContextStore.refresh(),
      ]);
      if (!ownsBoot(signal, generation)) return;

      if (!eventSubscription) {
        pushStep("订阅 daemon 事件流");
        eventSubscription = daemonClient.subscribeEvents({
          onEvent: dispatchDaemonEvent,
          onUnknownEvent: recordUnknownDaemonEvent,
          onError: (error) => {
            connectivityStore.markStale(error);
          },
          onStale: () => {
            void Promise.allSettled([
              connectivityStore.refresh(),
              catalogStore.refresh(),
              mqttStore.refresh(),
              checkoutStore.refreshCurrentTransaction(),
            ]);
          },
        });
      }

      pushStep("根据 daemon 状态选择页面");
      await router.replace(
        routeForStartup({
          daemonAvailable: true,
          health,
          config: machineStore.configSummary,
          bringUp,
          ready,
          restoredTransaction: startupTransaction,
        }),
      );
    } catch (error) {
      if (!ownsBoot(signal, generation)) return;
      connectivityStore.markStale(error);
      pushStep("daemon 不可用，进入维护页");
      await router.replace(
        routeForStartup({
          daemonAvailable: false,
          health: null,
          config: null,
          bringUp: null,
          ready: null,
          restoredTransaction: null,
        }),
      );
    }
  }, 10_000);
}

onMounted(async () => {
  const generation = bootGeneration + 1;
  try {
    await runBootCheck();
  } catch (error) {
    if (generation !== bootGeneration) return;
    connectivityStore.markStale(error);
    if (recoveredTransaction) {
      pushStep("启动检查超时，继续恢复顾客交易");
      await router.replace(
        routeForStartup({
          daemonAvailable: true,
          health: null,
          config: null,
          bringUp: null,
          ready: null,
          restoredTransaction: recoveredTransaction,
        }),
      );
    } else {
      pushStep("启动检查超时，进入维护页");
      await router.replace("/maintenance");
    }
  }
});

onUnmounted(() => {
  bootGeneration += 1;
  eventSubscription?.close();
  eventSubscription = null;
});
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col items-center justify-center text-center"
    >
      <div
        class="w-full rounded-4xl border border-white/10 bg-white/10 p-8 shadow-2xl"
      >
        <p class="text-sm tracking-[0.4em] text-sky-200 uppercase">BOOTING</p>
        <h2 class="mt-4 text-4xl font-bold text-white">
          正在连接售货机 daemon
        </h2>
        <ul class="mt-8 space-y-3 text-left text-lg text-slate-200">
          <li
            v-for="step in steps"
            :key="step"
            class="rounded-2xl bg-slate-950/40 px-5 py-4"
          >
            {{ step }}
          </li>
        </ul>
      </div>
    </section>
  </KioskLayout>
</template>
