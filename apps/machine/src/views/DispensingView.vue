<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { resultKindFromNextAction, useCheckoutStore } from "@/stores/checkout";

const router = useRouter();
const checkoutStore = useCheckoutStore();

let pollTimer: number | undefined;

const status = computed(() => checkoutStore.status);
const command = computed(() => status.value?.vending ?? null);
const pickupReminder = computed(() => command.value?.pickupReminder ?? null);
const pickupReminderClass = computed(() => {
  switch (pickupReminder.value?.level) {
    case "urgent":
      return "border-neutral-950 bg-neutral-950 text-white";
    case "warning":
      return "border-neutral-400 bg-neutral-100 text-neutral-950";
    default:
      return "border-neutral-200 bg-neutral-50 text-neutral-700";
  }
});
const progressText = computed(() => {
  switch (command.value?.status) {
    case "succeeded":
      return "商品已送达，请从取货口取走。";
    case "failed":
    case "timeout":
    case "result_unknown":
      return "出货遇到问题，请联系工作人员处理。";
    case "acknowledged":
      return "设备正在出货，请稍候。";
    case "sent":
    case "pending":
    default:
      return "正在准备出货，请稍候。";
  }
});
const hasCustomerVisibleError = computed(
  () =>
    command.value?.status === "failed" ||
    command.value?.status === "timeout" ||
    command.value?.status === "result_unknown",
);
const pageLabel = computed(() =>
  hasCustomerVisibleError.value ? "人工处理" : "出货中",
);
const pageTitle = computed(() =>
  hasCustomerVisibleError.value ? "出货需要人工处理" : "支付成功，正在出货",
);
const orderCredential = computed(
  () =>
    checkoutStore.currentOrder?.orderNo ??
    checkoutStore.status?.orderNo ??
    null,
);

async function refreshStatus(): Promise<void> {
  await checkoutStore.refreshCurrentTransaction();
  if (!checkoutStore.status) return;
  const resultKind = resultKindFromNextAction(checkoutStore.status.nextAction);
  if (resultKind) {
    await router.replace({ name: "result", params: { kind: resultKind } });
  }
}

onMounted(async () => {
  if (!checkoutStore.currentOrder) {
    await router.replace("/catalog");
    return;
  }
  await refreshStatus();
  pollTimer = window.setInterval(() => {
    void refreshStatus();
  }, 2_000);
});

onUnmounted(() => {
  if (pollTimer) window.clearInterval(pollTimer);
});
</script>

<template>
  <KioskLayout>
    <section
      class="flex h-full flex-col items-center justify-center text-center text-neutral-950"
    >
      <div class="w-full rounded-lg border border-neutral-200 bg-white p-8">
        <p class="text-sm font-semibold tracking-[0.2em] text-neutral-500">
          {{ pageLabel }}
        </p>
        <h2 class="mt-4 text-4xl font-black">{{ pageTitle }}</h2>
        <p class="mt-4 text-lg text-neutral-600">{{ progressText }}</p>
        <p
          v-if="hasCustomerVisibleError && orderCredential"
          class="mt-3 text-base font-bold text-neutral-800"
        >
          订单凭证 {{ orderCredential }}
        </p>

        <div
          v-if="pickupReminder"
          class="mt-6 rounded-lg border p-6 text-left"
          :class="pickupReminderClass"
        >
          <p class="text-sm font-bold tracking-[0.2em]">取货提醒</p>
          <h3 class="mt-2 text-3xl font-black">
            {{ pickupReminder.message }}
          </h3>
          <p class="mt-2 text-base opacity-85">
            请检查取货口并及时拿走商品，避免设备自动关闭取货口。
          </p>
        </div>

        <div class="mt-8 grid gap-3 text-left text-neutral-700">
          <div class="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <div class="h-2 overflow-hidden rounded bg-neutral-200">
              <div
                class="h-full rounded bg-neutral-950"
                :class="command ? 'w-2/3' : 'w-1/3'"
              ></div>
            </div>
            <p class="mt-3">{{ progressText }}</p>
          </div>
          <div
            v-if="hasCustomerVisibleError"
            class="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-neutral-800"
          >
            出货遇到问题，请联系工作人员处理。
          </div>
        </div>
      </div>
    </section>
  </KioskLayout>
</template>
