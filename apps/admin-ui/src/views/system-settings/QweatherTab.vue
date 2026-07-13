<script setup lang="ts">
import type { QweatherConfigResponse } from "@vem/shared";

import { message } from "antdv-next";
import { onMounted, reactive, ref } from "vue";

import { getQweatherConfig, updateQweatherConfig } from "@/api/qweather";
import { useAuthStore } from "@/stores/auth";

const authStore = useAuthStore();
const loading = ref(false);
const saving = ref(false);
const current = ref<QweatherConfigResponse | null>(null);
const form = reactive({
  enabled: true,
  apiHost: "",
  jwtKeyId: "",
  jwtProjectId: "",
  privateKey: "",
  weatherNowPath: "/v7/weather/now",
  sunPath: "/v7/astronomy/sun",
  timeoutMs: 3000,
});

const canWrite = authStore.hasPermission("machines.write");

function applyConfig(config: QweatherConfigResponse): void {
  current.value = config;
  form.enabled = config.enabled;
  form.apiHost = config.apiHost;
  form.jwtKeyId = config.jwtKeyId;
  form.jwtProjectId = config.jwtProjectId;
  form.privateKey = "";
  form.weatherNowPath = config.weatherNowPath;
  form.sunPath = config.sunPath;
  form.timeoutMs = config.timeoutMs;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    applyConfig(await getQweatherConfig());
  } catch (error) {
    message.error(
      error instanceof Error ? error.message : "读取和风天气配置失败",
    );
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const config = await updateQweatherConfig({
      enabled: form.enabled,
      apiHost: form.apiHost.trim(),
      jwtKeyId: form.jwtKeyId.trim(),
      jwtProjectId: form.jwtProjectId.trim(),
      privateKey: form.privateKey.trim() || undefined,
      weatherNowPath: form.weatherNowPath.trim(),
      sunPath: form.sunPath.trim(),
      timeoutMs: form.timeoutMs,
    });
    applyConfig(config);
    message.success("和风天气配置已保存并立即生效");
  } catch (error) {
    message.error(
      error instanceof Error ? error.message : "保存和风天气配置失败",
    );
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <a-spin :spinning="loading">
    <section aria-label="和风天气配置">
      <a-descriptions v-if="current" class="mb-4" bordered size="small">
        <a-descriptions-item label="配置来源">
          {{
            current.source === "database"
              ? "管理后台"
              : current.source === "environment"
                ? "部署环境"
                : "未配置"
          }}
        </a-descriptions-item>
        <a-descriptions-item label="私钥状态">
          <a-tag :color="current.privateKeyConfigured ? 'success' : 'error'">
            {{ current.privateKeyConfigured ? "已配置" : "未配置" }}
          </a-tag>
        </a-descriptions-item>
        <a-descriptions-item label="更新时间">
          {{ current.updatedAt ?? "由部署环境提供" }}
        </a-descriptions-item>
      </a-descriptions>

      <a-form layout="vertical" style="max-width: 760px" @finish="save">
        <a-form-item label="启用和风天气">
          <a-switch v-model:checked="form.enabled" :disabled="!canWrite" />
        </a-form-item>
        <a-form-item label="API Host" required>
          <a-input
            v-model:value="form.apiHost"
            placeholder="例如 abcxyz.qweatherapi.com"
            :disabled="!canWrite"
          />
        </a-form-item>
        <a-form-item label="JWT 凭据 ID" required>
          <a-input v-model:value="form.jwtKeyId" :disabled="!canWrite" />
        </a-form-item>
        <a-form-item label="项目 ID" required>
          <a-input v-model:value="form.jwtProjectId" :disabled="!canWrite" />
        </a-form-item>
        <a-form-item label="Ed25519 私钥">
          <a-textarea
            v-model:value="form.privateKey"
            :rows="6"
            :placeholder="
              current?.privateKeyConfigured
                ? '已配置；留空保留现有私钥'
                : '粘贴 PEM 格式私钥'
            "
            :disabled="!canWrite"
          />
        </a-form-item>
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="实时天气路径" required>
              <a-input
                v-model:value="form.weatherNowPath"
                :disabled="!canWrite"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="日出日落路径" required>
              <a-input v-model:value="form.sunPath" :disabled="!canWrite" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-form-item label="请求超时（毫秒）" required>
          <a-input-number
            v-model:value="form.timeoutMs"
            :min="500"
            :max="30000"
            :disabled="!canWrite"
          />
        </a-form-item>
        <a-button
          v-if="canWrite"
          type="primary"
          html-type="submit"
          :loading="saving"
        >
          保存配置
        </a-button>
      </a-form>
    </section>
  </a-spin>
</template>
