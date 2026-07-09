<script setup lang="ts">
import { computed, ref, watch } from "vue";

import {
  listPaymentProviderConfigs,
  listPaymentProviderNotifyUrlChecks,
  upsertPaymentProviderConfig,
  type PaymentProviderConfig,
  type PaymentProviderNotifyUrlCheck,
} from "@/api/payments";
import { formatDateTime } from "@/utils/format";

import {
  buildProviderConfigPayload,
  createDefaultProviderConfigForm,
  type RealPaymentProviderCode,
} from "./payment-config-model";

const props = defineProps<{
  open: boolean;
  providerCode: RealPaymentProviderCode | null;
  providerName: string;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
  saved: [];
}>();

const loading = ref(false);
const saving = ref(false);
const configs = ref<PaymentProviderConfig[]>([]);
const notifyChecks = ref<PaymentProviderNotifyUrlCheck[]>([]);
const form = ref(createDefaultProviderConfigForm("alipay"));

const drawerTitle = computed(() =>
  props.providerName ? `${props.providerName}配置` : "支付机构配置",
);

const selectedNotifyCheck = computed(() =>
  notifyChecks.value.find(
    (item) => item.providerCode === form.value.providerCode,
  ),
);

const configEnabled = computed({
  get: () => form.value.status === "enabled",
  set: (enabled: boolean) => {
    form.value.status = enabled ? "enabled" : "disabled";
  },
});

watch(
  () => props.open,
  (open) => {
    if (open) void loadDrawer();
  },
);

async function loadDrawer(): Promise<void> {
  if (!props.providerCode) return;
  loading.value = true;
  try {
    form.value = createDefaultProviderConfigForm(props.providerCode);
    const [configRows, checks] = await Promise.all([
      listPaymentProviderConfigs(),
      listPaymentProviderNotifyUrlChecks(),
    ]);
    configs.value = configRows;
    notifyChecks.value = checks;
    applyConfig(
      configRows.find(
        (config) =>
          config.providerCode === props.providerCode &&
          config.machineId === null,
      ) ?? null,
    );
  } finally {
    loading.value = false;
  }
}

function closeDrawer(): void {
  emit("update:open", false);
}

function applyConfig(config: PaymentProviderConfig | null): void {
  const providerCode = props.providerCode;
  if (!providerCode) return;
  if (!config) {
    form.value = {
      ...createDefaultProviderConfigForm(providerCode),
      machineId: null,
    };
    return;
  }

  const publicConfig = config.publicConfigJson;
  form.value = {
    ...createDefaultProviderConfigForm(providerCode),
    providerCode,
    machineId: null,
    status: config.status === "disabled" ? "disabled" : "enabled",
    merchantNo: config.merchantNo ?? "",
    appId: config.appId ?? "",
    qrExpiresMinutes:
      typeof publicConfig["qrExpiresMinutes"] === "number"
        ? publicConfig["qrExpiresMinutes"]
        : 15,
    timeoutCompensationSeconds:
      typeof publicConfig["timeoutCompensationSeconds"] === "number"
        ? publicConfig["timeoutCompensationSeconds"]
        : 120,
    certificateSerialNo:
      typeof publicConfig["certificateSerialNo"] === "string"
        ? publicConfig["certificateSerialNo"]
        : "",
    merchantCertificateSerialNo:
      typeof publicConfig["merchantCertificateSerialNo"] === "string"
        ? publicConfig["merchantCertificateSerialNo"]
        : typeof publicConfig["certificateSerialNo"] === "string"
          ? publicConfig["certificateSerialNo"]
          : "",
    platformCertificateSerialNo:
      typeof publicConfig["platformCertificateSerialNo"] === "string"
        ? publicConfig["platformCertificateSerialNo"]
        : "",
    platformCertificatePem: "",
    gatewayUrl:
      typeof publicConfig["gatewayUrl"] === "string"
        ? publicConfig["gatewayUrl"]
        : createDefaultProviderConfigForm(providerCode).gatewayUrl,
    keyType: publicConfig["keyType"] === "PKCS1" ? "PKCS1" : "PKCS8",
    mode:
      publicConfig["mode"] === "production"
        ? "production"
        : publicConfig["mode"] === "direct_merchant"
          ? "direct_merchant"
          : "sandbox",
    storeId:
      typeof publicConfig["storeId"] === "string"
        ? publicConfig["storeId"]
        : "",
    terminalId:
      typeof publicConfig["terminalId"] === "string"
        ? publicConfig["terminalId"]
        : "",
    apiV3Key: "",
    apiV2Key: "",
    privateKeyPem: "",
    platformPublicKeyPem: "",
    merchantApiCertPem: "",
    merchantApiKeyPem: "",
    appCertPem: "",
    alipayPublicCertPem: "",
    alipayRootCertPem: "",
  };
}

