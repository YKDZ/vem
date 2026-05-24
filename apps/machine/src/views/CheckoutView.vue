<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";
import { useMachineStore } from "@/stores/machine";
import { formatCents } from "@/utils/format";

const router = useRouter();
const checkoutStore = useCheckoutStore();
const machineStore = useMachineStore();
const connectivityStore = useConnectivityStore();

const item = computed(() => checkoutStore.selectedItem);
const canSubmit = computed(
  () =>
    Boolean(item.value) &&
    checkoutStore.canCreateOrder &&
    machineStore.canSell &&
    connectivityStore.isSaleNetworkReady &&
    !checkoutStore.loading,
);

const paymentHint = computed(() => {
  const selected = checkoutStore.selectedPaymentOption;
  if (!selected) return null;
  if (selected.providerCode === "mock")
    return "本地开发模式可在支付页使用模拟按钮。";
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
    await checkoutStore.loadPaymentOptions(machineStore.config);
  } catch {
    // 错误已写入 checkoutStore.error
  }
});

async function submitOrder(): Promise<void> {
  if (!canSubmit.value) return;
  try {
    await checkoutStore.createOrder(machineStore.config);
    await router.replace("/payment");
  } catch {
    // 错误已写入 checkoutStore.error，模板负责展示。
  }
}
</script>

<template>
  <KioskLayout>
    <section v-if="item" class="flex h-full flex-col text-white">
      <button
        class="kiosk-touch-target w-fit rounded-2xl border border-white/20 px-5 py-3 font-bold"
        type="button"
        @click="router.back()"
      >
        ← 返回详情
      </button>

      <div
        class="mt-5 rounded-4xl border border-white/10 bg-white/10 p-6 shadow-2xl"
      >
        <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">CHECKOUT</p>
        <h2 class="mt-2 text-4xl font-black">确认购买</h2>

        <div class="mt-6 rounded-3xl bg-slate-950/45 p-5">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="text-2xl font-bold">{{ item.productName }}</h3>
              <p class="mt-2 text-slate-300">
                SKU {{ item.sku }} · 格口 {{ item.slotCode }} · 数量 1
              </p>
            </div>
            <strong class="text-3xl font-black text-sky-200">
              {{ formatCents(item.priceCents) }}
            </strong>
          </div>
        </div>

        <div class="mt-6 rounded-3xl bg-slate-950/45 p-5">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-2xl font-bold">选择支付方式</h3>
              <p class="mt-1 text-slate-300">请选择后在下一步扫码支付</p>
            </div>
            <span
              v-if="checkoutStore.paymentOptions.length === 1"
              class="rounded-full bg-emerald-400/20 px-3 py-1 text-sm text-emerald-100"
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
              class="kiosk-touch-target rounded-3xl border px-5 py-4 text-left"
              :class="
                option.optionKey === checkoutStore.selectedPaymentOptionKey
                  ? 'border-sky-300 bg-sky-300/20 text-white'
                  : 'border-white/15 bg-white/5 text-slate-200'
              "
              type="button"
              :disabled="option.disabled"
              @click="checkoutStore.selectPaymentOption(option.optionKey)"
            >
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-xl font-black">{{ option.displayName }}</p>
                  <p class="mt-1 text-sm text-slate-300">
                    {{
                      option.disabled
                        ? option.disabledReason
                        : option.description
                    }}
                  </p>
                </div>
                <span v-if="option.recommended" class="text-sm text-sky-100">
                  推荐
                </span>
              </div>
            </button>
          </div>

          <p
            v-else-if="checkoutStore.paymentOptionsLoaded"
            class="mt-4 rounded-2xl bg-amber-400/15 p-4 text-amber-100"
          >
            当前机器暂无可用支付方式，请联系管理员检查支付配置。
          </p>
        </div>

        <ul class="mt-6 space-y-3 text-base text-slate-200">
          <li v-if="paymentHint" class="rounded-2xl bg-slate-950/35 p-4">
            {{ paymentHint }}
          </li>
          <li
            v-if="!connectivityStore.isSaleNetworkReady"
            class="rounded-2xl bg-amber-400/15 p-4 text-amber-100"
          >
            网络或 MQTT 未就绪，当前不能创建订单。
          </li>
          <li
            v-if="!machineStore.canSell"
            class="rounded-2xl bg-amber-400/15 p-4 text-amber-100"
          >
            机器配置或硬件自检未就绪，当前不能创建订单。
          </li>
        </ul>

        <p
          v-if="checkoutStore.error"
          class="mt-5 rounded-2xl bg-rose-500/20 p-4 text-rose-100"
        >
          {{ checkoutStore.error }}
        </p>
      </div>

      <button
        class="kiosk-touch-target mt-auto rounded-3xl bg-sky-400 px-6 py-5 text-2xl font-black text-slate-950 shadow-xl shadow-sky-950/40 disabled:bg-slate-500 disabled:text-slate-300"
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
