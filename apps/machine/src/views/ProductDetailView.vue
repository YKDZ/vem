<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { formatCents } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();

const inventoryId = computed(() => String(route.params.inventoryId ?? ""));
const item = computed(() => {
  const saleViewItem = catalogStore.itemByInventoryId(inventoryId.value);
  if (saleViewItem) return saleViewItem;
  if (checkoutStore.selectedItem?.inventoryId === inventoryId.value) {
    return checkoutStore.selectedItem;
  }
  return null;
});
const specText = computed(() => {
  if (!item.value) return "-";
  return (
    [item.value.size, item.value.color].filter(Boolean).join(" / ") ||
    item.value.sku
  );
});

onMounted(async () => {
  if (!item.value) {
    await router.replace("/catalog");
  }
});

async function goCheckout(): Promise<void> {
  if (
    !item.value ||
    item.value.slotSalesState !== "saleable" ||
    item.value.saleableStock <= 0
  )
    return;
  checkoutStore.selectItem(item.value);
  await router.push("/checkout");
}
</script>

<template>
  <KioskLayout>
    <section v-if="item" class="flex h-full flex-col gap-5 text-white">
      <button
        class="kiosk-touch-target w-fit rounded-2xl border border-white/20 px-5 py-3 font-bold"
        type="button"
        @click="router.push('/catalog')"
      >
        ← 返回商品列表
      </button>

      <div
        class="rounded-4xl border border-white/10 bg-white/10 p-6 shadow-2xl"
      >
        <div
          class="flex aspect-square max-h-[44vh] items-center justify-center rounded-[2rem] bg-gradient-to-br from-sky-300 to-indigo-500 text-7xl font-black text-slate-950"
        >
          {{ item.productName.slice(0, 2) }}
        </div>
        <div class="mt-6 space-y-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">
                PRODUCT
              </p>
              <h2 class="mt-2 text-4xl font-black">{{ item.productName }}</h2>
            </div>
            <span
              class="rounded-full bg-emerald-300/15 px-4 py-2 font-bold text-emerald-100"
            >
              格口 {{ item.slotCode }}
            </span>
          </div>

          <dl class="grid grid-cols-2 gap-3 text-lg">
            <div class="rounded-2xl bg-slate-950/40 p-4">
              <dt class="text-sm text-slate-400">规格</dt>
              <dd class="mt-1 font-bold">{{ specText }}</dd>
            </div>
            <div class="rounded-2xl bg-slate-950/40 p-4">
              <dt class="text-sm text-slate-400">库存</dt>
              <dd class="mt-1 font-bold">可售 {{ item.saleableStock }}</dd>
            </div>
          </dl>

          <div
            class="flex items-center justify-between rounded-3xl bg-slate-950/50 p-5"
          >
            <span class="text-slate-300">支付金额</span>
            <strong class="text-4xl font-black text-sky-200">
              {{ formatCents(item.priceCents) }}
            </strong>
          </div>
        </div>
      </div>

      <button
        class="kiosk-touch-target mt-auto rounded-3xl bg-sky-400 px-6 py-5 text-2xl font-black text-slate-950 shadow-xl shadow-sky-950/40 disabled:bg-slate-500 disabled:text-slate-300"
        type="button"
        :disabled="
          item.slotSalesState !== 'saleable' || item.saleableStock <= 0
        "
        @click="goCheckout"
      >
        立即购买
      </button>
    </section>
  </KioskLayout>
</template>
