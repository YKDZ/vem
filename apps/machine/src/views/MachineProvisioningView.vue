<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import { daemonClient } from "@/daemon/client";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useMachineStore } from "@/stores/machine";

const machineStore = useMachineStore();
const router = useRouter();

const form = reactive({
  claimCode: "",
});
const loadingConfig = ref(false);
const submitting = ref(false);
const statusMessage = ref<string | null>(null);
const statusKind = ref<"idle" | "pending" | "success" | "failure">("idle");

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

  if (code.includes("invalid")) return "领取码无效，请核对后重试";
  if (code.includes("expired")) return "领取码已过期，请联系管理员重新生成";
  if (code.includes("used") || code.includes("consumed")) {
    return "领取码已使用，请联系管理员确认机器状态";
  }
  if (code.includes("revoked")) return "领取码已撤销，请联系管理员重新生成";
  if (code.includes("locked")) return "领取码已锁定，请联系管理员处理";
  if (
    (error instanceof Error && error.name === "DaemonUnavailableError") ||
    code.includes("network") ||
    code.includes("unavailable")
  ) {
    return "网络不可用，请检查连接后重试";
  }
  return "领取失败，请联系维护人员重试";
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
    statusKind.value = "success";
    statusMessage.value = "领取成功，正在进入启动流程";
    form.claimCode = "";
    await machineStore.loadConfig().catch(() => undefined);
    await router.replace("/boot");
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
    <section
      class="mx-auto flex h-full max-w-3xl flex-col justify-center text-white"
    >
      <div class="rounded-4xl border border-white/10 bg-white/10 p-7 shadow-2xl">
        <p class="text-sm tracking-[0.35em] text-emerald-200 uppercase">
          PROVISIONING
        </p>
        <h2 class="mt-3 text-3xl font-bold">机器领取</h2>

        <form class="mt-7 grid gap-5" @submit.prevent="submitClaim">
          <label class="grid gap-2 text-left">
            <span class="text-sm font-semibold text-slate-200">
              Machine Claim Code
            </span>
            <input
              v-model="form.claimCode"
              autocomplete="one-time-code"
              class="kiosk-touch-target rounded-2xl border border-white/10 bg-slate-950/70 px-4 text-lg font-semibold tracking-[0.12em] text-white uppercase outline-none focus:border-emerald-300"
              inputmode="text"
              placeholder="ABCD-2345"
            />
          </label>

          <button
            class="kiosk-touch-target rounded-2xl bg-emerald-400 px-5 font-bold text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-500"
            :disabled="submitting || !form.claimCode.trim()"
            type="submit"
          >
            {{ submitting ? "正在领取" : "提交领取码" }}
          </button>
        </form>

        <p
          v-if="statusMessage"
          :class="{
            'text-emerald-200': statusKind === 'success',
            'text-amber-200': statusKind === 'pending',
            'text-rose-200': statusKind === 'failure',
          }"
          class="mt-4 rounded-2xl bg-slate-950/40 px-4 py-3 font-semibold"
        >
          {{ statusMessage }}
        </p>

        <div
          class="mt-7 rounded-3xl border border-white/10 bg-slate-950/30 p-5"
        >
          <p class="text-sm font-semibold text-slate-200">安全诊断</p>
          <dl class="mt-3 grid gap-3">
            <div
              v-for="item in diagnostics"
              :key="item.label"
              class="flex items-center justify-between gap-4 rounded-2xl bg-slate-950/40 px-4 py-3"
            >
              <dt class="text-slate-300">{{ item.label }}</dt>
              <dd
                :class="
                  item.configured ? 'text-emerald-200' : 'text-amber-200'
                "
                class="font-semibold"
              >
                {{ item.configured ? "已配置" : "未配置" }}
              </dd>
            </div>
          </dl>
          <p v-if="loadingConfig" class="mt-3 text-sm text-slate-400">
            正在读取 daemon 配置状态
          </p>
        </div>
      </div>
    </section>
  </KioskLayout>
</template>
