<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useConnectivityStore } from "@/stores/connectivity";

const router = useRouter();
const connectivityStore = useConnectivityStore();

const reasonText = computed(() => {
  const codes = connectivityStore.ready?.blockingCodes ?? [];
  if (connectivityStore.loading) return "正在检测设备状态，请稍候。";
  if (codes.includes("WHOLE_MACHINE_HARDWARE_FAULT")) {
    return "设备需要工作人员检查后才能继续售卖。";
  }
  if (
    codes.includes("LOWER_CONTROLLER_UNAVAILABLE") ||
    codes.includes("SLOT_SALE_SAFETY_BLOCKED")
  ) {
    return "设备暂时无法确认出货状态，请联系工作人员。";
  }
  if (
    codes.includes("PLATFORM_UNREACHABLE") ||
    codes.includes("BACKEND_UNREACHABLE") ||
    codes.includes("mqtt")
  ) {
    return "网络连接未就绪，暂时不能下单。";
  }
  if (
    codes.includes("NO_PAYMENT_OPTIONS") ||
    codes.includes("PAYMENT_OPTIONS_UNAVAILABLE")
  ) {
    return "支付服务暂时不可用。";
  }
  if (codes.includes("ACTIVE_PLANOGRAM_MISSING")) {
    return "商品信息暂未准备好。";
  }
  if (!connectivityStore.ready) return "正在读取设备状态，请稍候。";
  return "设备暂时未准备好，请稍后再试。";
});

async function retryBoot(): Promise<void> {
  await router.replace("/boot");
}
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col justify-center rounded-lg border border-neutral-200 bg-white p-8 text-center text-neutral-950"
    >
      <p class="text-sm font-semibold tracking-[0.2em] text-neutral-500">
        暂不可购买
      </p>
      <h2 class="mt-4 text-4xl font-bold">暂时无法购买</h2>
      <p class="mt-5 text-xl text-neutral-700">
        为避免支付和出货异常，当前暂停下单。
      </p>
      <div
        class="mt-6 rounded-lg border border-neutral-200 bg-neutral-50 p-5 text-left"
      >
        <p class="text-sm text-neutral-500">原因</p>
        <p class="mt-2 text-lg text-neutral-800">{{ reasonText }}</p>
      </div>
      <div class="mt-8 grid gap-4">
        <button
          class="kiosk-touch-target rounded-lg bg-neutral-950 px-6 py-4 text-lg font-bold text-white"
          type="button"
          @click="retryBoot"
        >
          重新检测网络
        </button>
        <button
          class="kiosk-touch-target rounded-lg border border-neutral-300 bg-white px-6 py-4 text-lg font-bold text-neutral-950"
          type="button"
          @click="
            router.push({
              path: '/maintenance',
              query: { source: 'operator' },
            })
          "
        >
          进入维护配置
        </button>
      </div>
    </section>
  </KioskLayout>
</template>
