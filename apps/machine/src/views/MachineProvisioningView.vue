<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type {
  BringUpSnapshot,
  NetworkSettingsResponse,
} from "@/daemon/schemas";

import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";
import { DaemonUnavailableError, daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();
const route = useRoute();
const router = useRouter();
const { handleMaintenanceTap } = useMaintenanceEntry();

const PROVISIONING_CONFIG_RETRY_DELAY_MS = 500;
const PROVISIONING_CONFIG_MAX_ATTEMPTS = 20;

const claimForm = reactive({
  claimCode: "",
});
const networkForm = reactive({
  ssid: "",
  password: "",
  hidden: false,
});
const bringUp = ref<BringUpSnapshot | null>(null);
const loading = ref(false);
const submittingClaim = ref(false);
const submittingNetwork = ref(false);
const exportingEvidence = ref(false);
const statusMessage = ref<string | null>(null);
const statusKind = ref<"idle" | "pending" | "success" | "failure">("idle");
const networkResult = ref<NetworkSettingsResponse | null>(null);
const protectedMaintenanceEnabled = ref(false);
const reclaimMode = ref(false);
type BringUpReason = BringUpSnapshot["blockingReasons"][number];
type DisplayReason = {
  title: string;
  detail: string;
  meta: string;
};

const stateLabel = computed(() =>
  bringUp.value ? bringUpStateLabel(bringUp.value.state) : "正在读取",
);
const readinessLabel = computed(() =>
  bringUp.value ? readinessLevelLabel(bringUp.value.readinessLevel) : "未确认",
);
const hardwareModeLabel = computed(() =>
  bringUp.value ? hardwareModeLabelFor(bringUp.value.hardwareMode) : "未确认",
);
const primaryReasons = computed(() => bringUp.value?.blockingReasons ?? []);
const diagnostics = computed(() => bringUp.value?.diagnostics ?? []);
const actionRows = computed(() =>
  bringUp.value ? bringUpActions(bringUp.value) : [],
);
const protectedActionRows = computed(() => [
  {
    key: "reclaim",
    label: "重新领取机器",
    description: "用于更换主机或本机重装后的机器重新领取。",
  },
  {
    key: "local-reset",
    label: "本机重置",
    description: "清理本机身份与本地运行状态后重新进入首次部署。",
  },
  {
    key: "acceptance-rerun",
    label: "重新运行验收",
    description: "生产运行后复核本机运行验收或现场验收状态。",
  },
]);
const claimAllowed = computed(
  () =>
    reclaimMode.value ||
    bringUp.value?.allowedActions.claimMachine === true ||
    bringUp.value?.allowedActions.retryClaim === true,
);
const networkAllowed = computed(
  () => bringUp.value?.allowedActions.configureNetwork === true,
);

function bringUpStateLabel(state: BringUpSnapshot["state"]): string {
  const labels: Record<BringUpSnapshot["state"], string> = {
    network_required: "需要配置网络",
    platform_reachable: "平台已连通",
    claim_required: "等待机器领取",
    profile_applied: "运行档案已写入",
    topology_mismatch: "货道拓扑不匹配",
    hardware_acceptance_required: "需要硬件验收",
    stock_attestation_required: "需要库存确认",
    runtime_ready: "运行边界已就绪",
    simulated_hardware_ready: "模拟硬件已就绪",
    sell_ready: "可进入生产售卖",
  };
  return labels[state];
}

function readinessLevelLabel(level: BringUpSnapshot["readinessLevel"]): string {
  const labels: Record<BringUpSnapshot["readinessLevel"], string> = {
    not_ready: "未就绪",
    runtime_ready: "本机运行就绪",
    simulated_hardware_ready: "模拟硬件就绪",
    sell_ready: "可售卖",
  };
  return labels[level];
}

function hardwareModeLabelFor(mode: BringUpSnapshot["hardwareMode"]): string {
  return mode === "production" ? "生产硬件模式" : "模拟硬件模式";
}

function bringUpActions(snapshot: BringUpSnapshot) {
  return [
    {
      key: "configureNetwork",
      label: "配置现场网络",
      enabled: snapshot.allowedActions.configureNetwork,
    },
    {
      key: "claimMachine",
      label: snapshot.allowedActions.retryClaim
        ? "重新提交领取码"
        : "提交领取码",
      enabled:
        snapshot.allowedActions.claimMachine ||
        snapshot.allowedActions.retryClaim,
    },
    {
      key: "syncProfile",
      label: "同步运行档案",
      enabled: snapshot.allowedActions.syncProfile,
    },
    {
      key: "resolveTopology",
      label: "处理货道拓扑",
      enabled: snapshot.allowedActions.resolveTopology,
    },
    {
      key: "runRuntimeAcceptance",
      label: "本机运行验收",
      enabled: snapshot.allowedActions.runRuntimeAcceptance,
    },
    {
      key: "runHardwareAcceptance",
      label: "运行硬件验收",
      enabled: snapshot.allowedActions.runHardwareAcceptance,
    },
    {
      key: "attestStock",
      label: "确认初始库存",
      enabled: snapshot.allowedActions.attestStock,
    },
    {
      key: "startSales",
      label: "进入售卖",
      enabled: snapshot.allowedActions.startSales,
    },
  ];
}

function componentLabel(component: string): string {
  const labels: Record<string, string> = {
    acceptance: "验收",
    config: "运行档案",
    hardware: "生产硬件",
    "lower-controller": "下位机",
    platform: "平台连接",
    provisioning: "机器领取",
    stock: "库存",
    topology: "货道拓扑",
  };
  return labels[component] ?? "本机状态";
}

function reasonCodeLabel(code: string): string {
  const labels: Record<string, string> = {
    ACTIVE_PLANOGRAM_MISSING: "运营货道档案缺失",
    CLAIM_REQUIRED: "等待领取",
    CONFIG_SUMMARY_UNAVAILABLE: "运行档案不可读",
    HARDWARE_ACCEPTANCE_REQUIRED: "需要硬件验收",
    HARDWARE_SLOT_TOPOLOGY_CHECK_FAILED: "货道拓扑检查失败",
    HARDWARE_SLOT_TOPOLOGY_LOCAL_MISSING: "本机货道拓扑缺失",
    HARDWARE_SLOT_TOPOLOGY_MISMATCH: "货道拓扑不一致",
    HARDWARE_SLOT_TOPOLOGY_NOT_CONFIGURED: "货道拓扑未配置",
    HARDWARE_SLOT_TOPOLOGY_PLATFORM_MISSING: "平台货道拓扑缺失",
    LOWER_CONTROLLER_SLOT_COUNT: "货道数量不一致",
    NETWORK_REQUIRED: "需要配置网络",
    PLATFORM_REACHABLE: "平台已连通",
    PUBLIC_CONFIG_PROFILE_APPLIED: "运行档案已写入",
    PUBLIC_CONFIG_UNCLAIMED: "尚未领取机器",
    RUNTIME_ACCEPTANCE_PENDING: "本机运行验收待完成",
    STOCK_ATTESTATION_REQUIRED: "需要库存确认",
    TOPOLOGY_MISMATCH: "货道拓扑不一致",
  };
  return labels[code] ?? "未识别状态";
}

function reasonDisplay(reason: BringUpReason): DisplayReason {
  const copies: Record<string, Omit<DisplayReason, "meta">> = {
    ACTIVE_PLANOGRAM_MISSING: {
      title: "尚未应用运营货道档案",
      detail: "请先同步或确认平台下发的运营货道档案。",
    },
    CLAIM_REQUIRED: {
      title: "机器尚未领取",
      detail: "请输入管理员生成的领取码完成机器领取。",
    },
    CONFIG_SUMMARY_UNAVAILABLE: {
      title: "运行档案暂不可读",
      detail: "请稍后重试；如果持续失败，请导出现场证据。",
    },
    HARDWARE_ACCEPTANCE_REQUIRED: {
      title: "需要完成生产硬件验收",
      detail: "请确认下位机、扫码器和出货链路满足现场验收要求。",
    },
    HARDWARE_SLOT_TOPOLOGY_CHECK_FAILED: {
      title: "货道拓扑检查失败",
      detail: "请复核本机货道返回与平台档案后重试。",
    },
    HARDWARE_SLOT_TOPOLOGY_LOCAL_MISSING: {
      title: "本机货道拓扑缺失",
      detail: "请先完成下位机货道识别或检查硬件连接。",
    },
    HARDWARE_SLOT_TOPOLOGY_MISMATCH: {
      title: "平台货道拓扑与本机下位机返回不一致",
      detail: "请按现场实物核对平台档案和下位机货道返回。",
    },
    HARDWARE_SLOT_TOPOLOGY_NOT_CONFIGURED: {
      title: "货道拓扑尚未配置",
      detail: "请先配置平台货道档案并同步到本机。",
    },
    HARDWARE_SLOT_TOPOLOGY_PLATFORM_MISSING: {
      title: "平台货道拓扑缺失",
      detail: "请在平台补齐机器货道档案后再继续。",
    },
    LOWER_CONTROLLER_SLOT_COUNT: {
      title: "下位机返回货道数量与平台档案不一致",
      detail: "请核对下位机连接、货道数量和平台档案。",
    },
    NETWORK_REQUIRED: {
      title: "需要配置现场网络",
      detail: "请写入现场网络设置，并确认平台地址可连通。",
    },
    PLATFORM_REACHABLE: {
      title: "平台连接已连通",
      detail: "本机可继续执行后续首次部署步骤。",
    },
    PUBLIC_CONFIG_PROFILE_APPLIED: {
      title: "运行档案已写入",
      detail: "本机已具备平台机器身份与基础运行配置。",
    },
    PUBLIC_CONFIG_UNCLAIMED: {
      title: "本机尚未领取平台机器",
      detail: "请提交领取码写入机器运行档案。",
    },
    RUNTIME_ACCEPTANCE_PENDING: {
      title: "本机运行验收尚未完成",
      detail: "请完成本机运行验收并导出现场证据。",
    },
    STOCK_ATTESTATION_REQUIRED: {
      title: "需要确认初始库存",
      detail: "请按现场实物确认初始库存后再进入售卖。",
    },
    TOPOLOGY_MISMATCH: {
      title: "货道拓扑不一致",
      detail: "请核对本机货道与平台档案。",
    },
  };
  const copy = copies[reason.code] ?? {
    title: "存在未识别状态项",
    detail: "请导出现场证据并交由维护人员处理。",
  };
  return {
    ...copy,
    meta: `${componentLabel(reason.component)} · ${reasonCodeLabel(reason.code)}`,
  };
}

function networkStatusLabel(status: NetworkSettingsResponse["status"]): string {
  const labels: Record<NetworkSettingsResponse["status"], string> = {
    connected: "已连通",
    failed: "连接失败",
    unsupported: "暂不支持",
  };
  return labels[status];
}

function provisioningFailureMessage(error: unknown): string {
  const responseCode =
    typeof error === "object" && error !== null && "responseCode" in error
      ? String((error as { responseCode?: unknown }).responseCode ?? "")
      : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const code = `${responseCode} ${message}`.toLowerCase();

  if (code.includes("invalid_or_expired")) {
    return "领取码无效或已过期，请联系管理员确认后重试";
  }
  if (code.includes("invalid")) return "领取码无效，请核对后重试";
  if (code.includes("expired")) return "领取码已过期，请联系管理员重新生成";
  if (code.includes("used") || code.includes("consumed")) {
    return "领取码已使用，请联系管理员确认机器状态";
  }
  if (code.includes("revoked")) return "领取码已撤销，请联系管理员重新生成";
  if (code.includes("locked")) return "领取码已锁定，请联系管理员处理";
  if (error instanceof DaemonUnavailableError && !error.responseCode) {
    return "本机服务暂不可用，请稍后重试";
  }
  if (
    responseCode === "machine_claim_backend_unavailable" ||
    code.includes("network") ||
    code.includes("unavailable")
  ) {
    return "网络不可用，请检查连接后重试";
  }
  return "领取失败，请联系维护人员重试";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForProvisionedConfig(): Promise<void> {
  for (
    let attempt = 0;
    attempt < PROVISIONING_CONFIG_MAX_ATTEMPTS;
    attempt += 1
  ) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- provisioning readiness is a sequential retry loop.
      await machineStore.loadConfig();
      if (machineStore.configSummary?.provisioned === true) {
        return;
      }
    } catch (error) {
      if (error instanceof DaemonUnavailableError) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- wait for daemon initialization before the next poll.
        await daemonClient.initialize(true).catch(() => undefined);
      } else {
        throw error;
      }
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- keep retry cadence stable.
    await delay(PROVISIONING_CONFIG_RETRY_DELAY_MS);
  }

  throw new DaemonUnavailableError(
    "daemon provisioning config did not become ready",
  );
}

