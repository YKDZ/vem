<script setup lang="ts">
import type { VisionProfile } from "@vem/shared";

import { computed, ref, watch } from "vue";

import type {
  MachineCatalogItem,
  MachineCatalogVariantCandidate,
} from "@/types/catalog";

import { inferSize } from "@/recommendation/engine";
import { useCatalogStore } from "@/stores/catalog";
import { formatCents } from "@/utils/format";

const props = defineProps<{
  item: MachineCatalogItem;
  profile?: VisionProfile | null;
}>();

const emit = defineEmits<{
  purchase: [item: MachineCatalogItem];
}>();

type VariantOption = {
  value: string | null;
  label: string;
  saleableStock: number;
};

const catalogStore = useCatalogStore();
const selectedVariantId = ref<string | null>(null);

const variantCandidates = computed(() => props.item.variantCandidates);
const selectedVariant = computed(
  () =>
    variantCandidates.value.find(
      (variant) => variant.variantId === selectedVariantId.value,
    ) ??
    chooseInitialVariant() ??
    null,
);
const selectedConcreteItem = computed(() => {
  const variant = selectedVariant.value;
  if (!variant) return null;
  return (
    catalogStore.saleableVariantItemFor(
      props.item.catalogKey,
      variant.variantId,
    ) ??
    (props.item.variantId === variant.variantId &&
    props.item.slotSalesState === "sale_ready" &&
    props.item.saleableStock > 0
      ? props.item
      : null)
  );
});
const selectedCoverImageUrl = computed(
  () => selectedConcreteItem.value?.coverImageUrl ?? props.item.coverImageUrl,
);
const specText = computed(() => {
  const variant = selectedVariant.value;
  if (!variant) return "-";
  return (
    [variant.size, variant.color].filter(Boolean).join(" / ") || variant.sku
  );
});
const canBuy = computed(
  () =>
    Boolean(selectedConcreteItem.value) &&
    selectedVariant.value?.slotSalesState === "sale_ready" &&
    (selectedVariant.value?.saleableStock ?? 0) > 0,
);
const sizeOptions = computed(() =>
  uniqueVariantOptions(
    variantCandidates.value,
    (variant) => variant.size,
    "默认尺码",
  ),
);
const colorOptions = computed(() => {
  const activeSize = selectedVariant.value?.size ?? null;
  return uniqueVariantOptions(
    variantCandidates.value.filter((variant) => variant.size === activeSize),
    (variant) => variant.color,
    "默认颜色",
  );
});
const showSizeSelector = computed(
  () => sizeOptions.value.length > 1 || Boolean(sizeOptions.value[0]?.value),
);
const showColorSelector = computed(
  () => colorOptions.value.length > 1 || Boolean(colorOptions.value[0]?.value),
);

watch(
  [
    () => props.item.catalogKey,
    () => props.profile?.heightCm,
    () => props.profile?.bodyType,
    () => props.profile?.upperColor,
  ],
  () => {
    selectedVariantId.value = chooseInitialVariant()?.variantId ?? null;
  },
  { immediate: true },
);

watch(variantCandidates, () => {
  if (
    selectedVariantId.value &&
    variantCandidates.value.some(
      (variant) => variant.variantId === selectedVariantId.value,
    )
  ) {
    return;
  }
  selectedVariantId.value = chooseInitialVariant()?.variantId ?? null;
});

function variantIsSaleable(variant: MachineCatalogVariantCandidate): boolean {
  return variant.slotSalesState === "sale_ready" && variant.saleableStock > 0;
}

function candidatePool(): readonly MachineCatalogVariantCandidate[] {
  const saleable = variantCandidates.value.filter(variantIsSaleable);
  return saleable.length ? saleable : variantCandidates.value;
}

function normalizeAttribute(value: string | null | undefined): string {
  return (value ?? "").toLocaleLowerCase().replace(/\s+/g, "");
}

function matchesColor(
  variant: MachineCatalogVariantCandidate,
  preferredColor: string | undefined,
): boolean {
  const color = normalizeAttribute(variant.color);
  const preferred = normalizeAttribute(preferredColor);
  return Boolean(color && preferred && color.includes(preferred));
}

function randomVariant(
  variants: readonly MachineCatalogVariantCandidate[],
): MachineCatalogVariantCandidate | null {
  if (variants.length === 0) return null;
  return variants[Math.floor(Math.random() * variants.length)] ?? null;
}

function chooseInitialVariant(): MachineCatalogVariantCandidate | null {
  const variants = candidatePool();
  const preferredSize = inferSize(
    props.profile?.heightCm ?? undefined,
    props.profile?.bodyType,
  );
  const sizeMatches = preferredSize
    ? variants.filter((variant) => variant.size === preferredSize)
    : [];
  const sizePool = sizeMatches.length ? sizeMatches : variants;
  const colorMatch = sizePool.find((variant) =>
    matchesColor(variant, props.profile?.upperColor),
  );
  return colorMatch ?? randomVariant(sizePool);
}

function attributeKey(value: string | null): string {
  return value ?? "__default__";
}

