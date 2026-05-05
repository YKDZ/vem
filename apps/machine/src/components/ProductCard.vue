<script setup lang="ts">
import { computed } from "vue";

import type { MachineCatalogItem } from "@/types/catalog";

import { formatCents } from "@/utils/format";

const props = defineProps<{
  item: MachineCatalogItem;
  disabled?: boolean;
}>();

const initials = computed(() => props.item.productName.slice(0, 2));
const specText = computed(
  () =>
    [props.item.size, props.item.color].filter(Boolean).join(" / ") ||
    props.item.sku,
);
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
          {{ item.slotCode }}
        </span>
      </div>
      <p class="text-sm text-slate-300">{{ specText }}</p>
      <div class="flex items-end justify-between">
        <p class="text-2xl font-black text-sky-200">
          {{ formatCents(item.priceCents) }}
        </p>
        <p class="text-sm text-slate-300">剩余 {{ item.availableQty }}</p>
      </div>
      <button
        class="kiosk-touch-target mt-3 w-full rounded-2xl bg-slate-100 px-4 py-3 font-bold text-base disabled:cursor-not-allowed disabled:bg-slate-500 disabled:text-slate-300"
        type="button"
        :disabled="disabled"
      >
        第一阶段仅展示
      </button>
    </div>
  </article>
</template>