async function refreshBringUp(): Promise<void> {
  loading.value = true;
  try {
    bringUp.value = await daemonClient.getBringUp();
  } catch (error) {
    statusKind.value = "failure";
    statusMessage.value =
      error instanceof Error ? error.message : "无法读取本机 bring-up 状态";
  } finally {
    loading.value = false;
  }
}

async function submitClaim(): Promise<void> {
  const claimCode = claimForm.claimCode.trim().toUpperCase();
  if (!claimCode || submittingClaim.value || !claimAllowed.value) return;

  submittingClaim.value = true;
  statusKind.value = "pending";
  statusMessage.value = "正在提交机器领取码";
  try {
    const result = reclaimMode.value
      ? await daemonClient.claimMachine(claimCode, {
          rotateMaintenanceIdentity: true,
        })
      : await daemonClient.claimMachine(claimCode);
    machineStore.configSummary = result.config;
    machineStore.configLoaded = true;
    claimForm.claimCode = "";
    reclaimMode.value = false;
    statusMessage.value = "正在等待本机服务应用新配置";
    await waitForProvisionedConfig();
    await refreshBringUp();
    await router.replace("/boot");
    statusKind.value = "success";
    statusMessage.value = "领取成功，正在进入启动流程";
  } catch (error) {
    statusKind.value = "failure";
    statusMessage.value = provisioningFailureMessage(error);
  } finally {
    submittingClaim.value = false;
  }
}

