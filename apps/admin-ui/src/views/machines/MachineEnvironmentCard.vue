<script setup lang="ts">
import type { MachineCommandStatus } from "@vem/shared";

import type { Machine } from "@/api/machines";

import { formatDateTime } from "@/utils/format";

import type { EnvironmentControlForm } from "./machine-contract-mappers";

import {
  airConditionerLabel,
  commandStatusLabel,
  formatEnvironmentNumber,
  sensorStatusLabel,
  targetTemperatureLabel,
} from "./machine-environment-display";

defineProps<{
  environment: Machine["latestEnvironment"] | null | undefined;
  commandStatus: MachineCommandStatus | null;
  form: EnvironmentControlForm;
  canCommand: boolean;
  submitting: boolean;
  targetTemperatureInvalid: boolean;
  commandDisabled: boolean;
  loading?: boolean;
  bordered?: boolean;
}>();

const emit = defineEmits<{
  submit: [];
}>();
</script>

<template>
  <a-card title="环境与空调" :bordered="bordered">
    <div v-if="loading" class="text-sm text-gray-500">加载中</div>
    <template v-else>
      <a-descriptions bordered :column="1" size="small">
        <template v-if="environment">
          <a-descriptions-item label="温度">
            {{ formatEnvironmentNumber(environment.temperatureCelsius, "C") }}
          </a-descriptions-item>
          <a-descriptions-item label="湿度">
            {{ formatEnvironmentNumber(environment.humidityRh, "% RH") }}
          </a-descriptions-item>
          <a-descriptions-item label="采样时间">
            {{ formatDateTime(environment.sampledAt) }}
          </a-descriptions-item>
          <a-descriptions-item label="传感器">
            {{ sensorStatusLabel(environment.sensorStatus) }}
          </a-descriptions-item>
          <a-descriptions-item label="空调">
            {{ airConditionerLabel(environment.airConditionerOn) }}
          </a-descriptions-item>
          <a-descriptions-item label="目标温度">
            {{ targetTemperatureLabel(environment.targetTemperatureCelsius) }}
          </a-descriptions-item>
        </template>
        <template v-else>
          <a-descriptions-item label="最新读数">环境未知</a-descriptions-item>
        </template>
        <a-descriptions-item label="最新命令">
          {{ commandStatusLabel(commandStatus) }}
        </a-descriptions-item>
      </a-descriptions>

      <div class="mt-5 border-t border-slate-200 pt-4">
        <h3 class="text-sm font-medium text-slate-900">控制动作</h3>
        <a-form layout="vertical" class="mt-3">
          <a-form-item>
            <div class="space-y-2">
              <div class="flex items-center gap-3">
                <a-checkbox
                  v-model:checked="form.includeAirConditioner"
                  :disabled="!canCommand || submitting"
                >
                  设置空调开关
                </a-checkbox>
                <a-switch
                  v-model:checked="form.airConditionerOn"
                  :disabled="
                    !canCommand || submitting || !form.includeAirConditioner
                  "
                >
                  {{ form.airConditionerOn ? "开" : "关" }}
                </a-switch>
              </div>
              <div class="flex items-center gap-3">
                <a-checkbox
                  v-model:checked="form.includeTargetTemperature"
                  :disabled="!canCommand || submitting"
                >
                  设置目标温度
                </a-checkbox>
                <a-input-number
                  v-model:value="form.targetTemperatureCelsius"
                  :min="18"
                  :max="30"
                  :disabled="
                    !canCommand || submitting || !form.includeTargetTemperature
                  "
                  class="w-28"
                />
                <span>C</span>
              </div>
              <div v-if="targetTemperatureInvalid" class="text-xs text-red-600">
                目标温度必须在 18-30 C
              </div>
              <div v-if="!canCommand" class="text-xs text-gray-500">
                无机器控制权限
              </div>
            </div>
          </a-form-item>
          <a-button
            v-if="canCommand"
            type="primary"
            :loading="submitting"
            :disabled="commandDisabled"
            @click="emit('submit')"
          >
            提交环境控制
          </a-button>
        </a-form>
      </div>
    </template>
  </a-card>
</template>