function uniqueVariantOptions(
  variants: readonly MachineCatalogVariantCandidate[],
  valueFor: (variant: MachineCatalogVariantCandidate) => string | null,
  fallbackLabel: string,
): VariantOption[] {
  const options = new Map<string, VariantOption>();
  for (const variant of variants) {
    const value = valueFor(variant);
    const key = attributeKey(value);
    const current = options.get(key);
    options.set(key, {
      value,
      label: value ?? fallbackLabel,
      saleableStock: (current?.saleableStock ?? 0) + variant.saleableStock,
    });
  }
  return [...options.values()];
}

function pickVariant(candidates: MachineCatalogVariantCandidate[]): void {
  selectedVariantId.value =
    candidates.find(variantIsSaleable)?.variantId ??
    candidates[0]?.variantId ??
    selectedVariantId.value;
}

function selectSize(size: string | null): void {
  const currentColor = selectedVariant.value?.color ?? null;
  const candidates = variantCandidates.value.filter(
    (variant) => variant.size === size,
  );
  const preferred = candidates.find(
    (variant) => variant.color === currentColor && variantIsSaleable(variant),
  );
  pickVariant(preferred ? [preferred] : candidates);
}

function selectColor(color: string | null): void {
  const currentSize = selectedVariant.value?.size ?? null;
  pickVariant(
    variantCandidates.value.filter(
      (variant) => variant.size === currentSize && variant.color === color,
    ),
  );
}

function purchase(): void {
  const concreteItem = selectedConcreteItem.value;
  if (!concreteItem || !canBuy.value) return;
  emit("purchase", concreteItem);
}
</script>

<template>
  <aside
    class="flex h-full min-h-0 flex-col rounded-lg border border-neutral-200 bg-white p-5"
  >
    <div class="min-h-0 flex-1 overflow-y-auto pr-1">
      <div class="h-[300px] overflow-hidden rounded-lg bg-neutral-100">
        <img
          v-if="selectedCoverImageUrl"
          :src="selectedCoverImageUrl"
          :alt="`${item.productName} ${specText}`"
          class="h-full w-full object-cover"
        />
        <div
          v-else
          class="flex h-full w-full items-center justify-center px-6 text-center text-3xl font-black text-neutral-400"
        >
          {{ item.productName }}
        </div>
      </div>

      <div class="mt-5">
        <p class="text-sm text-neutral-500">
          {{ item.categoryName ?? "商品" }}
        </p>
        <h2 class="mt-1 text-3xl leading-tight font-black text-neutral-950">
          {{ item.productName }}
        </h2>
        <p class="mt-3 leading-relaxed text-base text-neutral-600">
          {{ item.productDescription ?? "请选择颜色和尺码后下单。" }}
        </p>
      </div>

      <section v-if="showColorSelector" class="mt-6">
        <h3 class="text-sm font-bold text-neutral-600">颜色</h3>
        <div class="kiosk-scroll mt-3 flex gap-2 overflow-x-auto pb-1">
          <button
            v-for="option in colorOptions"
            :key="attributeKey(option.value)"
            class="kiosk-touch-target shrink-0 rounded-lg border px-4 py-2 font-bold text-base disabled:opacity-35"
            :class="
              selectedVariant?.color === option.value
                ? 'border-neutral-950 bg-neutral-950 text-white'
                : 'border-neutral-200 bg-white text-neutral-950'
            "
            type="button"
            :disabled="option.saleableStock <= 0"
            @click="selectColor(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </section>

      <section v-if="showSizeSelector" class="mt-6">
        <h3 class="text-sm font-bold text-neutral-600">尺码</h3>
        <div class="kiosk-scroll mt-3 flex gap-2 overflow-x-auto pb-1">
          <button
            v-for="option in sizeOptions"
            :key="attributeKey(option.value)"
            class="kiosk-touch-target shrink-0 rounded-lg border px-5 py-2 font-black text-base disabled:opacity-35"
            :class="
              selectedVariant?.size === option.value
                ? 'border-neutral-950 bg-neutral-950 text-white'
                : 'border-neutral-200 bg-white text-neutral-950'
            "
            type="button"
            :disabled="option.saleableStock <= 0"
            @click="selectSize(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </section>
    </div>

    <div class="mt-5 shrink-0 border-t border-neutral-200 pt-5">
      <div class="flex items-end justify-between gap-4">
        <span class="text-sm text-neutral-500">支付金额</span>
        <strong class="text-3xl font-black text-neutral-950">
          {{ formatCents(selectedVariant?.priceCents ?? item.priceCents) }}
        </strong>
      </div>
      <button
        class="kiosk-touch-target mt-4 w-full rounded-lg bg-neutral-950 px-5 py-4 text-xl font-black text-white disabled:bg-neutral-300 disabled:text-neutral-500"
        type="button"
        :disabled="!canBuy"
        @click="purchase"
      >
        {{ canBuy ? "下单" : "该规格暂不可购买" }}
      </button>
    </div>
  </aside>
</template>
