<script setup lang="ts">
import type { MachineCommandStatus } from "@vem/shared";

import type { Machine } from "@/api/machines";

import { formatDateTime } from "@/utils/format";

import type {
  EnvironmentControlAction,
  EnvironmentControlForm,
} from "./machine-contract-mappers";

import {
  commandStatusLabel,
  formatEnvironmentNumber,
  sensorStatusLabel,
} from "./machine-environment-display";

const props = defineProps<{
  environment: Machine["latestEnvironment"] | null | undefined;
  commandStatus: MachineCommandStatus | null;
  form: EnvironmentControlForm;
  canCommand: boolean;
  controlsDisabled: boolean;
  submittingAction: EnvironmentControlAction | null;
  targetTemperatureInvalid: boolean;
  loading?: boolean;
  bordered?: boolean;
}>();

const emit = defineEmits<{
  command: [action: EnvironmentControlAction, value: boolean | number];
}>();

const actionOptions: Array<{
  label: string;
  value: EnvironmentControlForm["ventSpeed"];
}> = [
  { label: "关闭", value: 0 },
  { label: "低", value: 1 },
  { label: "中", value: 2 },
  { label: "高", value: 3 },
  { label: "全", value: 4 },
];

function emitAction(
  action: EnvironmentControlAction,
  value: boolean | number,
): void {
  emit("command", action, value);
}
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
        <div class="mt-3 space-y-3 text-sm">
          <div class="flex items-center gap-3">
            <span class="w-24">空调</span>
            <a-button
              type="primary"
              :loading="submittingAction === 'airConditionerOn'"
              :disabled="controlsDisabled"
              @click="emitAction('airConditionerOn', true)"
            >
              开启
            </a-button>
            <a-button
              :loading="submittingAction === 'airConditionerOn'"
              :disabled="controlsDisabled"
              @click="emitAction('airConditionerOn', false)"
            >
              软关闭
            </a-button>
          </div>

          <div class="flex items-center gap-3">
            <span class="w-24">目标温度</span>
            <a-input-number
              v-model:value="form.targetTemperatureCelsius"
              :min="18"
              :max="30"
              class="w-28"
              :disabled="controlsDisabled"
            />
            <span>C</span>
            <a-button
              type="primary"
              :loading="submittingAction === 'targetTemperatureCelsius'"
              :disabled="controlsDisabled || targetTemperatureInvalid"
              @click="
                emitAction(
                  'targetTemperatureCelsius',
                  form.targetTemperatureCelsius,
                )
              "
            >
              设定
            </a-button>
          </div>
          <div v-if="targetTemperatureInvalid" class="text-xs text-red-600">
            目标温度必须在 18-30 C
          </div>

          <div class="flex items-center gap-3">
            <span class="w-24">出风口与风速</span>
            <select
              :value="String(form.ventSpeed)"
              :disabled="controlsDisabled"
              class="w-28"
              @change="
                (event: Event) =>
                  (form.ventSpeed = Number(
                    (event.target as HTMLSelectElement).value,
                  ))
              "
            >
              <option
                v-for="option in actionOptions"
                :key="option.value"
                :value="String(option.value)"
              >
                {{ option.label }}
              </option>
            </select>
            <a-button
              type="primary"
              :loading="submittingAction === 'ventSpeed'"
              :disabled="controlsDisabled"
              @click="emitAction('ventSpeed', form.ventSpeed)"
            >
              设定
            </a-button>
          </div>
        </div>
      </div>
    </template>
  </a-card>
</template>
