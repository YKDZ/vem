<script setup lang="ts">
import { formatMachineSlotCoordinate } from "@vem/shared";
import { computed } from "vue";

import type { MachineCatalogItem } from "@/types/catalog";

import { formatCents } from "@/utils/format";

const props = defineProps<{
  item: MachineCatalogItem;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  select: [item: MachineCatalogItem];
}>();

const initials = computed(() => props.item.productName.slice(0, 2));
const saleableVariants = computed(() =>
  props.item.variantCandidates.filter(
    (candidate) =>
      candidate.slotSalesState === "sale_ready" && candidate.saleableStock > 0,
  ),
);
const variantCount = computed(
  () => saleableVariants.value.length || props.item.variantCandidates.length,
);
const specText = computed(() => {
  if (variantCount.value > 1) {
    const sizeCount = new Set(
      props.item.variantCandidates.map((candidate) => candidate.size ?? "默认"),
    ).size;
    const styleCount = new Set(
      props.item.variantCandidates.map(
        (candidate) => candidate.color ?? "默认",
      ),
    ).size;
    return [`${sizeCount}个尺码`, `${styleCount}种样式`].join(" · ");
  }
  return (
    [props.item.size, props.item.color].filter(Boolean).join(" / ") ||
    props.item.sku
  );
});
const priceText = computed(() => {
  const prices = (
    saleableVariants.value.length
      ? saleableVariants.value
      : props.item.variantCandidates
  ).map((candidate) => candidate.priceCents);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  if (!Number.isFinite(minPrice)) return formatCents(props.item.priceCents);
  if (minPrice === maxPrice) return formatCents(minPrice);
  return `${formatCents(minPrice)}起`;
});
const slotLabel = computed(() =>
  props.item.aggregatedSlotCount > 1
    ? `多格口 · ${props.item.aggregatedSlotCount}处`
    : formatMachineSlotCoordinate(props.item),
);
const buttonText = computed(() => {
  if (
    props.item.slotSalesState !== "sale_ready" ||
    props.item.saleableStock <= 0
  )
    return "已售罄";
  if (props.disabled) return "暂不可购买";
  return "查看详情";
});
</script>

<template>
  <article
    class="rounded-[1.75rem] border border-white/10 bg-white/10 p-4 shadow-xl"
    :class="disabled ? 'opacity-50' : 'opacity-100'"
  >
    <div
      class="flex aspect-square items-center justify-center rounded-3xl bg-gradient-to-br from-sky-300 to-indigo-500 text-4xl font-black text-slate-950"
    >
      {{ initials }}
    </div>
    <div class="mt-4 space-y-2">
      <div class="flex items-start justify-between gap-3">
        <h3 class="text-xl font-bold text-white">{{ item.productName }}</h3>
        <span
          class="rounded-full bg-emerald-300/15 px-3 py-1 text-sm font-bold text-emerald-100"
        >
          {{ slotLabel }}
        </span>
      </div>
      <p class="text-sm text-slate-300">{{ specText }}</p>
      <div class="flex items-end justify-between">
        <p class="text-2xl font-black text-sky-200">
          {{ priceText }}
        </p>
        <p class="text-sm text-slate-300">可售 {{ item.saleableStock }}</p>
      </div>
      <button
        class="kiosk-touch-target mt-3 w-full rounded-2xl bg-slate-100 px-4 py-3 font-bold text-base text-slate-950 disabled:cursor-not-allowed disabled:bg-slate-500 disabled:text-slate-300"
        type="button"
        :disabled="
          disabled ||
          item.slotSalesState !== 'sale_ready' ||
          item.saleableStock <= 0
        "
        @click="emit('select', item)"
      >
        {{ buttonText }}
      </button>
    </div>
  </article>
</template>
