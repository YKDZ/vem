<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import listSloganImage from "@/assets/home/list-slogan.png";
import logoImage from "@/assets/home/logo.png";
import mascotTopImage from "@/assets/home/mascot-top-cutout.png";
import { useMaintenanceEntry } from "@/composables/useMaintenanceEntry";
import { DaemonUnavailableError, daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();
const router = useRouter();
const { handleMaintenanceTap } = useMaintenanceEntry();

const form = reactive({
  claimCode: "",
});
const loadingConfig = ref(false);
const submitting = ref(false);
const statusMessage = ref<string | null>(null);
const statusKind = ref<"idle" | "pending" | "success" | "failure">("idle");

const PROVISIONING_CONFIG_RETRY_DELAY_MS = 500;
const PROVISIONING_CONFIG_MAX_ATTEMPTS = 20;

const diagnostics = computed(() => [
  {
    label: "机器凭据",
    configured: machineStore.config.machineSecretConfigured,
  },
  {
    label: "MQTT 签名",
    configured: machineStore.config.mqttSigningSecretConfigured,
  },
  {
    label: "MQTT 密码",
    configured: machineStore.config.mqttPasswordConfigured,
  },
]);

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
    return "本机 daemon 暂不可用，请稍后重试";
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

onMounted(async () => {
  loadingConfig.value = true;
  try {
    await machineStore.loadConfig();
  } catch {
    // The claim form remains usable; submit will report daemon/connectivity errors.
  } finally {
    loadingConfig.value = false;
  }
});

async function submitClaim(): Promise<void> {
  const claimCode = form.claimCode.trim().toUpperCase();
  if (!claimCode || submitting.value) return;

  submitting.value = true;
  statusKind.value = "pending";
  statusMessage.value = "正在领取机器配置";
  try {
    const result = await daemonClient.claimMachine(claimCode);
    machineStore.configSummary = result.config;
    machineStore.configLoaded = true;
    statusKind.value = "pending";
    statusMessage.value = "正在等待 daemon 应用新配置";
    form.claimCode = "";
    await waitForProvisionedConfig();
    await router.replace("/boot");
    statusKind.value = "success";
    statusMessage.value = "领取成功，正在进入启动流程";
  } catch (error) {
    statusKind.value = "failure";
    statusMessage.value = provisioningFailureMessage(error);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <KioskLayout>
    <section class="provisioning-page">
      <header class="provisioning-header">
        <div class="provisioning-brand" @click="handleMaintenanceTap">
          <img :src="logoImage" alt="唐诗村" />
          <img :src="mascotTopImage" alt="" aria-hidden="true" />
        </div>
        <div class="provisioning-title-block">
          <p>PROVISIONING</p>
          <h2>机器领取</h2>
        </div>
      </header>

      <main class="provisioning-main">
        <section class="provisioning-panel">
          <div class="provisioning-copy">
            <p class="provisioning-eyebrow">Machine Claim Code</p>
            <h1>输入领取码完成本机接入</h1>
            <p>提交后，设备会写入机器凭据并返回启动流程。</p>
          </div>

          <form class="provisioning-form" @submit.prevent="submitClaim">
            <label>
              <span>领取码</span>
              <input
                v-model="form.claimCode"
                autocomplete="one-time-code"
                class="kiosk-touch-target"
                inputmode="text"
                placeholder="ABCD-2345"
              />
            </label>

            <button
              class="kiosk-touch-target"
              :disabled="submitting || !form.claimCode.trim()"
              type="submit"
            >
              {{ submitting ? "正在领取" : "提交领取码" }}
            </button>
          </form>

          <p
            v-if="statusMessage"
            :class="`provisioning-status ${statusKind}`"
            aria-live="polite"
          >
            {{ statusMessage }}
          </p>
        </section>

        <section class="provisioning-diagnostics">
          <div>
            <p class="provisioning-eyebrow">Diagnostics</p>
            <h3>安全诊断</h3>
          </div>

          <dl>
            <div v-for="item in diagnostics" :key="item.label">
              <dt>{{ item.label }}</dt>
              <dd :class="{ configured: item.configured }">
                {{ item.configured ? "已配置" : "未配置" }}
              </dd>
            </div>
          </dl>
          <p v-if="loadingConfig" class="provisioning-loading">
            正在读取 daemon 配置状态
          </p>
        </section>
      </main>

      <img
        :src="listSloganImage"
        alt=""
        aria-hidden="true"
        class="provisioning-slogan"
      />
    </section>
  </KioskLayout>
</template>

<style scoped>
:global(.kiosk-shell:has(.provisioning-page)) {
  padding: 0;
}

:global(.kiosk-shell:has(.provisioning-page) > header) {
  display: none;
}

:global(.kiosk-shell:has(.provisioning-page) > .kiosk-scroll) {
  width: 100%;
  height: 100%;
  margin-top: 0;
  padding-bottom: 0;
}

.provisioning-page {
  position: relative;
  min-height: 100%;
  padding: var(--machine-page-header-top) var(--machine-page-inline) 2.5rem;
  overflow-x: hidden;
  color: #3f3b34;
  background:
    radial-gradient(
      circle at 18% 6%,
      rgba(255, 255, 255, 0.92),
      rgba(255, 255, 255, 0) 28%
    ),
    linear-gradient(180deg, #faf8f1 0%, #f4efe2 54%, #efe8d8 100%);
}

.provisioning-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  align-items: center;
}

.provisioning-brand {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  min-width: 0;
}

.provisioning-brand img:first-child {
  width: var(--machine-brand-logo-width);
  height: auto;
}

.provisioning-brand img:last-child {
  width: clamp(2.5rem, 8vw, 4rem);
  height: auto;
  opacity: 0.82;
}

.provisioning-title-block {
  text-align: right;
}

.provisioning-title-block p,
.provisioning-eyebrow {
  margin: 0;
  color: #6d7f5f;
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.14em;
}

.provisioning-title-block h2 {
  margin-top: 0.18rem;
  color: #263326;
  font-size: 1.45rem;
  font-weight: 800;
}

.provisioning-main {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.9rem;
  align-items: start;
  margin-top: 1.75rem;
}

.provisioning-panel,
.provisioning-diagnostics {
  min-width: 0;
  border: 1px solid rgba(126, 112, 82, 0.28);
  border-radius: 0.65rem;
  background: rgba(255, 253, 247, 0.84);
  box-shadow: 0 1rem 2.4rem rgba(98, 80, 50, 0.08);
}

.provisioning-panel {
  display: grid;
  position: relative;
  z-index: 1;
  grid-template-columns: minmax(0, 1fr);
  gap: 0.95rem;
  align-items: start;
  padding: 1.15rem 1.25rem;
}

.provisioning-copy h1 {
  margin: 0.42rem 0 0;
  color: #263326;
  font-size: clamp(1.75rem, 5vw, 3rem);
  line-height: 1.12;
  font-weight: 850;
}

.provisioning-copy p:last-child {
  max-width: 25rem;
  margin: 0.62rem 0 0;
  color: #6f675c;
  font-size: 0.96rem;
  line-height: 1.55;
}

.provisioning-form {
  display: grid;
  gap: 0.72rem;
  margin-top: 0;
}

.provisioning-form label {
  display: grid;
  gap: 0.42rem;
  color: #4d463c;
  font-weight: 700;
}

.provisioning-form input {
  min-height: 3.25rem;
  border: 1px solid rgba(126, 112, 82, 0.3);
  border-radius: 0.42rem;
  background: rgba(255, 255, 255, 0.78);
  padding: 0 1rem;
  color: #2f2a23;
  font-size: 1.05rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  outline: none;
}

.provisioning-form input:focus {
  border-color: rgba(93, 112, 80, 0.66);
}

.provisioning-form button {
  border: 1px solid rgba(93, 112, 80, 0.42);
  border-radius: 0.42rem;
  background: #6f835f;
  color: #fffdf7;
  font-weight: 800;
}

.provisioning-form button:disabled {
  background: rgba(111, 131, 95, 0.36);
  color: rgba(63, 59, 52, 0.54);
}

.provisioning-status {
  grid-column: 1 / -1;
  margin: 0;
  border: 1px solid rgba(99, 119, 85, 0.2);
  border-radius: 0.42rem;
  background: rgba(242, 247, 236, 0.88);
  padding: 0.85rem 1rem;
  color: #4f6845;
  font-weight: 700;
}

.provisioning-status.pending {
  border-color: rgba(181, 126, 34, 0.24);
  background: rgba(255, 246, 220, 0.82);
  color: #70501d;
}

.provisioning-status.failure {
  border-color: rgba(174, 74, 70, 0.28);
  background: rgba(255, 239, 235, 0.9);
  color: #7b3430;
}

.provisioning-diagnostics {
  display: grid;
  position: relative;
  z-index: 0;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
  padding: 1rem 1.1rem;
}

.provisioning-diagnostics h3 {
  margin: 0.32rem 0 0;
  color: #263326;
  font-size: 1.35rem;
  font-weight: 800;
}

.provisioning-diagnostics dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: hidden;
  margin: 0;
  border: 1px solid rgba(126, 112, 82, 0.22);
  border-radius: 0.48rem;
  background: rgba(255, 253, 247, 0.66);
}

.provisioning-diagnostics dl > div {
  display: grid;
  gap: 0.3rem;
  align-items: start;
  min-height: 0;
  border-right: 1px solid rgba(126, 112, 82, 0.16);
  padding: 0.66rem 0.85rem;
}

.provisioning-diagnostics dl > div:last-child {
  border-right: 0;
}

.provisioning-diagnostics dt {
  color: #4b453a;
  font-weight: 700;
}

.provisioning-diagnostics dd {
  margin: 0;
  color: #70501d;
  font-weight: 800;
}

.provisioning-diagnostics dd.configured {
  color: #4f6845;
}

.provisioning-loading {
  grid-column: 1 / -1;
  margin: 0;
  color: #766f63;
  font-size: 0.82rem;
}

.provisioning-slogan {
  position: absolute;
  right: 2.2rem;
  bottom: 1.4rem;
  width: min(21rem, 54%);
  opacity: 0.34;
}

@media (max-width: 760px) {
  .provisioning-page {
    padding: 1.5rem 1.45rem 2rem;
  }

  .provisioning-header,
  .provisioning-main,
  .provisioning-panel,
  .provisioning-diagnostics,
  .provisioning-diagnostics dl {
    grid-template-columns: 1fr;
  }

  .provisioning-diagnostics dl > div {
    border-right: 0;
    border-bottom: 1px solid rgba(126, 112, 82, 0.16);
  }

  .provisioning-diagnostics dl > div:last-child {
    border-bottom: 0;
  }

  .provisioning-title-block {
    text-align: left;
  }
}
</style>