async function startReclaim(): Promise<void> {
  if (!protectedMaintenanceEnabled.value || submittingClaim.value) return;
  const maintenance = await daemonClient.getMaintenanceStatus();
  if (!maintenance.activeIdentityRetained) {
    statusKind.value = "failure";
    statusMessage.value = "本机没有可保留的维护身份，不能执行重新领取";
    return;
  }
  reclaimMode.value = true;
  statusKind.value = "idle";
  statusMessage.value = "请输入管理员生成的重新领取码";
}

async function submitNetworkSettings(): Promise<void> {
  if (
    !networkForm.ssid.trim() ||
    submittingNetwork.value ||
    !networkAllowed.value
  ) {
    return;
  }
  submittingNetwork.value = true;
  statusKind.value = "pending";
  statusMessage.value = "正在写入现场网络设置";
  const password = networkForm.password;
  try {
    networkResult.value = await daemonClient.applyNetworkSettings({
      ssid: networkForm.ssid.trim(),
      password,
      hidden: networkForm.hidden,
    });
    statusKind.value =
      networkResult.value.status === "connected" ? "success" : "failure";
    statusMessage.value = networkResult.value.operatorGuidance;
    await refreshBringUp();
  } catch (error) {
    statusKind.value = "failure";
    statusMessage.value = "网络设置提交失败，请检查现场网络后重试";
  } finally {
    networkForm.password = "";
    submittingNetwork.value = false;
  }
}

