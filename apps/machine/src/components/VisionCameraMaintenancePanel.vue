<script setup lang="ts">
import type {
  VisionCameraMaintenanceContract,
  VisionCameraMaintenanceRole,
  VisionCameraMaintenanceTestResponse,
} from "@vem/shared";

import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

import { daemonClient } from "@/daemon/client";

const loading = ref(false);
const contract = ref<VisionCameraMaintenanceContract | null>(null);
const message = ref<string | null>(null);
const technicalEvidence = ref<string | null>(null);
const previewUrls = reactive<Record<string, string>>({});
const previewLoading = reactive<Record<string, boolean>>({});
const tested = reactive<
  Partial<
    Record<VisionCameraMaintenanceRole, VisionCameraMaintenanceTestResponse>
  >
>({});
let refreshTimer: number | null = null;

const roleRows = computed<
  Array<VisionCameraMaintenanceContract["roles"]["top"]>
>(() => {
  if (!contract.value) return [];
  return [contract.value.roles.top, contract.value.roles.front];
});

function roleLabel(role: VisionCameraMaintenanceRole): string {
  return role === "top" ? "顶部来人摄像头" : "正面画像/试衣摄像头";
}

function roleStatusLabel(
  roleStatus: VisionCameraMaintenanceContract["roles"]["top"],
): string {
  if (roleStatus.state === "ready") return "已确认";
  if (roleStatus.state === "missing") return "缺失硬件";
  if (roleStatus.state === "ambiguous") return "待重新确认";
  return "未确认";
}

function roleReasonLabel(reason?: string): string {
  switch (reason) {
    case "camera_not_confirmed":
      return "尚未完成现场确认。";
    case "bound_camera_missing":
      return "已确认摄像头当前未连接；这会阻塞视觉硬件验收，但不是软件安装失败。";
    case "bound_camera_unavailable":
      return "已确认摄像头当前不可用；请检查供电、占用或驱动。";
    case "stable_identity_is_not_unique":
      return "同一稳定身份出现重复观察，请先排除重复设备。";
    case "stable_identity_bound_to_multiple_roles":
      return "同一候选已被另一角色占用，请重新确认角色。";
    case "camera_mapping_unproven":
      return "Vision 尚未证明当前后端映射，请刷新或重新插拔后重试。";
    default:
      return "等待 Vision 返回可确认状态。";
  }
}

function clearPreviewUrls(): void {
  for (const value of Object.values(previewUrls)) {
    URL.revokeObjectURL(value);
  }
  for (const key of Object.keys(previewUrls)) {
    delete previewUrls[key];
  }
}

async function refreshContract(force = false): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  if (force) {
    message.value = null;
    technicalEvidence.value = null;
  }
  try {
    contract.value = force
      ? await daemonClient.refreshVisionCameraMaintenanceContract()
      : await daemonClient.getVisionCameraMaintenanceContract();
    if (message.value === "读取视觉摄像头维护状态失败") {
      message.value = null;
      technicalEvidence.value = null;
    }
  } catch (error) {
    message.value = "读取视觉摄像头维护状态失败";
    technicalEvidence.value =
      error instanceof Error ? error.message : String(error);
  } finally {
    loading.value = false;
  }
}

async function loadPreview(candidateId: string): Promise<void> {
  if (previewLoading[candidateId]) return;
  previewLoading[candidateId] = true;
  message.value = null;
  technicalEvidence.value = null;
  try {
    const blob =
      await daemonClient.getVisionCameraMaintenancePreviewBlob(candidateId);
    if (previewUrls[candidateId]) {
      URL.revokeObjectURL(previewUrls[candidateId]);
    }
    previewUrls[candidateId] = URL.createObjectURL(blob);
  } catch (error) {
    message.value = "读取本地预览失败";
    technicalEvidence.value =
      error instanceof Error ? error.message : String(error);
  } finally {
    previewLoading[candidateId] = false;
  }
}

async function testRole(
  role: VisionCameraMaintenanceRole,
  candidateId: string,
): Promise<void> {
  message.value = null;
  technicalEvidence.value = null;
  try {
    tested[role] = await daemonClient.testVisionCameraRole(role, {
      candidateId,
    });
    message.value = `${roleLabel(role)}测试通过，请在画面正确时确认绑定。`;
    await refreshContract();
  } catch (error) {
    message.value = "视觉摄像头测试失败";
    technicalEvidence.value =
      error instanceof Error ? error.message : String(error);
  }
}

