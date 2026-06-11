<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import type { DaemonEvent } from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";
import { routeForStartup } from "@/daemon/startup";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
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
const steps = ref<string[]>([]);

let eventSubscription: { close(): void } | null = null;

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
    return;
  }

  if (event.type === "vision_changed") {
    visionStore.applyStatus({
      enabled: event.enabled,
      online: event.online,
      message: event.message,
      updatedAt: event.updatedAt,
    });
    return;
  }

  if (event.type === "transaction_changed") {
    void checkoutStore.refreshCurrentTransaction();
    return;
  }

  if (event.type === "remote_op_result") {
    void remoteOpsStore.refresh();
  }
}

onMounted(async () => {
  try {
    pushStep("连接本机 daemon IPC");
    await daemonClient.initialize();

    pushStep("读取 daemon 健康与交易快照");
    const [health, ready, saleReadiness, transaction] = await Promise.all([
      daemonClient.getHealth(),
      daemonClient.getReady(),
      daemonClient.getSaleReadiness(),
      daemonClient.getCurrentTransaction(),
    ]);
    machineStore.applyHealth(health);
    connectivityStore.applyHealth(health);
    connectivityStore.applyReady(ready);
    connectivityStore.applySaleReadiness(saleReadiness);
    const startupTransaction = checkoutStore.shouldIgnoreTransaction(
      transaction,
    )
      ? null
      : transaction;
    if (startupTransaction) {
      checkoutStore.applyTransaction(startupTransaction);
    }

    pushStep("同步配置");
    try {
      await machineStore.loadConfig();
    } catch (error) {
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
    ]);

    if (!eventSubscription) {
      pushStep("订阅 daemon 事件流");
      eventSubscription = daemonClient.subscribeEvents({
        onEvent: dispatchDaemonEvent,
        onError: (error) => {
          connectivityStore.markStale(error);
        },
        onStale: () => {
          void Promise.allSettled([
            connectivityStore.refresh(),
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
        ready,
        transaction: startupTransaction,
      }),
    );
  } catch (error) {
    connectivityStore.markStale(error);
    pushStep("daemon 不可用，进入维护页");
    await router.replace(
      routeForStartup({
        daemonAvailable: false,
        health: null,
        config: null,
        ready: null,
        transaction: null,
      }),
    );
  }
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
