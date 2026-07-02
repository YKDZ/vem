<script setup lang="ts">
import { computed } from "vue";

import type { MachineCatalogItem } from "@/types/catalog";

import { formatCents } from "@/utils/format";

const props = defineProps<{
  item: MachineCatalogItem;
  selected?: boolean;
}>();

const emit = defineEmits<{
  select: [item: MachineCatalogItem];
}>();

const variantSummary = computed(() => {
  const sizes = new Set(
    props.item.variantCandidates.map((variant) => variant.size ?? "默认尺码"),
  );
  const colors = new Set(
    props.item.variantCandidates.map((variant) => variant.color ?? "默认颜色"),
  );
  return `${sizes.size} 个尺码 / ${colors.size} 种颜色`;
});

const priceText = computed(() => {
  const saleableVariants = props.item.variantCandidates.filter(
    (variant) =>
      variant.slotSalesState === "sale_ready" && variant.saleableStock > 0,
  );
  const variants = saleableVariants.length
    ? saleableVariants
    : props.item.variantCandidates;
  const prices = variants.map((variant) => variant.priceCents);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  if (!Number.isFinite(minPrice)) return formatCents(props.item.priceCents);
  return minPrice === maxPrice
    ? formatCents(minPrice)
    : `${formatCents(minPrice)}起`;
});
</script>

<template>
  <button
    class="kiosk-touch-target grid min-h-[132px] w-full grid-cols-[88px_minmax(0,1fr)] gap-4 rounded-lg border bg-white p-4 text-left text-neutral-950 shadow-sm"
    :class="selected ? 'border-neutral-950' : 'border-neutral-200'"
    type="button"
    @click="emit('select', item)"
  >
    <span
      class="flex aspect-square w-[88px] items-center justify-center overflow-hidden rounded-md bg-neutral-100 text-2xl font-black text-neutral-400"
      aria-hidden="true"
    >
      <img
        v-if="item.coverImageUrl"
        class="h-full w-full object-cover object-center"
        :src="item.coverImageUrl"
        :alt="item.productName"
      />
      <span v-else>{{ item.productName.slice(0, 1) }}</span>
    </span>
    <span class="flex min-w-0 flex-col">
      <span class="text-lg leading-tight font-black">{{
        item.productName
      }}</span>
      <span class="mt-2 line-clamp-2 text-sm text-neutral-500">
        {{ item.productDescription ?? variantSummary }}
      </span>
      <span class="mt-auto flex items-end justify-between gap-3 pt-4">
        <span class="text-xl font-black">{{ priceText }}</span>
        <span class="text-sm text-neutral-500">{{ variantSummary }}</span>
      </span>
    </span>
  </button>
</template>
