<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { listMachines, type Machine } from "@/api/machines";
import {
  listPaymentProviderConfigs,
  listPaymentProviderNotifyUrlChecks,
  upsertPaymentProviderConfig,
  type PaymentProviderConfig,
  type PaymentProviderNotifyUrlCheck,
  type PaymentSecretStatus,
} from "@/api/payments";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

import {
  buildProviderConfigPayload,
  createDefaultProviderConfigForm,
  type RealPaymentProviderCode,
} from "./payment-config-model";

const authStore = useAuthStore();
const canConfigure = authStore.hasPermission("payments.configure");

const configsLoading = ref(false);
const configs = ref<PaymentProviderConfig[]>([]);
const machines = ref<Machine[]>([]);
const notifyChecks = ref<PaymentProviderNotifyUrlCheck[]>([]);
const saving = ref(false);
const form = ref(createDefaultProviderConfigForm("alipay"));

const selectedNotifyCheck = computed(() =>
  notifyChecks.value.find(
    (item) => item.providerCode === form.value.providerCode,
  ),
);

watch(
  () => form.value.providerCode,
  (providerCode) => {
    form.value = {
      ...createDefaultProviderConfigForm(providerCode),
      providerCode,
      machineId: form.value.machineId,
      status: form.value.status,
    };
  },
);

async function loadAll(): Promise<void> {
  configsLoading.value = true;
  try {
    const [configRows, machineRows, checks] = await Promise.all([
      listPaymentProviderConfigs(),
      listMachines({ page: 1, pageSize: 100 }),
      listPaymentProviderNotifyUrlChecks(),
    ]);
    configs.value = configRows;
    machines.value = machineRows.items;
    notifyChecks.value = checks;
  } finally {
    configsLoading.value = false;
  }
}

function editConfig(config: PaymentProviderConfig): void {
  if (
    config.providerCode !== "wechat_pay" &&
    config.providerCode !== "alipay"
  ) {
    return;
  }
  const publicConfig = config.publicConfigJson;
  const providerCode = config.providerCode as RealPaymentProviderCode;
  form.value = {
    ...createDefaultProviderConfigForm(providerCode),
    providerCode,
    machineId: config.machineId,
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
    form.value = createDefaultProviderConfigForm(form.value.providerCode);
    await loadAll();
  } finally {
    saving.value = false;
  }
}

function getMachineName(machineId: string | null): string {
  if (!machineId) return "全局";
  const m = machines.value.find((x) => x.id === machineId);
  return m ? `${m.code} - ${m.name}` : machineId;
}

