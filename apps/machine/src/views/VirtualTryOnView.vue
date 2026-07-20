<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import {
  managedMediaDiagnosticKey,
  resolveManagedMediaReference,
} from "@/catalog/managed-media";
import { useTryOnPreview } from "@/composables/useTryOnPreview";
import { submitMachineNavigationIntent } from "@/router/transaction-route-authority";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";

const route = useRoute();
const catalogStore = useCatalogStore();
const machineStore = useMachineStore();
const { previewUrl, errorMessage, isStarting, startPreview, stopPreview } =
  useTryOnPreview();

const catalogKey = computed(() => String(route.params.catalogKey ?? ""));
const variantId = computed(() => String(route.query.variantId ?? ""));
const item = computed(() => catalogStore.itemByCatalogKey(catalogKey.value));
const selectedVariant = computed(
  () =>
    item.value?.variantCandidates.find(
      (variant) => variant.variantId === variantId.value,
    ) ?? null,
);
const silhouetteSlotId = computed(
  () =>
    catalogStore.saleableVariantItemFor(catalogKey.value, variantId.value)
      ?.slotId ??
    selectedVariant.value?.slotCandidates[0]?.slotId ??
    item.value?.slotId ??
    "missing",
);
const silhouetteDiagnosticLocation = computed(
  () => `media:${silhouetteSlotId.value}:tryOnSilhouetteUrl`,
);
const silhouetteResolution = computed(() =>
  resolveManagedMediaReference(
    selectedVariant.value?.tryOnSilhouetteUrl,
    machineStore.platformApiBaseUrl ?? "",
  ),
);
const silhouetteUrl = computed(() => silhouetteResolution.value.url);
const sessionSilhouetteUrl = ref<string | null>(null);
const silhouetteAvailable = ref(true);

function recordSilhouetteDiagnostic(message: string): void {
  const reference = selectedVariant.value?.tryOnSilhouetteUrl;
  catalogStore.recordMediaDiagnostic(
    reference,
    message,
    managedMediaDiagnosticKey(silhouetteDiagnosticLocation.value, reference),
  );
}

watch(
  silhouetteResolution,
  (resolution) => {
    silhouetteAvailable.value = true;
    if (
      resolution.diagnostic &&
      selectedVariant.value?.tryOnSilhouetteUrl !== null &&
      selectedVariant.value?.tryOnSilhouetteUrl !== undefined
    ) {
      recordSilhouetteDiagnostic(resolution.diagnostic);
    }
  },
  { immediate: true },
);

onMounted(() => {
  sessionSilhouetteUrl.value = silhouetteUrl.value;
  void startPreview({
    catalogKey: catalogKey.value,
    variantId: variantId.value,
    silhouetteUrl: sessionSilhouetteUrl.value,
  });
});

onBeforeUnmount(() => {
  void stopPreview("route_leave");
});

async function exitTryOn(): Promise<void> {
  await stopPreview("user_exit");
  await submitMachineNavigationIntent({
    type: "customer.navigate",
    target: {
      name: "product-detail",
      params: { catalogKey: catalogKey.value },
      query: { variantId: variantId.value },
    },
  });
}

function useSilhouettePlaceholder(): void {
  if (!silhouetteAvailable.value) return;
  silhouetteAvailable.value = false;
  recordSilhouetteDiagnostic("managed try-on silhouette failed to load");
}
</script>

<template>
  <main class="virtual-try-on-view">
    <img
      v-if="previewUrl"
      class="try-on-preview"
      :src="previewUrl"
      alt=""
      aria-hidden="true"
      data-test="try-on-preview"
    />
    <div
      v-else
      class="try-on-preview-placeholder"
      data-test="try-on-preview-placeholder"
    ></div>
    <img
      v-if="sessionSilhouetteUrl && silhouetteAvailable"
      class="try-on-silhouette try-on-silhouette-fixed"
      :src="sessionSilhouetteUrl"
      alt=""
      aria-hidden="true"
      data-test="try-on-silhouette"
      @error="useSilhouettePlaceholder"
    />
    <div
      v-else
      class="try-on-silhouette try-on-silhouette-placeholder"
      aria-hidden="true"
      data-test="try-on-silhouette-placeholder"
    ></div>
    <section v-if="errorMessage" class="try-on-error" data-test="try-on-error">
      <p>{{ errorMessage }}</p>
    </section>
    <section
      v-else-if="isStarting"
      class="try-on-error"
      data-test="try-on-starting"
    >
      <p>正在启动虚拟试穿预览...</p>
    </section>
    <button
      class="try-on-exit kiosk-touch-target"
      type="button"
      data-test="try-on-exit"
      @click="exitTryOn"
    >
      退出试穿
    </button>
  </main>
</template>

<style scoped>
.virtual-try-on-view {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #111;
}

.try-on-preview,
.try-on-preview-placeholder {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.try-on-silhouette {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: min(42vw, 34rem);
  max-height: min(78vh, 48rem);
  transform: translate(-50%, -50%);
  object-fit: contain;
  pointer-events: none;
}

.try-on-silhouette-placeholder {
  border: 2px dashed rgba(255, 255, 255, 0.4);
  border-radius: 999px 999px 2rem 2rem;
  background: rgba(255, 255, 255, 0.08);
}

.try-on-error {
  position: absolute;
  left: 50%;
  top: 50%;
  width: min(80vw, 36rem);
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 255, 255, 0.32);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.86);
  color: #fff;
  padding: 1.5rem;
  text-align: center;
}

.try-on-exit {
  position: absolute;
  left: 2rem;
  top: 2rem;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  color: #111827;
  font-weight: 700;
  padding: 0.85rem 1.25rem;
}
</style>
