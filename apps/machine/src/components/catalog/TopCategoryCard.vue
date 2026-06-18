<script setup lang="ts">
import type { CatalogTopCategoryGroup } from "@/catalog/view-model";

defineProps<{
  group: CatalogTopCategoryGroup;
}>();

const emit = defineEmits<{
  select: [key: CatalogTopCategoryGroup["key"]];
}>();
</script>

<template>
  <button
    class="kiosk-touch-target flex h-full min-h-0 flex-1 flex-col justify-between rounded-lg border border-neutral-200 bg-white p-5 text-left text-neutral-950 shadow-sm disabled:opacity-45"
    type="button"
    :disabled="group.items.length === 0"
    @click="emit('select', group.key)"
  >
    <span>
      <span class="text-3xl font-black">{{ group.label }}</span>
      <span class="mt-3 block text-base text-neutral-500">
        {{ group.description }}
      </span>
    </span>
    <span class="mt-6 flex items-end justify-between gap-4">
      <span class="text-sm text-neutral-500">
        {{ group.items.length }} 款商品
      </span>
      <span class="font-bold text-base text-neutral-700">进入选择</span>
    </span>
  </button>
</template>