async function exportEvidence(): Promise<void> {
  if (exportingEvidence.value) return;
  exportingEvidence.value = true;
  statusKind.value = "pending";
  statusMessage.value = "正在导出现场证据";
  try {
    await daemonClient.downloadLogExport();
    statusKind.value = "success";
    statusMessage.value = "现场证据已导出";
  } catch (error) {
    statusKind.value = "failure";
    statusMessage.value =
      error instanceof Error ? error.message : "现场证据导出失败";
  } finally {
    exportingEvidence.value = false;
  }
}

onMounted(async () => {
  try {
    const connection = await daemonClient.initialize();
    protectedMaintenanceEnabled.value =
      route.query.source === "protected-maintenance" &&
      connection.runtimeFlags?.advancedMaintenanceConfig === true;
  } catch {
    protectedMaintenanceEnabled.value = false;
  }
  void refreshBringUp();
});
</script>

<template>
  <KioskLayout>
    <section class="bring-up-page">
      <header class="bring-up-header">
        <div class="bring-up-brand" @click="handleMaintenanceTap">
          <img :src="logoImage" alt="唐诗村" />
          <img :src="mascotTopImage" alt="" aria-hidden="true" />
        </div>
        <div class="bring-up-title-block">
          <p>首次部署</p>
          <h2>首次部署控制台</h2>
        </div>
      </header>

      <main class="bring-up-main" aria-label="首次部署控制台">
        <section class="bring-up-hero">
          <div>
            <p class="bring-up-eyebrow">本机状态</p>
            <h1>{{ stateLabel }}</h1>
            <p>
              按本机服务返回的首次部署状态推进网络、领取、拓扑核对、验收和证据导出。
            </p>
          </div>
          <dl class="bring-up-summary">
            <div>
              <dt>就绪级别</dt>
              <dd>{{ readinessLabel }}</dd>
            </div>
            <div>
              <dt>硬件模式</dt>
              <dd>{{ hardwareModeLabel }}</dd>
            </div>
            <div>
              <dt>更新时间</dt>
              <dd>{{ bringUp?.updatedAt ?? "等待本机服务返回" }}</dd>
            </div>
          </dl>
        </section>

        <section class="bring-up-grid">
          <section class="bring-up-panel">
            <div class="panel-heading">
              <p class="bring-up-eyebrow">阻塞原因</p>
              <h3>下一步处理</h3>
            </div>
            <ul v-if="primaryReasons.length" class="reason-list">
              <li v-for="reason in primaryReasons" :key="reason.code">
                <strong>{{ reasonDisplay(reason).title }}</strong>
                <span>{{ reasonDisplay(reason).meta }}</span>
                <small>{{ reasonDisplay(reason).detail }}</small>
              </li>
            </ul>
            <p v-else class="empty-copy">本机服务未返回阻塞原因。</p>
          </section>

          <section class="bring-up-panel">
            <div class="panel-heading">
              <p class="bring-up-eyebrow">诊断</p>
              <h3>现场核对</h3>
            </div>
            <ul v-if="diagnostics.length" class="reason-list diagnostic-list">
              <li
                v-for="item in diagnostics"
                :key="`${item.component}-${item.code}`"
              >
                <strong>{{ reasonDisplay(item).title }}</strong>
                <span>{{ reasonDisplay(item).meta }}</span>
                <small>{{ reasonDisplay(item).detail }}</small>
              </li>
            </ul>
            <p v-else class="empty-copy">暂无额外诊断。</p>
          </section>
        </section>

        <section class="bring-up-panel action-panel">
          <div class="panel-heading">
            <p class="bring-up-eyebrow">允许动作</p>
            <h3>本机服务允许的步骤</h3>
          </div>
          <div class="action-list">
            <button
              v-for="action in actionRows"
              :key="action.key"
              class="kiosk-touch-target action-chip"
              :class="{ enabled: action.enabled }"
              :disabled="!action.enabled"
              type="button"
            >
              {{ action.label }}
            </button>
          </div>
        </section>

        <section class="bring-up-grid">
          <form
            class="bring-up-panel bring-up-form"
            @submit.prevent="submitNetworkSettings"
          >
            <div class="panel-heading">
              <p class="bring-up-eyebrow">现场网络</p>
              <h3>写入连接设置</h3>
            </div>
            <label>
              <span>无线网络名称</span>
              <input v-model="networkForm.ssid" class="kiosk-touch-target" />
            </label>
            <label>
              <span>无线网络密码</span>
              <input
                v-model="networkForm.password"
                class="kiosk-touch-target"
                type="password"
              />
            </label>
            <label class="checkbox-row">
              <input v-model="networkForm.hidden" type="checkbox" />
              <span>隐藏网络</span>
            </label>
            <button
              class="kiosk-touch-target primary-action"
              :disabled="
                submittingNetwork || !networkAllowed || !networkForm.ssid.trim()
              "
              type="submit"
            >
              {{ submittingNetwork ? "正在提交网络" : "提交网络设置" }}
            </button>
            <p v-if="networkResult" class="inline-result">
              {{ networkStatusLabel(networkResult.status) }} ·
              {{ networkResult.operatorGuidance }}
            </p>
          </form>

          <form
            class="bring-up-panel bring-up-form"
            @submit.prevent="submitClaim"
          >
            <div class="panel-heading">
              <p class="bring-up-eyebrow">机器领取</p>
              <h3>{{ reclaimMode ? "提交重新领取码" : "提交领取码" }}</h3>
            </div>
            <label>
              <span>领取码</span>
              <input
                v-model="claimForm.claimCode"
                autocomplete="one-time-code"
                class="kiosk-touch-target claim-code-input"
                inputmode="text"
                placeholder="ABCD-2345"
              />
            </label>
            <button
              class="kiosk-touch-target primary-action"
              :disabled="
                submittingClaim || !claimAllowed || !claimForm.claimCode.trim()
              "
              type="submit"
            >
              {{
                submittingClaim
                  ? "正在领取"
                  : reclaimMode
                    ? "提交重新领取码"
                    : "提交领取码"
              }}
            </button>
          </form>
        </section>

        <section class="bring-up-grid">
          <section class="bring-up-panel">
            <div class="panel-heading">
              <p class="bring-up-eyebrow">生产验收</p>
              <h3>拓扑、验收、库存</h3>
            </div>
            <p class="empty-copy">
              货道拓扑不匹配、本机运行验收、硬件验收和库存确认均以本机服务允许动作为准。
            </p>
            <button
              class="kiosk-touch-target secondary-action"
              :disabled="exportingEvidence"
              type="button"
              @click="exportEvidence"
            >
              {{ exportingEvidence ? "正在导出" : "导出现场证据" }}
            </button>
          </section>

          <section class="bring-up-panel protected-panel">
            <div class="panel-heading">
              <p class="bring-up-eyebrow">受保护维护</p>
              <h3>回收与重置入口</h3>
            </div>
            <p class="empty-copy">
              生产运行后的重新领取、本机重置和验收重跑需要受保护维护凭据。
            </p>
            <div class="protected-actions">
              <button
                v-for="action in protectedActionRows"
                :key="action.key"
                class="kiosk-touch-target secondary-action"
                :disabled="
                  action.key !== 'reclaim' || !protectedMaintenanceEnabled
                "
                type="button"
                :title="action.description"
                @click="action.key === 'reclaim' && startReclaim()"
              >
                {{ action.label }}
              </button>
            </div>
          </section>
        </section>

        <p
          v-if="statusMessage || loading"
          :class="`bring-up-status ${statusKind}`"
          aria-live="polite"
        >
          {{ loading ? "正在读取首次部署状态" : statusMessage }}
        </p>
      </main>

      <img
        :src="listSloganImage"
        alt=""
        aria-hidden="true"
        class="bring-up-slogan"
      />
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.bring-up-page)) {
  padding: 0;
}

