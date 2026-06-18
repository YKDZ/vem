<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { MachineCatalogItem } from "@/types/catalog";

import ProductDetailPanel from "@/components/product/ProductDetailPanel.vue";
import { useVisionRecommendations } from "@/composables/useVisionRecommendations";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const { currentProfile } = useVisionRecommendations();

const catalogKey = computed(() => String(route.params.catalogKey ?? ""));
const item = computed(() => {
  const catalogItem = catalogStore.itemByCatalogKey(catalogKey.value);
  if (catalogItem) return catalogItem;
  if (checkoutStore.selectedItem?.catalogKey === catalogKey.value) {
    return checkoutStore.selectedItem;
  }
  return null;
});

onMounted(async () => {
  if (!item.value) {
    await router.replace("/catalog");
  }
});

async function goCheckout(selectedItem: MachineCatalogItem): Promise<void> {
  checkoutStore.selectItem(selectedItem);
  await router.push("/checkout");
}
</script>

<template>
  <KioskLayout>
    <section v-if="item" class="flex h-full min-h-0 flex-col gap-4">
      <button
        class="kiosk-touch-target w-fit rounded-lg border border-neutral-300 bg-white px-4 py-2 font-bold text-neutral-950"
        type="button"
        @click="router.push('/catalog')"
      >
        返回
      </button>
      <ProductDetailPanel
        class="min-h-0 flex-1"
        :item="item"
        :profile="currentProfile"
        @purchase="goCheckout"
      />
    </section>
  </KioskLayout>
</template>
