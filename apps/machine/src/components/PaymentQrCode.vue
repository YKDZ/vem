<script setup lang="ts">
import { ref, watch } from "vue";

import { renderPaymentQrDataUrl } from "@/utils/payment-qr";

const props = defineProps<{
  value: string | null | undefined;
  blocked?: boolean;
  overlayText?: string | null;
  emptyText?: string | null;
}>();

const dataUrl = ref("");
const error = ref<string | null>(null);

watch(
  () => props.value,
  async (value) => {
    error.value = null;
    if (!value) {
      dataUrl.value = "";
      return;
    }
    try {
      dataUrl.value = await renderPaymentQrDataUrl(value);
    } catch (err) {
      dataUrl.value = "";
      error.value = err instanceof Error ? err.message : String(err);
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="relative rounded-lg bg-white p-5 shadow-sm">
    <img
      v-if="dataUrl"
      class="mx-auto size-[320px] max-h-[45vh] max-w-full"
      :src="dataUrl"
      alt="支付二维码"
      data-installed-kiosk-sale-qr
    />
    <div
      v-else
      class="flex size-[320px] max-h-[45vh] max-w-full items-center justify-center rounded-lg bg-slate-100 text-center text-slate-500"
    >
      {{ error ?? props.emptyText ?? "暂无支付二维码" }}
    </div>
    <div
      v-if="blocked"
      class="absolute inset-5 flex items-center justify-center rounded-lg bg-slate-950/80 text-3xl font-black text-white"
    >
      {{ overlayText ?? "二维码不可用" }}
    </div>
  </div>
</template>
