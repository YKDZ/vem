<script setup lang="ts">
import { formatMachineSlotCoordinate } from "@vem/shared";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { MachineCatalogVariantCandidate } from "@/types/catalog";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";
import { formatCents } from "@/utils/format";

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();
const selectedVariantId = ref<string | null>(null);

const catalogKey = computed(() => String(route.params.catalogKey ?? ""));
const item = computed(() => {
  const catalogItem = catalogStore.itemByCatalogKey(catalogKey.value);
  if (catalogItem) return catalogItem;
  if (checkoutStore.selectedItem?.catalogKey === catalogKey.value) {
    return checkoutStore.selectedItem;
  }
  return null;
});
const variantCandidates = computed(() => item.value?.variantCandidates ?? []);
const defaultVariant = computed(
  () =>
    variantCandidates.value.find(
      (variant) =>
        variant.slotSalesState === "sale_ready" && variant.saleableStock > 0,
    ) ??
    variantCandidates.value[0] ??
    null,
);
const selectedVariant = computed(
  () =>
    variantCandidates.value.find(
      (variant) => variant.variantId === selectedVariantId.value,
    ) ?? defaultVariant.value,
);
const selectedConcreteItem = computed(() => {
  if (!item.value || !selectedVariant.value) return null;
  return catalogStore.saleableVariantItemFor(
    item.value.catalogKey,
    selectedVariant.value.variantId,
  );
});

watch(
  item,
  () => {
    if (!selectedVariantId.value) {
      selectedVariantId.value = defaultVariant.value?.variantId ?? null;
      return;
    }
    const stillExists = variantCandidates.value.some(
      (variant) => variant.variantId === selectedVariantId.value,
    );
    if (!stillExists) {
      selectedVariantId.value = defaultVariant.value?.variantId ?? null;
    }
  },
  { immediate: true },
);

const sizeOptions = computed(() => {
  const options = new Map<
    string,
    { value: string | null; label: string; saleableStock: number }
  >();
  for (const variant of variantCandidates.value) {
    const key = attributeKey(variant.size);
    const current = options.get(key);
    options.set(key, {
      value: variant.size,
      label: variant.size ?? "默认尺码",
      saleableStock: (current?.saleableStock ?? 0) + variant.saleableStock,
    });
  }
  return [...options.values()];
});
const styleOptions = computed(() => {
  const activeSize = selectedVariant.value?.size ?? null;
  const options = new Map<
    string,
    { value: string | null; label: string; saleableStock: number }
  >();
  for (const variant of variantCandidates.value.filter(
    (candidate) => candidate.size === activeSize,
  )) {
    const key = attributeKey(variant.color);
    const current = options.get(key);
    options.set(key, {
      value: variant.color,
      label: variant.color ?? "默认样式",
      saleableStock: (current?.saleableStock ?? 0) + variant.saleableStock,
    });
  }
  return [...options.values()];
});
const showSizeSelector = computed(
  () => sizeOptions.value.length > 1 || Boolean(sizeOptions.value[0]?.value),
);
const showStyleSelector = computed(
  () => styleOptions.value.length > 1 || Boolean(styleOptions.value[0]?.value),
);
const specText = computed(() => {
  const variant = selectedVariant.value;
  if (!variant) return "-";
  return (
    [variant.size, variant.color].filter(Boolean).join(" / ") || variant.sku
  );
});
const slotLabel = computed(() => {
  const variant = selectedVariant.value;
  const concrete = selectedConcreteItem.value;
  if (!variant) return "-";
  if (variant.slotCandidates.length > 1) {
    return `多格口 · ${variant.slotCandidates.length}处`;
  }
  const candidate = concrete ?? variant.slotCandidates[0];
  return candidate ? formatMachineSlotCoordinate(candidate) : "-";
});
const selectedCoverImageUrl = computed(
  () => selectedConcreteItem.value?.coverImageUrl ?? item.value?.coverImageUrl,
);
const heroStyle = computed(() => {
  const seed =
    selectedVariant.value?.color ??
    selectedVariant.value?.size ??
    selectedVariant.value?.sku ??
    item.value?.productName ??
    "product";
  const hue = hueFromText(seed);
  return {
    background: `linear-gradient(135deg, hsl(${hue} 76% 72%), hsl(${(hue + 44) % 360} 78% 48%))`,
  };
});
const canBuy = computed(
  () =>
    Boolean(selectedConcreteItem.value) &&
    selectedVariant.value?.slotSalesState === "sale_ready" &&
    (selectedVariant.value?.saleableStock ?? 0) > 0,
);

onMounted(async () => {
  if (!item.value) {
    await router.replace("/catalog");
  }
});

function attributeKey(value: string | null): string {
  return value ?? "__default__";
}

function hueFromText(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return hash;
}

