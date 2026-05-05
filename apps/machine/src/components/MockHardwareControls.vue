<script setup lang="ts">
import { ref } from "vue";

import type { MockDispenseMode } from "@/hardware/adapter";

import {
  getMockDispenseMode,
  setMockDispenseMode,
} from "@/hardware/mock-adapter";

const mode = ref<MockDispenseMode>(getMockDispenseMode());
const options: Array<{ value: MockDispenseMode; label: string }> = [
  { value: "success", label: "下一次出货成功" },
  { value: "no_drop", label: "下一次明确未掉货 NO_DROP" },
  { value: "jammed", label: "下一次卡货 JAMMED" },
  { value: "timeout", label: "下一次电机超时 MOTOR_TIMEOUT" },
];

function save(): void {
  setMockDispenseMode(mode.value);
}
</script>

<template>
  <section class="rounded-3xl border border-white/10 bg-slate-950/40 p-5">
    <h3 class="text-xl font-bold text-white">Mock 出货模拟</h3>
    <p class="mt-2 text-sm text-slate-300">
      第三阶段使用 TypeScript MockAdapter 模拟硬件返回；真实串口/蓝牙 adapter
      在第五阶段替换。
    </p>
    <div class="mt-4 grid gap-3">
      <label
        v-for="option in options"
        :key="option.value"
        class="flex items-center gap-3 rounded-2xl bg-white/5 p-4 text-slate-100"
      >
        <input
          v-model="mode"
          type="radio"
          :value="option.value"
          @change="save"
        />
        <span>{{ option.label }}</span>
      </label>
    </div>
  </section>
</template>