const configColumns = [
  { title: "支付提供商", dataIndex: "providerCode", key: "providerCode" },
  { title: "名称", dataIndex: "providerName", key: "providerName" },
  { title: "范围", key: "machineId" },
  { title: "商户号", dataIndex: "merchantNo", key: "merchantNo" },
  { title: "App ID", dataIndex: "appId", key: "appId" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "回调地址", key: "derivedNotifyUrl" },
  { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt" },
  { title: "密钥/证书状态", key: "secretStatusJson" },
  { title: "操作", key: "actions" },
];

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <div>
    <a-table
      :columns="configColumns"
      :data-source="configs"
      row-key="id"
      :loading="configsLoading"
      :pagination="false"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'machineId'">
          {{ getMachineName(record.machineId) }}
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tag :color="record.status === 'enabled' ? 'success' : 'default'">
            {{ record.status === "enabled" ? "启用" : "禁用" }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'derivedNotifyUrl'">
          <a-typography-text
            :ellipsis="{ tooltip: record.derivedNotifyUrl }"
            style="max-width: 220px"
          >
            {{ record.derivedNotifyUrl ?? "-" }}
          </a-typography-text>
        </template>
        <template v-else-if="column.key === 'updatedAt'">
          {{ formatDateTime(record.updatedAt) }}
        </template>
        <template v-else-if="column.key === 'secretStatusJson'">
          <a-space direction="vertical" :size="2">
            <a-tag
              v-for="(val, key) in record.secretStatusJson as Record<
                string,
                PaymentSecretStatus
              >"
              :key="key"
              :color="val.configured ? 'success' : 'default'"
            >
              {{ key }}:
              {{ val.configured ? "已配置" : "未配置" }}
              <span v-if="val.fingerprintSha256">
                / SHA256 {{ val.fingerprintSha256.slice(0, 12) }}
              </span>
              <span v-if="val.certificateExpiresAt">
                / 到期 {{ formatDateTime(val.certificateExpiresAt) }}
              </span>
              <span v-if="val.errorCode"> / {{ val.errorCode }}</span>
            </a-tag>
            <span v-if="Object.keys(record.secretStatusJson).length === 0">
              无密钥
            </span>
          </a-space>
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-button
            v-if="
              canConfigure &&
              (record.providerCode === 'wechat_pay' ||
                record.providerCode === 'alipay')
            "
            size="small"
            @click="editConfig(record)"
          >
            编辑
          </a-button>
        </template>
      </template>
    </a-table>

    <a-divider />

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
          <a-tag :color="selectedNotifyCheck.usesHttps ? 'success' : 'warning'">
            {{ selectedNotifyCheck.usesHttps ? "HTTPS" : "非 HTTPS" }}
          </a-tag>
          <a-tag
            :color="
              selectedNotifyCheck.pathMatchesWebhookRoute ? 'success' : 'error'
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
              selectedNotifyCheck.reachable
                ? `连通 ${selectedNotifyCheck.statusCode}`
                : `不可达 ${selectedNotifyCheck.errorCode ?? "未知"}`
            }}
          </a-tag>
          <span
            >检查时间：{{ formatDateTime(selectedNotifyCheck.checkedAt) }}</span
          >
        </a-space>
      </template>
    </a-alert>

    <a-form v-if="canConfigure" layout="vertical" @finish="saveConfig">
      <a-row :gutter="16">
        <a-col :span="6">
          <a-form-item label="支付提供商">
            <a-select v-model:value="form.providerCode" style="width: 180px">
              <a-select-option value="alipay">支付宝</a-select-option>
              <a-select-option value="wechat_pay">微信支付</a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="范围（留空为全局）">
            <a-select
              v-model:value="form.machineId"
              allow-clear
              placeholder="全局配置"
            >
              <a-select-option :value="null">全局配置</a-select-option>
              <a-select-option
                v-for="machine in machines"
                :key="machine.id"
                :value="machine.id"
              >
                {{ machine.code }} - {{ machine.name }}
              </a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="状态">
            <a-select v-model:value="form.status" style="width: 120px">
              <a-select-option value="enabled">启用</a-select-option>
              <a-select-option value="disabled">禁用</a-select-option>
            </a-select>
          </a-form-item>
        </a-col>
      </a-row>

      <a-row :gutter="16">
        <a-col :span="6">
          <a-form-item label="商户号">
            <a-input v-model:value="form.merchantNo" placeholder="请输入" />
          </a-form-item>
        </a-col>
        <a-col :span="6">
          <a-form-item label="App ID">
            <a-input v-model:value="form.appId" placeholder="请输入" />
          </a-form-item>
        </a-col>
        <a-col :span="4">
          <a-form-item label="二维码有效期（分钟）">
            <a-input-number
              v-model:value="form.qrExpiresMinutes"
              :min="1"
              :max="60"
            />
          </a-form-item>
        </a-col>
        <a-col :span="4">
          <a-form-item label="补偿窗口（秒）">
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
          <a-col :span="8">
            <a-form-item label="商户 API 证书序列号">
              <a-input
                v-model:value="form.merchantCertificateSerialNo"
                placeholder="请输入"
              />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item label="微信支付平台证书/公钥序列号">
              <a-input
                v-model:value="form.platformCertificateSerialNo"
                placeholder="请输入"
              />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="16">
          <a-col :span="8">
            <a-form-item label="APIv3Key（敏感）">
              <a-input-password
                v-model:value="form.apiV3Key"
                placeholder="留空则保留现有配置；填入新值会覆盖对应字段"
              />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item label="APIv2Key（敏感）">
              <a-input-password
                v-model:value="form.apiV2Key"
                placeholder="留空则保留现有配置"
              />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="应用私钥 PEM（敏感）">
              <a-textarea
                v-model:value="form.privateKeyPem"
                :rows="4"
                placeholder="留空则保留现有配置；填入新值会覆盖对应字段"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="微信支付平台证书 PEM（敏感）">
              <a-textarea
                v-model:value="form.platformCertificatePem"
                :rows="4"
                placeholder="推荐填写；留空则保留现有配置"
              />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="微信支付平台公钥 PEM（兼容）">
              <a-textarea
                v-model:value="form.platformPublicKeyPem"
                :rows="4"
                placeholder="仅在没有平台证书 PEM 时填写"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="商户 API 证书 PEM（敏感）">
              <a-textarea
                v-model:value="form.merchantApiCertPem"
                :rows="4"
                placeholder="留空则保留现有配置"
              />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="商户 API 私钥 PEM（敏感）">
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
          <a-col :span="8">
            <a-form-item label="模式">
              <a-select v-model:value="form.mode">
                <a-select-option value="sandbox">沙箱</a-select-option>
                <a-select-option value="production">生产</a-select-option>
              </a-select>
            </a-form-item>
          </a-col>
          <a-col :span="8">
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
          <a-col :span="8">
            <a-form-item label="门店号（storeId）">
              <a-input v-model:value="form.storeId" placeholder="选填" />
            </a-form-item>
          </a-col>
          <a-col :span="8">
            <a-form-item label="终端号（terminalId）">
              <a-input v-model:value="form.terminalId" placeholder="选填" />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="应用私钥 PEM（敏感）">
              <a-textarea
                v-model:value="form.privateKeyPem"
                :rows="4"
                placeholder="留空则保留现有配置；填入新值会覆盖对应字段"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="应用公钥证书（敏感）">
              <a-textarea
                v-model:value="form.appCertPem"
                :rows="4"
                placeholder="留空则保留现有配置；填入新值会覆盖对应字段"
              />
            </a-form-item>
          </a-col>
        </a-row>
        <a-row :gutter="16">
          <a-col :span="12">
            <a-form-item label="支付宝公钥证书（敏感）">
              <a-textarea
                v-model:value="form.alipayPublicCertPem"
                :rows="4"
                placeholder="留空则保留现有配置；填入新值会覆盖对应字段"
              />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="支付宝根证书（敏感）">
              <a-textarea
                v-model:value="form.alipayRootCertPem"
                :rows="4"
                placeholder="留空则保留现有配置；填入新值会覆盖对应字段"
              />
            </a-form-item>
          </a-col>
        </a-row>
      </template>

      <a-form-item>
        <a-button type="primary" html-type="submit" :loading="saving">
          保存配置
        </a-button>
      </a-form-item>
    </a-form>
  </div>
</template>
