<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import type { TransactionSnapshot } from "@/daemon/schemas";

import { runBoundedBootCheck } from "@/daemon/boot-check";
import { daemonClient } from "@/daemon/client";
import { routeForBootFailure, routeForStartup } from "@/daemon/startup";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { useMqttStore } from "@/stores/mqtt";
import { useNaturalContextStore } from "@/stores/natural-context";
import { useRemoteOpsStore } from "@/stores/remote-ops";
import { useScannerStore } from "@/stores/scanner";
import { useVisionStore } from "@/stores/vision";

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

let bootGeneration = 0;
let recoveredTransaction: TransactionSnapshot | null = null;

function ownsBoot(signal: AbortSignal, generation: number): boolean {
  return !signal.aborted && generation === bootGeneration;
}

function pushStep(message: string): void {
  steps.value = [...steps.value, message];
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

      pushStep("读取配置与交易快照");
      // Start every bounded read concurrently, but recover the transaction
      // first. A later diagnostic response must never replace an already known
      // customer journey when the boot bound expires.
      const healthRequest = daemonClient.getHealth();
      const configurationRequest =
        daemonClient.getEffectiveRuntimeConfiguration();
      const transactionRequest = daemonClient.getCurrentTransaction();
      const [transactionResult, healthResult, configurationResult] =
        await Promise.allSettled([
          transactionRequest,
          healthRequest,
          configurationRequest,
        ]);
      if (!ownsBoot(signal, generation)) return;
      if (transactionResult.status === "rejected") {
        throw transactionResult.reason;
      }
      const transaction = transactionResult.value;

      const startupTransaction = checkoutStore.shouldIgnoreTransaction(
        transaction,
      )
        ? null
        : transaction;
      recoveredTransaction = startupTransaction;
      if (startupTransaction) {
        checkoutStore.applyTransaction(startupTransaction, { restored: true });
      }

      if (configurationResult.status === "rejected") {
        throw configurationResult.reason;
      }
      const configuration = configurationResult.value;
      if (healthResult.status === "fulfilled") {
        machineStore.applyHealth(healthResult.value);
        connectivityStore.applyHealth(healthResult.value);
      } else {
        connectivityStore.markStale(healthResult.reason);
      }
      if (!ownsBoot(signal, generation)) return;
      machineStore.applyEffectiveRuntimeConfiguration(configuration);

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

      pushStep("根据 daemon 状态选择页面");
      await submitMachineNavigationIntent({
        type: "startup.navigate",
        target: routeForStartup({
          daemonAvailable: true,
          effectiveRuntimeConfiguration: configuration,
          restoredTransaction: startupTransaction,
        }),
      });
    } catch (error) {
      if (!ownsBoot(signal, generation)) return;
      connectivityStore.markStale(error);
      pushStep("daemon 不可用，进入离线页面");
      await submitMachineNavigationIntent({
        type: "startup.navigate",
        target: routeForBootFailure(
          recoveredTransaction,
          machineStore.effectiveRuntimeConfiguration,
        ),
      });
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
    pushStep(
      recoveredTransaction
        ? "启动检查超时，继续恢复顾客交易"
        : "启动检查超时，进入离线或维护页",
    );
    await submitMachineNavigationIntent({
      type: "startup.navigate",
      target: routeForBootFailure(
        recoveredTransaction,
        machineStore.effectiveRuntimeConfiguration,
      ),
    });
  }
});

onUnmounted(() => {
  bootGeneration += 1;
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