async function confirmRole(
  role: VisionCameraMaintenanceRole,
  candidateId: string,
): Promise<void> {
  const evidence = tested[role];
  if (!evidence) return;
  message.value = null;
  technicalEvidence.value = null;
  try {
    await daemonClient.confirmVisionCameraRole(role, {
      candidateId,
      testEvidenceId: evidence.evidence.id,
      operatorVisualConfirmation: true,
      expectedGeneration: evidence.generation,
    });
    delete tested[role];
    message.value = `${roleLabel(role)}已确认绑定；如摄像头重插，请直接刷新确认最新状态。`;
    await refreshContract();
  } catch (error) {
    message.value = "视觉摄像头确认失败";
    technicalEvidence.value =
      error instanceof Error ? error.message : String(error);
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshTimer = window.setInterval(() => {
    void refreshContract();
  }, 5000);
}

onMounted(() => {
  void refreshContract();
  scheduleRefresh();
});

onUnmounted(() => {
  if (refreshTimer !== null) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  clearPreviewUrls();
});
</script>

<template>
  <section
    class="mt-4 rounded-3xl border border-fuchsia-200/20 bg-slate-950/30 p-4 text-left"
    data-test="vision-camera-maintenance"
  >
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="font-semibold text-white">视觉摄像头角色验收</p>
        <p class="mt-1 text-sm text-slate-300">
          Vision 自主维护候选、角色就绪、预览、测试与确认。VEM 只渲染 v2
          契约，不保存摄像头身份。
        </p>
      </div>
      <button
        class="kiosk-touch-target rounded-2xl border border-fuchsia-200/30 px-4 py-3 font-bold text-fuchsia-100 disabled:opacity-40"
        type="button"
        :disabled="loading"
        @click="refreshContract(true)"
      >
        刷新视觉角色
      </button>
    </div>

    <template v-if="contract">
      <p class="mt-3 text-xs text-slate-400">
        合同版本 {{ contract.contractVersion }} · generation
        {{ contract.generation }}
      </p>

      <div class="mt-4 grid gap-3">
        <article
          v-for="roleStatus in roleRows"
          :key="roleStatus.role"
          class="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
          :data-test="`vision-role-${roleStatus.role}`"
        >
          <div class="flex items-center justify-between gap-3">
            <p class="font-semibold text-white">
              {{ roleLabel(roleStatus.role) }}
            </p>
            <span
              :class="roleStatus.ready ? 'text-emerald-200' : 'text-amber-200'"
            >
              {{ roleStatusLabel(roleStatus) }}
            </span>
          </div>
          <p class="mt-2 text-sm text-slate-300">
            {{
              roleReasonLabel(
                "reason" in roleStatus ? roleStatus.reason : undefined,
              )
            }}
          </p>
          <p
            v-if="'candidateId' in roleStatus"
            class="mt-2 text-xs text-slate-400"
          >
            Vision candidate：{{ roleStatus.candidateId }}
          </p>
        </article>
      </div>

      <div class="mt-4 grid gap-3">
        <article
          v-for="candidate in contract.candidates"
          :key="candidate.id"
          class="rounded-2xl border border-white/10 bg-slate-950/35 p-4"
          :data-test="`vision-candidate-${candidate.id}`"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="font-semibold text-slate-100">{{ candidate.label }}</p>
              <p class="mt-1 text-xs text-slate-400">
                {{ candidate.id }} · {{ candidate.backendObservation.backend }}
                · index
                {{ candidate.backendObservation.index ?? "未解析" }}
              </p>
            </div>
            <button
              class="kiosk-touch-target rounded-xl border border-fuchsia-200/30 px-3 py-2 font-bold text-fuchsia-100 disabled:opacity-40"
              type="button"
              :disabled="previewLoading[candidate.id]"
              @click="loadPreview(candidate.id)"
            >
              {{ previewLoading[candidate.id] ? "读取中" : "查看预览" }}
            </button>
          </div>

          <img
            v-if="previewUrls[candidate.id]"
            :src="previewUrls[candidate.id]"
            alt="vision camera preview"
            class="mt-3 max-h-56 rounded-2xl border border-white/10 object-contain"
            :data-test="`vision-preview-${candidate.id}`"
          />

          <div class="mt-3 flex flex-wrap gap-2">
            <button
              class="kiosk-touch-target rounded-xl border border-sky-200/30 px-3 py-2 font-bold text-sky-100 disabled:opacity-40"
              type="button"
              @click="testRole('top', candidate.id)"
            >
              测试顶部角色
            </button>
            <button
              class="kiosk-touch-target rounded-xl bg-emerald-300 px-3 py-2 font-bold text-slate-950 disabled:opacity-40"
              type="button"
              :disabled="tested.top?.candidateId !== candidate.id"
              @click="confirmRole('top', candidate.id)"
            >
              确认顶部角色
            </button>
            <button
              class="kiosk-touch-target rounded-xl border border-sky-200/30 px-3 py-2 font-bold text-sky-100 disabled:opacity-40"
              type="button"
              @click="testRole('front', candidate.id)"
            >
              测试正面角色
            </button>
            <button
              class="kiosk-touch-target rounded-xl bg-emerald-300 px-3 py-2 font-bold text-slate-950 disabled:opacity-40"
              type="button"
              :disabled="tested.front?.candidateId !== candidate.id"
              @click="confirmRole('front', candidate.id)"
            >
              确认正面角色
            </button>
          </div>
        </article>
      </div>
    </template>

    <p
      v-if="message"
      class="mt-3 border border-rose-300/30 bg-rose-500/15 p-3 text-rose-100"
    >
      <span data-test="vision-camera-maintenance-message">{{ message }}</span>
      <details v-if="technicalEvidence" class="mt-2 text-sm">
        <summary>技术证据</summary>
        <pre class="mt-2 whitespace-pre-wrap">{{ technicalEvidence }}</pre>
      </details>
    </p>
  </section>
</template>
