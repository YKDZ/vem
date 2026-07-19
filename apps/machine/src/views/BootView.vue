<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

import type { TransactionSnapshot } from "@/daemon/schemas";

import KioskHeader from "@/components/KioskHeader.vue";
import { runBoundedBootCheck } from "@/daemon/boot-check";
import { daemonClient } from "@/daemon/client";
import { routeForBootFailure, routeForStartup } from "@/daemon/startup";
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
const bootStageLabels = [
  "连接本机运行服务",
  "读取配置与交易快照",
  "同步目录和展示状态",
  "进入售卖界面",
] as const;

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
      pushStep("连接本机运行服务");
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

      pushStep("根据运行状态选择页面");
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
      pushStep("本机运行服务不可用，进入离线页面");
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
  <main class="kiosk-shell boot-page">
    <KioskHeader />
    <section class="boot-content" aria-live="polite">
      <p class="boot-progress-label">
        启动检查 {{ Math.min(steps.length, 4) }} / 4
      </p>
      <h1>{{ steps[steps.length - 1] ?? "正在连接本机服务" }}</h1>
      <p class="boot-description">正在恢复运行配置和顾客交易，请稍候。</p>
      <div class="boot-progress" aria-hidden="true">
        <span
          :style="{
            width: `${Math.max(12, Math.min(100, steps.length * 25))}%`,
          }"
        ></span>
      </div>
      <ol class="boot-steps">
        <li
          v-for="(stage, index) in bootStageLabels"
          :key="stage"
          :class="{
            current: index === Math.min(steps.length, 4) - 1,
            complete: index < Math.min(steps.length, 4) - 1,
            waiting: index >= Math.min(steps.length, 4),
          }"
        >
          <b>{{ index + 1 }}</b>
          <span>{{ steps[index] ?? stage }}</span>
          <em>
            {{
              index === Math.min(steps.length, 4) - 1
                ? "进行中"
                : index < Math.min(steps.length, 4)
                  ? "完成"
                  : "等待"
            }}
          </em>
        </li>
      </ol>
    </section>
  </main>
</template>

<style scoped>
.boot-page {
  display: flex;
  flex-direction: column;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 2rem;
  color: #293129;
  background: #f5f4ee;
}

.boot-content {
  width: min(42rem, 88%);
  margin: clamp(9rem, 17vh, 16rem) auto 0;
}

.boot-progress-label {
  margin: 0;
  color: #647858;
  font-size: 0.9rem;
  font-weight: 700;
}

.boot-content h1 {
  margin: 0.75rem 0 0;
  color: #293129;
  font-size: 2.45rem;
  line-height: 1.25;
}

.boot-description {
  margin: 0.7rem 0 0;
  color: #6c746d;
  font-size: 1rem;
}

.boot-progress {
  height: 0.45rem;
  margin: 2.6rem 0 2rem;
  overflow: hidden;
  background: #dde1da;
  border-radius: 4px;
}

.boot-progress span {
  display: block;
  height: 100%;
  background: #6d815d;
  transition: width 180ms ease;
}

.boot-steps {
  padding: 0;
  margin: 0;
  list-style: none;
  border-bottom: 1px solid #d7dcd5;
}

.boot-steps li {
  display: grid;
  grid-template-columns: 2.25rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.8rem;
  min-height: 4rem;
  color: #858c86;
  border-top: 1px solid #d7dcd5;
}

.boot-steps b {
  display: grid;
  width: 1.75rem;
  height: 1.75rem;
  place-items: center;
  border: 1px solid #b7beb7;
  border-radius: 50%;
  font-size: 0.78rem;
}

.boot-steps em {
  font-size: 0.8rem;
  font-style: normal;
}

.boot-steps .complete {
  color: #566357;
}

.boot-steps .complete b {
  color: #fff;
  background: #6d815d;
  border-color: #6d815d;
}

.boot-steps .current {
  color: #293129;
  font-weight: 700;
}
</style>