:global(.kiosk-shell:has(.bring-up-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.bring-up-page) > .kiosk-scroll) {
  width: 100%;
  height: 100%;
  margin-top: 0;
  padding-bottom: 0;
}

.bring-up-page {
  position: relative;
  min-height: 100%;
  overflow-x: hidden;
  background:
    radial-gradient(
      circle at 18% 6%,
      rgba(255, 255, 255, 0.92),
      rgba(255, 255, 255, 0) 28%
    ),
    linear-gradient(180deg, #faf8f1 0%, #f4efe2 54%, #efe8d8 100%);
  padding: var(--machine-page-header-top) var(--machine-page-inline) 2rem;
  color: #3f3b34;
}

.bring-up-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
}

.bring-up-brand {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  min-width: 0;
}

.bring-up-brand img:first-child {
  width: var(--machine-brand-logo-width);
  height: auto;
}

.bring-up-brand img:last-child {
  width: clamp(2.5rem, 8vw, 4rem);
  height: auto;
  opacity: 0.82;
}

.bring-up-title-block {
  text-align: right;
}

.bring-up-title-block p,
.bring-up-eyebrow {
  margin: 0;
  color: #6d7f5f;
  font-size: 0.74rem;
  font-weight: 700;
}

.bring-up-title-block h2 {
  margin: 0.18rem 0 0;
  color: #263326;
  font-size: 1.45rem;
  font-weight: 800;
}

