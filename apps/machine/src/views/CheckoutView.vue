<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { formatCents } from "@/utils/format";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const catalogStore = useCatalogStore();
const connectivityStore = useConnectivityStore();

const item = computed(() => {
  const selectedItem = checkoutStore.selectedItem;
  if (!selectedItem) return null;
  return catalogStore.saleableItemFor(selectedItem) ?? selectedItem;
});
const specText = computed(() => {
  if (!item.value) return "-";
  return (
    [item.value.size, item.value.color].filter(Boolean).join(" / ") ||
    item.value.sku
  );
});
const canSubmit = computed(
  () =>
    Boolean(item.value) &&
    checkoutStore.canCreateOrder &&
    connectivityStore.isSaleNetworkReady &&
    !checkoutStore.loading,
);

const paymentHint = computed(() => {
  const selected = checkoutStore.selectedPaymentOption;
  if (!selected) return null;
  if (selected.providerCode === "mock") return "下一步将进入模拟支付流程。";
  if (selected.method === "payment_code") {
    return "下一步请出示付款码并靠近扫码窗口完成支付。";
  }
  return "下一步将展示所选渠道二维码，请使用对应 App 扫码支付。";
});

onMounted(async () => {
  if (!item.value) {
    await router.replace("/catalog");
    return;
  }
  try {
    await checkoutStore.loadPaymentOptions();
  } catch {
    // 错误已写入 checkoutStore.error
  }
});

async function submitOrder(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    await checkoutStore.createOrder();
    await router.replace("/payment");
  } catch {
    // 错误已写入 checkoutStore.error，模板负责展示。
  }
}
</script>

<template>
  <KioskLayout>
    <section v-if="item" class="flex h-full flex-col text-neutral-950">
      <button
        class="kiosk-touch-target w-fit rounded-lg border border-neutral-300 bg-white px-4 py-2 font-bold text-neutral-950"
        type="button"
        @click="router.back()"
      >
        返回
      </button>

      <div class="mt-5 flex items-end justify-between gap-6">
        <div>
          <p class="text-sm font-semibold tracking-[0.2em] text-neutral-500">
            确认订单
          </p>
          <h2 class="mt-2 text-4xl font-black">确认购买</h2>
        </div>
        <strong class="text-4xl font-black">
          {{ formatCents(item.priceCents) }}
        </strong>
      </div>

      <div class="mt-6 grid min-h-0 flex-1 grid-cols-[0.9fr_1.1fr] gap-4">
        <section class="rounded-lg border border-neutral-200 bg-white p-5">
          <p class="text-sm font-semibold tracking-[0.2em] text-neutral-500">
            商品
          </p>
          <h3 class="mt-3 text-3xl font-black">{{ item.productName }}</h3>
          <p class="mt-3 text-lg text-neutral-600">{{ specText }} · 数量 1</p>
        </section>

        <section
          class="kiosk-scroll min-h-0 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-5"
        >
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="text-2xl font-black">选择支付方式</h3>
              <p class="mt-1 text-neutral-600">请选择后在下一步扫码支付</p>
            </div>
            <span
              v-if="checkoutStore.paymentOptions.length === 1"
              class="rounded-md border border-neutral-200 px-3 py-1 text-sm text-neutral-600"
            >
              已自动选择
            </span>
          </div>

          <div
            v-if="checkoutStore.paymentOptions.length > 0"
            class="mt-4 grid gap-3"
          >
            <button
              v-for="option in checkoutStore.paymentOptions"
              :key="option.optionKey"
              class="kiosk-touch-target rounded-lg border px-5 py-4 text-left disabled:opacity-45"
              :class="
                option.optionKey === checkoutStore.selectedPaymentOptionKey
                  ? 'border-neutral-950 bg-neutral-950 text-white'
                  : 'border-neutral-200 bg-white text-neutral-950'
              "
              type="button"
              :disabled="option.disabled"
              @click="checkoutStore.selectPaymentOption(option.optionKey)"
            >
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xl font-black">{{ option.displayName }}</p>
                  <p
                    class="mt-1 text-sm"
                    :class="
                      option.optionKey ===
                      checkoutStore.selectedPaymentOptionKey
                        ? 'text-neutral-200'
                        : 'text-neutral-600'
                    "
                  >
                    {{
                      option.disabled
                        ? option.disabledReason
                        : option.description
                    }}
                  </p>
                </div>
                <span v-if="option.recommended" class="text-sm"> 推荐 </span>
              </div>
            </button>
          </div>

          <p
            v-else-if="checkoutStore.paymentOptionsLoaded"
            class="mt-4 rounded-md border border-neutral-200 bg-neutral-50 p-4 text-neutral-700"
          >
            当前暂无可用支付方式，请联系工作人员。
          </p>
        </section>
      </div>

      <ul class="mt-5 grid gap-3 text-base text-neutral-700">
        <li
          v-if="paymentHint"
          class="rounded-md border border-neutral-200 bg-white p-4"
        >
          {{ paymentHint }}
        </li>
        <li
          v-if="!connectivityStore.isSaleNetworkReady"
          class="rounded-md border border-neutral-200 bg-white p-4"
        >
          网络未就绪，当前不能创建订单。
        </li>
        <li
          v-if="!connectivityStore.ready?.canSell"
          class="rounded-md border border-neutral-200 bg-white p-4"
        >
          设备暂时未准备好，当前不能创建订单。
        </li>
      </ul>

      <p
        v-if="checkoutStore.error"
        class="mt-4 rounded-md border border-neutral-200 bg-white p-4 text-neutral-800"
      >
        {{ checkoutStore.error }}
      </p>

      <button
        class="kiosk-touch-target mt-5 rounded-lg bg-neutral-950 px-6 py-5 text-2xl font-black text-white disabled:bg-neutral-300 disabled:text-neutral-500"
        type="button"
        :disabled="!canSubmit"
        @click="submitOrder"
      >
        {{
          checkoutStore.loading
            ? "正在创建订单..."
            : checkoutStore.selectedPaymentOption?.method === "payment_code"
              ? "确认并进入付款码支付"
              : "确认并生成支付二维码"
        }}
      </button>
    </section>
  </KioskLayout>
</template>