function variantIsSaleable(variant: MachineCatalogVariantCandidate): boolean {
  return variant.slotSalesState === "sale_ready" && variant.saleableStock > 0;
}

function pickVariant(candidates: MachineCatalogVariantCandidate[]): void {
  selectedVariantId.value =
    candidates.find(variantIsSaleable)?.variantId ??
    candidates[0]?.variantId ??
    selectedVariantId.value;
}

function selectSize(size: string | null): void {
  const currentStyle = selectedVariant.value?.color ?? null;
  const candidates = variantCandidates.value.filter(
    (variant) => variant.size === size,
  );
  const preferred = candidates.find(
    (variant) => variant.color === currentStyle && variantIsSaleable(variant),
  );
  pickVariant(preferred ? [preferred] : candidates);
}

function selectStyle(style: string | null): void {
  const currentSize = selectedVariant.value?.size ?? null;
  pickVariant(
    variantCandidates.value.filter(
      (variant) => variant.size === currentSize && variant.color === style,
    ),
  );
}

async function goCheckout(): Promise<void> {
  const concreteItem = selectedConcreteItem.value;
  if (!concreteItem || !canBuy.value) return;
  checkoutStore.selectItem(concreteItem);
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
          class="relative flex aspect-square max-h-[42vh] overflow-hidden rounded-[2rem]"
        >
          <img
            v-if="selectedCoverImageUrl"
            :key="selectedVariant?.variantId"
            class="h-full w-full object-cover"
            :src="selectedCoverImageUrl"
            :alt="`${item.productName} ${specText}`"
          />
          <div
            v-else
            :key="selectedVariant?.variantId"
            class="flex h-full w-full flex-col items-center justify-center p-8 text-center text-slate-950"
            :style="heroStyle"
          >
            <span class="text-7xl font-black">{{
              item.productName.slice(0, 2)
            }}</span>
            <span
              class="mt-5 rounded-full bg-white/55 px-5 py-2 text-xl font-black"
            >
              {{ specText }}
            </span>
          </div>
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
              {{ slotLabel }}
            </span>
          </div>

          <section v-if="showSizeSelector" class="space-y-3">
            <p class="text-sm font-bold text-slate-300">选择尺码</p>
            <div class="grid grid-cols-3 gap-3">
              <button
                v-for="option in sizeOptions"
                :key="attributeKey(option.value)"
                class="kiosk-touch-target rounded-2xl border px-4 py-3 text-center font-black"
                :class="
                  selectedVariant?.size === option.value
                    ? 'border-sky-300 bg-sky-300/20 text-white'
                    : 'border-white/15 bg-slate-950/35 text-slate-200'
                "
                type="button"
                :disabled="option.saleableStock <= 0"
                @click="selectSize(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </section>

          <section v-if="showStyleSelector" class="space-y-3">
            <p class="text-sm font-bold text-slate-300">选择样式</p>
            <div class="grid grid-cols-3 gap-3">
              <button
                v-for="option in styleOptions"
                :key="attributeKey(option.value)"
                class="kiosk-touch-target rounded-2xl border px-4 py-3 text-center font-black"
                :class="
                  selectedVariant?.color === option.value
                    ? 'border-sky-300 bg-sky-300/20 text-white'
                    : 'border-white/15 bg-slate-950/35 text-slate-200'
                "
                type="button"
                :disabled="option.saleableStock <= 0"
                @click="selectStyle(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </section>

          <dl class="grid grid-cols-2 gap-3 text-lg">
            <div class="rounded-2xl bg-slate-950/40 p-4">
              <dt class="text-sm text-slate-400">规格</dt>
              <dd class="mt-1 font-bold">{{ specText }}</dd>
            </div>
            <div class="rounded-2xl bg-slate-950/40 p-4">
              <dt class="text-sm text-slate-400">库存</dt>
              <dd class="mt-1 font-bold">
                可售 {{ selectedVariant?.saleableStock ?? 0 }}
              </dd>
            </div>
          </dl>

          <div
            class="flex items-center justify-between rounded-3xl bg-slate-950/50 p-5"
          >
            <span class="text-slate-300">支付金额</span>
            <strong class="text-4xl font-black text-sky-200">
              {{ formatCents(selectedVariant?.priceCents ?? item.priceCents) }}
            </strong>
          </div>
        </div>
      </div>

      <button
        class="kiosk-touch-target mt-auto rounded-3xl bg-sky-400 px-6 py-5 text-2xl font-black text-slate-950 shadow-xl shadow-sky-950/40 disabled:bg-slate-500 disabled:text-slate-300"
        type="button"
        :disabled="!canBuy"
        @click="goCheckout"
      >
        {{ canBuy ? "立即购买" : "该规格暂不可购买" }}
      </button>
    </section>
  </KioskLayout>
</template>
