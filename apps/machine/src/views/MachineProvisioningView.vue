<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import type {
  BringUpSnapshot,
  NetworkSettingsResponse,
  WifiNetwork,
} from "@/daemon/schemas";

import { DaemonUnavailableError, daemonClient } from "@/daemon/client";
import {
  networkSettingsResponseSchema,
  provisioningClaimResponseSchema,
} from "@/daemon/schemas";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();
const router = useRouter();

const claimForm = reactive({ claimCode: "" });
const networkForm = reactive({ ssid: "", password: "", hidden: false });
const bringUp = ref<BringUpSnapshot | null>(null);
const networkResult = ref<NetworkSettingsResponse | null>(null);
const wifiNetworks = ref<WifiNetwork[]>([]);
const statusMessage = ref<string | null>(null);
const loading = ref(false);
const submitting = ref(false);
const maintenanceAuthentication = reactive({
  pin: "",
  loading: false,
  message: null as string | null,
});
const maintenanceSessionAuthorized = ref(
  daemonClient.hasMaintenanceSessionForRoute("bring-up"),
);
let removeMaintenanceSessionInvalidationListener: (() => void) | null = null;
type BringUpProgressStep = NonNullable<BringUpSnapshot["progress"]>[number];

const currentTask = computed(() => bringUp.value?.currentTask ?? null);
const currentTaskLabel = computed(() =>
  currentTask.value ? taskLabel(currentTask.value.kind) : "正在确认本机状态",
);
const progress = computed(() => bringUp.value?.progress ?? []);
const currentTaskNeedsMaintenanceSession = computed(() =>
  [
    "configure_network",
    "claim_machine",
    "reclaim_machine",
    "attest_stock",
  ].includes(currentTask.value?.kind ?? ""),
);
const maintenanceSessionRequiredForReclaim = computed(
  () => currentTask.value?.kind === "reclaim_machine",
);

function canExecuteCurrentTask(): boolean {
  return (
    !currentTaskNeedsMaintenanceSession.value ||
    maintenanceSessionAuthorized.value
  );
}

async function beginProtectedMaintenance(): Promise<void> {
  if (
    maintenanceAuthentication.loading ||
    !maintenanceAuthentication.pin.trim()
  ) {
    return;
  }
  maintenanceAuthentication.loading = true;
  maintenanceAuthentication.message = null;
  try {
    await daemonClient.beginMaintenanceSession(
      maintenanceAuthentication.pin,
      maintenanceSessionRequiredForReclaim.value ? ["maintenance.reclaim"] : [],
    );
    if (!daemonClient.handoffMaintenanceSessionToBringUp()) {
      throw new Error("维护会话无法交接到首次部署控制台");
    }
    maintenanceSessionAuthorized.value =
      daemonClient.hasMaintenanceSessionForRoute("bring-up");
    maintenanceAuthentication.pin = "";
    maintenanceAuthentication.message =
      "维护会话已验证，可以继续当前部署任务。";
  } catch {
    maintenanceSessionAuthorized.value = false;
    maintenanceAuthentication.message = "PIN 验证失败，请重新输入。";
  } finally {
    maintenanceAuthentication.pin = "";
    maintenanceAuthentication.loading = false;
  }
}