async function saveConfig(): Promise<void> {
  saving.value = true;
  try {
    await upsertPaymentProviderConfig(buildProviderConfigPayload(form.value));
    emit("saved");
    closeDrawer();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="drawerTitle"
    width="760"
    destroy-on-close
    @close="closeDrawer"
  >
    <a-spin :spinning="loading">
      <div class="mb-4 flex items-center justify-between gap-3">
        <a-space>
          <a-tag color="blue">全局配置</a-tag>
          <span class="text-sm text-slate-500">
            当前支付机构默认使用此配置
          </span>
        </a-space>
        <a-space>
          <span class="text-sm text-slate-600">
            {{ configEnabled ? "启用" : "禁用" }}
          </span>
          <a-switch v-model:checked="configEnabled" />
        </a-space>
      </div>

      <a-alert
        v-if="selectedNotifyCheck"
        :type="selectedNotifyCheck.reachable ? 'success' : 'warning'"
        show-icon
        style="margin-bottom: 16px"
      >
        <template #message>
          回调地址：{{ selectedNotifyCheck.notifyUrl }}
        </template>
        <template #description>
          <a-space wrap>
            <a-tag
              :color="selectedNotifyCheck.usesHttps ? 'success' : 'warning'"
            >
              {{ selectedNotifyCheck.usesHttps ? "HTTPS" : "非 HTTPS" }}
            </a-tag>
            <a-tag
              :color="
                selectedNotifyCheck.pathMatchesWebhookRoute
                  ? 'success'
                  : 'error'
              "
            >
              {{
                selectedNotifyCheck.pathMatchesWebhookRoute
                  ? "路径匹配"
                  : "路径不匹配"
              }}
            </a-tag>
            <a-tag :color="selectedNotifyCheck.reachable ? 'success' : 'error'">
              {{
                selectedNotifyCheck.reachable ? "回调可访问" : "回调不可访问"
              }}
            </a-tag>
            <span>
              检查时间：{{ formatDateTime(selectedNotifyCheck.checkedAt) }}
            </span>
          </a-space>
        </template>
      </a-alert>

      <a-form layout="vertical" @finish="saveConfig">
        <a-row :gutter="16">
          <a-col :span="8">
            <a-form-item label="商户号">
              <a-input v-model:value="form.merchantNo" placeholder="请输入" />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item label="App ID">
              <a-input v-model:value="form.appId" placeholder="请输入" />
            </a-form-item>
          </a-col>
          <a-col :span="4">
            <a-form-item label="二维码有效期">
              <a-input-number
                v-model:value="form.qrExpiresMinutes"
                :min="1"
                :max="60"
              />
            </a-form-item>
          </a-col>
          <a-col :span="4">
            <a-form-item label="补偿窗口">
              <a-input-number
                v-model:value="form.timeoutCompensationSeconds"
                :min="0"
                :max="600"
              />
            </a-form-item>
          </a-col>
        </a-row>

        <template v-if="form.providerCode === 'wechat_pay'">
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item label="商户 API 证书序列号">
                <a-input
                  v-model:value="form.merchantCertificateSerialNo"
                  placeholder="请输入"
                />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="微信支付平台证书序列号">
                <a-input
                  v-model:value="form.platformCertificateSerialNo"
                  placeholder="请输入"
                />
              </a-form-item>
            </a-col>
          </a-row>
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item label="APIv3Key">
                <a-input-password
                  v-model:value="form.apiV3Key"
                  placeholder="留空则保留现有配置"
                />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="APIv2Key">
                <a-input-password
                  v-model:value="form.apiV2Key"
                  placeholder="留空则保留现有配置"
                />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="应用私钥 PEM">
            <a-textarea
              v-model:value="form.privateKeyPem"
              :rows="4"
              placeholder="留空则保留现有配置"
            />
          </a-form-item>
          <a-form-item label="微信支付平台证书 PEM">
            <a-textarea
              v-model:value="form.platformCertificatePem"
              :rows="4"
              placeholder="留空则保留现有配置"
            />
          </a-form-item>
          <a-form-item label="微信支付平台公钥 PEM">
            <a-textarea
              v-model:value="form.platformPublicKeyPem"
              :rows="4"
              placeholder="仅在没有平台证书 PEM 时填写"
            />
          </a-form-item>
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item label="商户 API 证书 PEM">
                <a-textarea
                  v-model:value="form.merchantApiCertPem"
                  :rows="4"
                  placeholder="留空则保留现有配置"
                />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="商户 API 私钥 PEM">
                <a-textarea
                  v-model:value="form.merchantApiKeyPem"
                  :rows="4"
                  placeholder="留空则保留现有配置"
                />
              </a-form-item>
            </a-col>
          </a-row>
        </template>

        <template v-else>
          <a-row :gutter="16">
            <a-col :span="10">
              <a-form-item label="模式">
                <a-select v-model:value="form.mode">
                  <a-select-option value="sandbox">沙箱</a-select-option>
                  <a-select-option value="production">生产</a-select-option>
                </a-select>
              </a-form-item>
            </a-col>
            <a-col :span="10">
              <a-form-item label="网关 URL">
                <a-input v-model:value="form.gatewayUrl" placeholder="请输入" />
              </a-form-item>
            </a-col>
            <a-col :span="4">
              <a-form-item label="密钥类型">
                <a-select v-model:value="form.keyType">
                  <a-select-option value="PKCS8">PKCS8</a-select-option>
                  <a-select-option value="PKCS1">PKCS1</a-select-option>
                </a-select>
              </a-form-item>
            </a-col>
          </a-row>
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item label="门店号">
                <a-input v-model:value="form.storeId" placeholder="选填" />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="终端号">
                <a-input v-model:value="form.terminalId" placeholder="选填" />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="应用私钥 PEM">
            <a-textarea
              v-model:value="form.privateKeyPem"
              :rows="4"
              placeholder="留空则保留现有配置"
            />
          </a-form-item>
          <a-row :gutter="16">
            <a-col :span="12">
              <a-form-item label="应用公钥证书">
                <a-textarea
                  v-model:value="form.appCertPem"
                  :rows="4"
                  placeholder="留空则保留现有配置"
                />
              </a-form-item>
            </a-col>
            <a-col :span="12">
              <a-form-item label="支付宝公钥证书">
                <a-textarea
                  v-model:value="form.alipayPublicCertPem"
                  :rows="4"
                  placeholder="留空则保留现有配置"
                />
              </a-form-item>
            </a-col>
          </a-row>
          <a-form-item label="支付宝根证书">
            <a-textarea
              v-model:value="form.alipayRootCertPem"
              :rows="4"
              placeholder="留空则保留现有配置"
            />
          </a-form-item>
        </template>

        <a-form-item>
          <a-space>
            <a-button type="primary" html-type="submit" :loading="saving">
              保存
            </a-button>
            <a-button @click="closeDrawer">取消</a-button>
          </a-space>
        </a-form-item>
      </a-form>
    </a-spin>
  </a-drawer>
</template>