.bring-up-main {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 0.8rem;
  margin-top: 1.35rem;
}

.bring-up-hero,
.bring-up-panel {
  border: 1px solid rgba(126, 112, 82, 0.28);
  border-radius: 0.65rem;
  background: rgba(255, 253, 247, 0.86);
  box-shadow: 0 1rem 2.4rem rgba(98, 80, 50, 0.08);
}

.bring-up-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(17rem, 0.9fr);
  gap: 1rem;
  align-items: stretch;
  padding: 1rem 1.15rem;
}

.bring-up-hero h1 {
  margin: 0.34rem 0 0;
  color: #263326;
  font-size: clamp(1.8rem, 4vw, 3rem);
  line-height: 1.08;
  font-weight: 850;
}

.bring-up-hero p:last-child,
.empty-copy,
.inline-result {
  margin: 0.5rem 0 0;
  color: #6f675c;
  font-size: 0.92rem;
  line-height: 1.45;
}

.bring-up-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0;
}

.bring-up-summary div {
  min-width: 0;
  border: 1px solid rgba(126, 112, 82, 0.2);
  border-radius: 0.48rem;
  background: rgba(255, 253, 247, 0.66);
  padding: 0.66rem 0.75rem;
}

.bring-up-summary dt {
  color: #6f675c;
  font-size: 0.78rem;
  font-weight: 700;
}