function rejectedNetworkResult(error: unknown): NetworkSettingsResponse | null {
  if (!(error instanceof DaemonUnavailableError) || !error.responseBody) {
    return null;
  }
  try {
    const result = networkSettingsResponseSchema.safeParse(
      JSON.parse(error.responseBody),
    );
    if (
      !result.success ||
      (result.data.status !== "failed" && result.data.status !== "unsupported")
    ) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

function showRejectedNetworkResult(error: unknown): boolean {
  const result = rejectedNetworkResult(error);
  if (!result) return false;
  networkResult.value = result;
  statusMessage.value = result.operatorGuidance;
  return true;
}

function taskLabel(
  kind: NonNullable<BringUpSnapshot["currentTask"]>["kind"],
): string {
  const labels: Record<
    NonNullable<BringUpSnapshot["currentTask"]>["kind"],
    string
  > = {
    configure_network: "配置现场网络",
    claim_machine: "领取机器",
    reclaim_machine: "重新领取机器",
    sync_profile: "同步运行档案",
    resolve_topology: "处理货道拓扑",
    run_hardware_acceptance: "完成本机验收",
    attest_stock: "确认初始库存",
    start_sales: "进入售卖",
  };
  return labels[kind];
}

function progressLabel(step: BringUpProgressStep): string {
  const kindLabels: Record<BringUpProgressStep["kind"], string> = {
    network: "现场网络",
    provisioning: "机器领取",
    topology: "货道拓扑",
    hardware: "硬件验收",
    stock: "初始库存",
    sale_readiness: "售卖就绪",
  };
  const statusLabels: Record<BringUpProgressStep["status"], string> = {
    completed: "已完成",
    current: "进行中",
    upcoming: "后续",
    revalidate: "重新验证",
  };
  return `${kindLabels[step.kind]} · ${statusLabels[step.status]}`;
}

async function refreshBringUp(): Promise<void> {
  loading.value = true;
  try {
    bringUp.value = await daemonClient.getBringUp();
  } catch (error) {
    statusMessage.value =
      error instanceof Error ? error.message : "无法读取本机启动状态";
  } finally {
    loading.value = false;
  }
}

async function loadWifiNetworks(): Promise<void> {
  try {
    wifiNetworks.value = (await daemonClient.scanWifiNetworks()).networks;
  } catch {
    wifiNetworks.value = [];
  }
}

async function submitNetworkSettings(): Promise<void> {
  if (
    currentTask.value?.kind !== "configure_network" ||
    !networkForm.ssid.trim() ||
    !canExecuteCurrentTask() ||
    submitting.value
  ) {
    return;
  }
  submitting.value = true;
  const password = networkForm.password;
  try {
    networkResult.value = networkSettingsResponseSchema.parse(
      await daemonClient.executeBringUpTask(currentTask.value, {
        type: "configure_network",
        ssid: networkForm.ssid.trim(),
        password,
        hidden: networkForm.hidden,
      }),
    );
    statusMessage.value = networkResult.value.operatorGuidance;
    await refreshBringUp();
  } catch (error) {
    if (!showRejectedNetworkResult(error)) {
      statusMessage.value = "网络设置提交失败，请检查现场网络后重试";
    }
  } finally {
    networkForm.password = "";
    submitting.value = false;
  }
}

async function probeExistingNetwork(): Promise<void> {
  const task = currentTask.value;
  if (
    !task ||
    task.kind !== "configure_network" ||
    task.projection.type !== "network_settings" ||
    !task.projection.supportsExistingNetworkProbe ||
    submitting.value
  ) {
    return;
  }
  submitting.value = true;
  try {
    networkResult.value = networkSettingsResponseSchema.parse(
      await daemonClient.executeBringUpTask(task, { type: "probe_network" }),
    );
    statusMessage.value = networkResult.value.operatorGuidance;
    await refreshBringUp();
  } catch (error) {
    if (!showRejectedNetworkResult(error)) {
      statusMessage.value = "现有网络尚未验证可访问平台，请检查网络后重试";
    }
  } finally {
    submitting.value = false;
  }
}

async function submitClaim(): Promise<void> {
  const task = currentTask.value;
  if (
    !task ||
    !["claim_machine", "reclaim_machine"].includes(task.intent) ||
    !claimForm.claimCode.trim() ||
    !canExecuteCurrentTask() ||
    submitting.value
  ) {
    return;
  }
  submitting.value = true;
  const claimCode = claimForm.claimCode.trim().toUpperCase();
  try {
    const result = provisioningClaimResponseSchema.parse(
      await daemonClient.executeBringUpTask(task, {
        type: "claim_machine",
        claimCode,
      }),
    );
    machineStore.configSummary = result.config;
    machineStore.configLoaded = true;
    claimForm.claimCode = "";
    await refreshBringUp();
    await router.replace("/boot");
  } catch (error) {
    statusMessage.value =
      error instanceof DaemonUnavailableError
        ? "本机服务暂不可用，请稍后重试"
        : "领取失败，请核对领取码后重试";
  } finally {
    claimForm.claimCode = "";
    submitting.value = false;
  }
}

async function submitCurrentTask(): Promise<void> {
  if (!currentTask.value || submitting.value || !canExecuteCurrentTask())
    return;
  if (
    currentTask.value.intent === "open_maintenance" ||
    currentTask.value.intent === "record_stock"
  ) {
    await router.replace("/maintenance");
    return;
  }
  if (currentTask.value.intent === "refresh_profile") {
    await daemonClient.executeBringUpTask(currentTask.value, {
      type: "refresh_profile",
    });
    await refreshBringUp();
  }
}

onMounted(async () => {
  removeMaintenanceSessionInvalidationListener =
    daemonClient.onMaintenanceSessionInvalidated(() => {
      maintenanceSessionAuthorized.value = false;
      maintenanceAuthentication.message =
        "守护进程连接已更新，维护会话已失效，请重新验证 PIN。";
    });
  await refreshBringUp();
  if (currentTask.value?.kind === "configure_network") {
    await loadWifiNetworks();
  }
});

onUnmounted(() => {
  removeMaintenanceSessionInvalidationListener?.();
  removeMaintenanceSessionInvalidationListener = null;
  daemonClient.releaseMaintenanceSessionRoute("bring-up");
});
</script>

<template>
  <KioskLayout>
    <section class="bring-up-page" aria-label="首次部署控制台">
      <header>
        <p>受保护维护</p>
        <h1>首次部署控制台</h1>
        <span>{{
          loading ? "正在执行启动检查" : "本机状态已由 daemon 确认"
        }}</span>
      </header>

      <main>
        <section class="current-task" aria-live="polite">
          <p>当前任务：{{ currentTaskLabel }}</p>

          <form
            v-if="
              currentTaskNeedsMaintenanceSession &&
              !maintenanceSessionAuthorized
            "
            class="maintenance-session-gate"
            @submit.prevent="beginProtectedMaintenance"
          >
            <label>
              <span>维护 PIN</span>
              <input
                v-model="maintenanceAuthentication.pin"
                autocomplete="one-time-code"
                class="kiosk-touch-target"
                inputmode="numeric"
                type="password"
              />
            </label>
            <button
              class="kiosk-touch-target primary-action"
              type="submit"
              :disabled="
                maintenanceAuthentication.loading ||
                !maintenanceAuthentication.pin.trim()
              "
            >
              {{
                maintenanceAuthentication.loading
                  ? "正在验证 PIN"
                  : "验证维护 PIN"
              }}
            </button>
            <p v-if="maintenanceAuthentication.message">
              {{ maintenanceAuthentication.message }}
            </p>
          </form>

          <form
            v-if="currentTask?.kind === 'configure_network'"
            @submit.prevent="submitNetworkSettings"
          >
            <label>
              <span>无线网络名称</span>
              <select v-model="networkForm.ssid" class="kiosk-touch-target">
                <option value="">请选择现场网络</option>
                <option
                  v-for="network in wifiNetworks"
                  :key="network.ssid"
                  :value="network.ssid"
                >
                  {{ network.ssid }}
                </option>
              </select>
            </label>
            <label>
              <span>无线网络密码</span>
              <input
                v-model="networkForm.password"
                class="kiosk-touch-target"
                type="password"
              />
            </label>
            <button
              class="kiosk-touch-target primary-action"
              type="submit"
              :disabled="!canExecuteCurrentTask() || submitting"
            >
              {{ submitting ? "正在提交网络" : "提交网络设置" }}
            </button>
            <button
              v-if="
                currentTask.projection.type === 'network_settings' &&
                currentTask.projection.supportsExistingNetworkProbe
              "
              class="kiosk-touch-target secondary-action"
              type="button"
              :disabled="submitting"
              @click="probeExistingNetwork"
            >
              验证现有网络
            </button>
          </form>

          <form
            v-else-if="
              currentTask?.intent === 'claim_machine' ||
              currentTask?.intent === 'reclaim_machine'
            "
            @submit.prevent="submitClaim"
          >
            <label>
              <span>领取码</span>
              <input
                v-model="claimForm.claimCode"
                autocomplete="one-time-code"
                class="kiosk-touch-target"
              />
            </label>
            <button
              class="kiosk-touch-target primary-action"
              type="submit"
              :disabled="!canExecuteCurrentTask() || submitting"
            >
              {{ submitting ? "正在领取" : "提交领取码" }}
            </button>
          </form>

          <button
            v-else-if="currentTask"
            class="kiosk-touch-target primary-action"
            type="button"
            :disabled="!canExecuteCurrentTask() || submitting"
            @click="submitCurrentTask"
          >
            {{
              currentTask.intent === "refresh_profile"
                ? "重新读取运行档案"
                : "前往维护控制台继续"
            }}
          </button>

          <p v-if="networkResult">{{ networkResult.operatorGuidance }}</p>
          <ul
            v-if="networkResult?.diagnostics.length"
            class="network-diagnostics"
            aria-label="网络就绪诊断"
          >
            <li
              v-for="diagnostic in networkResult.diagnostics"
              :key="diagnostic.code"
            >
              <template v-if="diagnostic.evidence">
                {{ diagnostic.evidence.source }} ·
                {{ diagnostic.evidence.status }} ·
                {{ diagnostic.evidence.reasonCode }}：{{
                  diagnostic.evidence.reason
                }}
                （处理：{{ diagnostic.evidence.recoveryAction }}）
              </template>
              <template v-else>
                {{ diagnostic.component }} · {{ diagnostic.code }}：{{
                  diagnostic.message
                }}
              </template>
            </li>
          </ul>
          <p v-if="statusMessage">{{ statusMessage }}</p>
        </section>

        <section class="progress" aria-label="首次部署进度">
          <p v-for="step in progress" :key="step.kind" :class="step.status">
            {{ progressLabel(step) }}
          </p>
        </section>
      </main>
    </section>
  </KioskLayout>
</template>

<style scoped>
.bring-up-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 3rem;
  color: white;
}
header p {
  color: #bae6fd;
  letter-spacing: 0.15em;
}
h1 {
  font-size: 2.5rem;
  margin: 0.5rem 0;
}
main {
  display: grid;
  gap: 1.5rem;
  margin-top: 2rem;
}
.network-diagnostics {
  margin: 1rem 0 0;
  padding-left: 1.25rem;
  color: #dbeafe;
}
.current-task,
.progress {
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 1.25rem;
  padding: 1.5rem;
  background: rgb(15 23 42 / 0.7);
}
.current-task > p:first-child {
  font-size: 1.5rem;
  font-weight: 700;
}
form {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
}
label {
  display: grid;
  gap: 0.5rem;
}
input,
select {
  color: #0f172a;
  padding: 0.75rem;
  border-radius: 0.75rem;
}
button {
  margin-top: 1rem;
  padding: 0.8rem 1.2rem;
  border-radius: 0.75rem;
  background: #0284c7;
  color: white;
}
.progress {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
}
.progress p {
  margin: 0;
  padding: 0.4rem 0.7rem;
  border-radius: 99px;
  background: rgb(255 255 255 / 0.08);
}
.progress .completed {
  color: #bbf7d0;
}
.progress .current {
  background: #0369a1;
}
.progress .revalidate {
  color: #fde68a;
}
</style>