.bring-up-summary dd {
  margin: 0.24rem 0 0;
  overflow-wrap: anywhere;
  color: #263326;
  font-size: 0.96rem;
  font-weight: 800;
}

.bring-up-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8rem;
}

.bring-up-panel {
  min-width: 0;
  padding: 0.95rem 1rem;
}

.panel-heading h3 {
  margin: 0.24rem 0 0;
  color: #263326;
  font-size: 1.18rem;
  font-weight: 820;
}

.reason-list {
  display: grid;
  gap: 0.5rem;
  margin: 0.75rem 0 0;
  padding: 0;
  list-style: none;
}

.reason-list li {
  display: grid;
  gap: 0.2rem;
  border: 1px solid rgba(126, 112, 82, 0.18);
  border-radius: 0.48rem;
  background: rgba(250, 248, 241, 0.72);
  padding: 0.66rem 0.75rem;
}

.reason-list strong {
  color: #3f3b34;
  font-size: 0.92rem;
}

.reason-list span {
  color: #6f675c;
  font-size: 0.78rem;
  overflow-wrap: anywhere;
}

.reason-list small {
  color: #6f675c;
  font-size: 0.82rem;
  line-height: 1.38;
}

.diagnostic-list li {
  background: rgba(242, 247, 236, 0.72);
}

.action-panel {
  display: grid;
  gap: 0.75rem;
}

.action-list,
.protected-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5rem;
}

.action-chip,
.primary-action,
.secondary-action {
  min-height: 3rem;
  border: 1px solid rgba(93, 112, 80, 0.32);
  border-radius: 0.42rem;
  background: rgba(255, 253, 247, 0.78);
  color: #4d463c;
  font-weight: 800;
}

.action-chip.enabled,
.primary-action {
  background: #6f835f;
  color: #fffdf7;
}

.action-chip:disabled,
.primary-action:disabled,
.secondary-action:disabled {
  background: rgba(111, 131, 95, 0.16);
  color: rgba(63, 59, 52, 0.48);
}

.bring-up-form {
  display: grid;
  gap: 0.62rem;
}

.bring-up-form label {
  display: grid;
  gap: 0.34rem;
  min-width: 0;
  color: #4d463c;
  font-weight: 700;
}

.bring-up-form input:not([type="checkbox"]) {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  min-height: 3.1rem;
  border: 1px solid rgba(126, 112, 82, 0.3);
  border-radius: 0.42rem;
  background: rgba(255, 255, 255, 0.78);
  padding: 0 0.9rem;
  color: #2f2a23;
  font-size: 1rem;
  font-weight: 700;
  outline: none;
}

.claim-code-input {
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.checkbox-row {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.bring-up-status {
  margin: 0;
  border: 1px solid rgba(99, 119, 85, 0.2);
  border-radius: 0.42rem;
  background: rgba(242, 247, 236, 0.88);
  padding: 0.82rem 1rem;
  color: #4f6845;
  font-weight: 700;
}

.bring-up-status.pending {
  border-color: rgba(181, 126, 34, 0.24);
  background: rgba(255, 246, 220, 0.82);
  color: #70501d;
}

.bring-up-status.failure {
  border-color: rgba(174, 74, 70, 0.28);
  background: rgba(255, 239, 235, 0.9);
  color: #7b3430;
}

.bring-up-slogan {
  position: absolute;
  right: 2.2rem;
  bottom: 1.4rem;
  width: min(21rem, 54%);
  opacity: 0.26;
}

@media (max-width: 760px) {
  .bring-up-page {
    padding: 1.35rem 1.25rem 1.75rem;
  }

  .bring-up-header,
  .bring-up-hero,
  .bring-up-grid,
  .bring-up-summary,
  .action-list,
  .protected-actions {
    grid-template-columns: 1fr;
  }

  .bring-up-title-block {
    text-align: left;
  }
}
</style>
