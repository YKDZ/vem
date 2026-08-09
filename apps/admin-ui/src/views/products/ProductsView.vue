<script setup lang="ts">
import type { ProductStatus, TryOnGarmentMediaAsset } from "@vem/shared";

import { PictureOutlined } from "@antdv-next/icons";
import { isAxiosError } from "axios";
import { onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";

import {
  createProduct,
  createProductVariant,
  listProductVariants,
  listProducts,
  updateProduct,
  updateProductVariant,
  uploadProductDisplayImage,
  type PageResult,
  type Product,
  type ProductVariant,
} from "@/api/products";
import {
  activateTryOnGarment,
  confirmTryOnGarment,
  createTryOnGarmentDraft,
  listTryOnGarmentsByProduct,
  replaceTryOnGarmentSource,
  replaceTryOnGarmentVariantAssociations,
  retireTryOnGarment,
  uploadTryOnGarment,
  type TryOnGarmentResponse,
} from "@/api/try-on-garments";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

import {
  mapProductFormToContract,
  mapProductResponseToForm,
  mapVariantFormToContract,
  mapVariantResponseToForm,
  type ProductForm,
  type VariantForm,
} from "./product-contract-mappers";

const authStore = useAuthStore();
const canWrite = authStore.hasPermission("products.write");
const route = useRoute();

const loading = ref(false);
const products = ref<PageResult<Product>>({
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
});
const filterKeyword = ref("");
const filterStatus = ref<ProductStatus | undefined>(undefined);

function syncFiltersFromRoute(): void {
  const query = route.query.q;
  filterKeyword.value = typeof query === "string" ? query : "";
}

async function loadProducts(page = 1): Promise<void> {
  loading.value = true;
  try {
    products.value = await listProducts({
      keyword: filterKeyword.value || undefined,
      status: filterStatus.value,
      page,
      pageSize: 20,
    });
  } finally {
    loading.value = false;
  }
}

// Product form / drawer
const productDrawerOpen = ref(false);
const editingProduct = ref<Product | null>(null);
const productForm = ref<ProductForm>({
  name: "",
  description: "",
  displayImageMediaAssetId: null,
  displayImagePublicUrl: null,
  status: "draft",
  sortOrder: 0,
});
const productSaving = ref(false);
const productImageUploading = ref(false);
const productImageInput = ref<HTMLInputElement | null>(null);
const productImageLoadFailed = ref(false);

function openCreateProduct(): void {
  editingProduct.value = null;
  productForm.value = {
    name: "",
    description: "",
    displayImageMediaAssetId: null,
    displayImagePublicUrl: null,
    status: "draft",
    sortOrder: 0,
  };
  productImageLoadFailed.value = false;
  productDrawerOpen.value = true;
}

function openEditProduct(p: Product): void {
  editingProduct.value = p;
  productForm.value = mapProductResponseToForm(p);
  productImageLoadFailed.value = false;
  productDrawerOpen.value = true;
}

async function onProductDisplayImageSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  productImageUploading.value = true;
  try {
    const asset = await uploadProductDisplayImage(file);
    productForm.value.displayImageMediaAssetId = asset.id;
    productForm.value.displayImagePublicUrl = asset.publicUrl;
    productImageLoadFailed.value = false;
  } finally {
    productImageUploading.value = false;
  }
}

function clearProductDisplayImage(): void {
  productForm.value.displayImageMediaAssetId = null;
  productForm.value.displayImagePublicUrl = null;
}

async function saveProduct(): Promise<void> {
  productSaving.value = true;
  try {
    const body = mapProductFormToContract(productForm.value);
    if (editingProduct.value) {
      await updateProduct(editingProduct.value.id, body);
    } else {
      await createProduct(body);
    }
    productDrawerOpen.value = false;
    await loadProducts();
  } finally {
    productSaving.value = false;
  }
}

// Try-On Garment draft
const tryOnGarmentModalOpen = ref(false);
const tryOnGarmentProduct = ref<Product | null>(null);
const tryOnGarmentAsset = ref<TryOnGarmentMediaAsset | null>(null);
const tryOnGarmentDraft = ref<TryOnGarmentResponse | null>(null);
const tryOnGarmentChoices = ref<TryOnGarmentResponse[]>([]);
const tryOnGarmentChoiceId = ref<string | undefined>(undefined);
const tryOnGarmentColorLabel = ref("");
const tryOnGarmentTemplate = ref<"tshirt_short_sleeve" | "tshirt_long_sleeve">(
  "tshirt_short_sleeve",
);
const tryOnGarmentInput = ref<HTMLInputElement | null>(null);
const tryOnGarmentUploading = ref(false);
const tryOnGarmentSaving = ref(false);
const tryOnGarmentConfirming = ref(false);
const tryOnGarmentActivating = ref(false);
const tryOnGarmentAssociating = ref(false);
const tryOnGarmentRetiring = ref(false);
const tryOnGarmentVariantIds = ref<string[]>([]);
const tryOnGarmentVariants = ref<ProductVariant[]>([]);
const tryOnGarmentPreviewFailed = ref(false);
const tryOnGarmentPreviewReady = ref(false);
const tryOnGarmentFeedback = ref("");

async function openTryOnGarmentDraft(product: Product): Promise<void> {
  tryOnGarmentProduct.value = product;
  tryOnGarmentAsset.value = null;
  tryOnGarmentDraft.value = null;
  tryOnGarmentChoices.value = [];
  tryOnGarmentChoiceId.value = undefined;
  tryOnGarmentColorLabel.value = "";
  tryOnGarmentTemplate.value = "tshirt_short_sleeve";
  tryOnGarmentPreviewFailed.value = false;
  tryOnGarmentPreviewReady.value = false;
  tryOnGarmentVariantIds.value = [];
  tryOnGarmentVariants.value = [];
  tryOnGarmentFeedback.value = "上传透明 PNG 后，系统会显示确定性校验结果。";
  tryOnGarmentModalOpen.value = true;
  try {
    const [variants, garments] = await Promise.all([
      listProductVariants(product.id),
      listTryOnGarmentsByProduct(product.id),
    ]);
    tryOnGarmentVariants.value = variants.items;
    tryOnGarmentChoices.value = garments;
    const existing = garments.at(-1);
    if (existing) selectTryOnGarment(existing.id);
  } catch (error) {
    tryOnGarmentFeedback.value = `无法恢复试衣源：${errorMessage(error)}`;
  }
}

function selectTryOnGarment(id: string): void {
  const garment = tryOnGarmentChoices.value.find((item) => item.id === id);
  if (!garment) return;
  tryOnGarmentChoiceId.value = id;
  tryOnGarmentDraft.value = garment;
  tryOnGarmentAsset.value = garment.sourceMediaAsset;
  tryOnGarmentColorLabel.value = garment.colorLabel;
  tryOnGarmentTemplate.value = garment.template;
  tryOnGarmentVariantIds.value = [...garment.associatedVariantIds];
  tryOnGarmentPreviewFailed.value = false;
  tryOnGarmentPreviewReady.value = true;
  tryOnGarmentFeedback.value = "已从服务端恢复共享试衣源。";
}

async function onTryOnGarmentSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  tryOnGarmentUploading.value = true;
  tryOnGarmentFeedback.value = "正在校验 PNG、尺寸和透明背景…";
  try {
    const asset = await uploadTryOnGarment(file);
    tryOnGarmentAsset.value = asset;
    if (tryOnGarmentDraft.value) {
      tryOnGarmentDraft.value = await replaceTryOnGarmentSource(
        tryOnGarmentDraft.value.id,
        asset.id,
        tryOnGarmentTemplate.value,
      );
    }
    tryOnGarmentPreviewFailed.value = false;
    tryOnGarmentPreviewReady.value = false;
    tryOnGarmentFeedback.value = [
      "校验通过：透明 PNG。",
      `尺寸 ${asset.width} × ${asset.height}，${asset.byteSize} bytes。`,
      `SHA-256: ${asset.sha256}`,
      tryOnGarmentDraft.value
        ? "新来源已原子替换，所有已关联规格同步观察该来源。"
        : "",
    ].join(" ");
  } catch (error) {
    tryOnGarmentFeedback.value = `校验失败：${errorMessage(error)}`;
  } finally {
    tryOnGarmentUploading.value = false;
  }
}

function onTryOnGarmentPreviewLoaded(event: Event): void {
  const image = event.currentTarget as HTMLImageElement;
  tryOnGarmentPreviewReady.value =
    image.naturalWidth > 0 && image.naturalHeight > 0;
  tryOnGarmentPreviewFailed.value = !tryOnGarmentPreviewReady.value;
}

function onTryOnGarmentPreviewFailed(): void {
  tryOnGarmentPreviewReady.value = false;
  tryOnGarmentPreviewFailed.value = true;
}

async function saveTryOnGarmentDraft(): Promise<void> {
  const product = tryOnGarmentProduct.value;
  const asset = tryOnGarmentAsset.value;
  if (!product || !asset) return;

  tryOnGarmentSaving.value = true;
  try {
    tryOnGarmentDraft.value = await createTryOnGarmentDraft({
      productId: product.id,
      colorLabel: tryOnGarmentColorLabel.value,
      sourceMediaAssetId: asset.id,
      template: tryOnGarmentTemplate.value,
    });
    tryOnGarmentFeedback.value = "草稿已创建。请核对预览后显式确认来源。";
  } catch (error) {
    tryOnGarmentFeedback.value = `创建失败：${errorMessage(error)}`;
  } finally {
    tryOnGarmentSaving.value = false;
  }
}

async function confirmTryOnGarmentSource(): Promise<void> {
  const draft = tryOnGarmentDraft.value;
  if (!draft) return;

  tryOnGarmentConfirming.value = true;
  try {
    tryOnGarmentDraft.value = await confirmTryOnGarment(draft.id);
    tryOnGarmentFeedback.value =
      "来源已确认。请显式激活并选择共享的尺码规格后才会进入机器资格集合。";
  } catch (error) {
    tryOnGarmentFeedback.value = `确认失败：${errorMessage(error)}`;
  } finally {
    tryOnGarmentConfirming.value = false;
  }
}

async function activateTryOnGarmentDraft(): Promise<void> {
  const draft = tryOnGarmentDraft.value;
  if (!draft) return;
  tryOnGarmentActivating.value = true;
  try {
    tryOnGarmentDraft.value = await activateTryOnGarment(draft.id);
    tryOnGarmentFeedback.value =
      "Garment 已激活；请选择同一商品下受影响的尺码规格。";
  } catch (error) {
    tryOnGarmentFeedback.value = `激活失败：${errorMessage(error)}`;
  } finally {
    tryOnGarmentActivating.value = false;
  }
}

async function saveTryOnGarmentAssociations(): Promise<void> {
  const draft = tryOnGarmentDraft.value;
  if (!draft) return;
  tryOnGarmentAssociating.value = true;
  try {
    tryOnGarmentDraft.value = await replaceTryOnGarmentVariantAssociations(
      draft.id,
      tryOnGarmentVariantIds.value,
    );
    const affected = tryOnGarmentVariants.value
      .filter((variant) => tryOnGarmentVariantIds.value.includes(variant.id))
      .map(
        (variant) =>
          `${variant.sku}${variant.size ? `（${variant.size}）` : ""}`,
      )
      .join("、");
    tryOnGarmentFeedback.value = `已原子关联 ${affected || "0"}；只有这些显式规格可试穿。`;
  } catch (error) {
    tryOnGarmentFeedback.value = `关联失败：${errorMessage(error)}`;
  } finally {
    tryOnGarmentAssociating.value = false;
  }
}

async function retireTryOnGarmentDraft(): Promise<void> {
  const draft = tryOnGarmentDraft.value;
  if (!draft) return;
  tryOnGarmentRetiring.value = true;
  try {
    tryOnGarmentDraft.value = await retireTryOnGarment(draft.id);
    tryOnGarmentFeedback.value =
      "Garment 已退休；所有关联规格即时失去试穿资格。";
  } catch (error) {
    tryOnGarmentFeedback.value = `退休失败：${errorMessage(error)}`;
  } finally {
    tryOnGarmentRetiring.value = false;
  }
}

function errorMessage(error: unknown): string {
  if (isAxiosError<{ message?: unknown }>(error)) {
    const message = error.response?.data?.message;
    if (typeof message === "string" && message) return message;
  }
  return error instanceof Error ? error.message : "请求失败";
}

function isTryOnGarmentFeedbackError(): boolean {
  return /^(无法|校验失败|创建失败|确认失败|激活失败|关联失败|退休失败)/.test(
    tryOnGarmentFeedback.value,
  );
}

// Variants
const variantDrawerOpen = ref(false);
const currentProductId = ref<string | null>(null);
const variants = ref<ProductVariant[]>([]);
const variantsLoading = ref(false);
const editingVariant = ref<ProductVariant | null>(null);
const variantFormOpen = ref(false);
const variantForm = ref<VariantForm>({
  productId: "",
  sku: "",
  priceCents: 0,
  costCents: 0,
  status: "active",
  size: "",
  color: "",
  barcode: "",
  targetGender: null,
});
const variantSaving = ref(false);

async function openVariants(p: Product): Promise<void> {
  currentProductId.value = p.id;
  variantDrawerOpen.value = true;
  variantsLoading.value = true;
  try {
    const result = await listProductVariants(p.id);
    variants.value = result.items;
  } finally {
    variantsLoading.value = false;
  }
}

function openCreateVariant(): void {
  editingVariant.value = null;
  variantForm.value = {
    productId: currentProductId.value ?? "",
    sku: "",
    priceCents: 0,
    costCents: 0,
    status: "active",
    size: "",
    color: "",
    barcode: "",
    targetGender: null,
  };
  variantFormOpen.value = true;
}

function openEditVariant(v: ProductVariant): void {
  editingVariant.value = v;
  variantForm.value = mapVariantResponseToForm(v);
  variantFormOpen.value = true;
}

async function saveVariant(): Promise<void> {
  variantSaving.value = true;
  try {
    const body = mapVariantFormToContract(variantForm.value);
    if (editingVariant.value) {
      await updateProductVariant(editingVariant.value.id, body);
    } else {
      await createProductVariant(body);
    }
    variantFormOpen.value = false;
    if (currentProductId.value) {
      const result = await listProductVariants(currentProductId.value);
      variants.value = result.items;
    }
  } finally {
    variantSaving.value = false;
  }
}

const statusColor: Record<string, string> = {
  draft: "default",
  active: "success",
  inactive: "warning",
};

const productColumns = [
  { title: "商品名称", dataIndex: "name", key: "name" },
  { title: "状态", dataIndex: "status", key: "status" },
  { title: "排序", dataIndex: "sortOrder", key: "sortOrder" },
  { title: "创建时间", dataIndex: "createdAt", key: "createdAt" },
  { title: "操作", key: "actions" },
];

const variantColumns = [
  { title: "SKU", dataIndex: "sku", key: "sku" },
  { title: "尺码", dataIndex: "size", key: "size" },
  { title: "颜色", dataIndex: "color", key: "color" },
  { title: "目标性别", dataIndex: "targetGender", key: "targetGender" },
  { title: "价格(分)", dataIndex: "priceCents", key: "priceCents" },
  { title: "状态", dataIndex: "status", key: "status" },
  ...(canWrite ? [{ title: "操作", key: "actions" }] : []),
];

onMounted(() => {
  syncFiltersFromRoute();
  void loadProducts();
});

watch(
  () => route.query.q,
  () => {
    syncFiltersFromRoute();
    void loadProducts();
  },
);
</script>

<template>
  <section class="space-y-4">
    <a-card>
      <div class="mb-4 flex gap-3">
        <a-input
          v-model:value="filterKeyword"
          placeholder="商品名称 / SKU / 条码"
          class="max-w-48"
          @press-enter="loadProducts()"
        />
        <a-select
          v-model:value="filterStatus"
          placeholder="状态"
          allow-clear
          class="min-w-24"
          @change="loadProducts()"
        >
          <a-select-option value="draft">草稿</a-select-option>
          <a-select-option value="active">上架</a-select-option>
          <a-select-option value="inactive">下架</a-select-option>
        </a-select>
        <a-button @click="loadProducts()">查询</a-button>
        <a-button v-if="canWrite" type="primary" @click="openCreateProduct">
          新增商品
        </a-button>
      </div>
      <a-table
        :columns="productColumns"
        :data-source="products.items"
        row-key="id"
        :loading="loading"
        :pagination="{
          current: products.page,
          pageSize: products.pageSize,
          total: products.total,
          onChange: loadProducts,
        }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="statusColor[record.status] ?? 'default'">{{
              record.status
            }}</a-tag>
          </template>
          <template v-else-if="column.key === 'createdAt'">
            {{ formatDateTime(record.createdAt) }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-space>
              <a-button size="small" @click="openVariants(record)"
                >SKU</a-button
              >
              <a-button
                v-if="canWrite"
                size="small"
                @click="openTryOnGarmentDraft(record)"
              >
                新增试衣源
              </a-button>
              <a-button
                v-if="canWrite"
                size="small"
                @click="openEditProduct(record)"
              >
                编辑
              </a-button>
            </a-space>
          </template>
        </template>
      </a-table>
    </a-card>

    <!-- Product drawer -->
    <a-drawer
      v-model:open="productDrawerOpen"
      :title="editingProduct ? '编辑商品' : '新增商品'"
      :destroy-on-hidden="true"
      size="min(480px, 100vw)"
      class="catalog-drawer"
      @close="productDrawerOpen = false"
    >
      <a-form layout="vertical" :preserve="false">
        <a-form-item label="商品名称">
          <a-input v-model:value="productForm.name" />
        </a-form-item>
        <a-form-item label="描述">
          <a-textarea v-model:value="productForm.description" :rows="3" />
        </a-form-item>
        <a-form-item label="展示图">
          <div class="min-w-0 space-y-3">
            <img
              v-if="
                productForm.displayImagePublicUrl && !productImageLoadFailed
              "
              class="h-32 w-32 rounded border border-slate-200 object-cover"
              :src="productForm.displayImagePublicUrl"
              :alt="productForm.name || '商品展示图'"
              @error="productImageLoadFailed = true"
            />
            <div
              v-else
              class="flex h-32 w-32 flex-col items-center justify-center gap-2 rounded border border-dashed border-slate-300 bg-slate-50 text-slate-400"
            >
              <PictureOutlined class="text-xl" />
              <span class="text-xs">暂无商品图</span>
            </div>
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <input
                ref="productImageInput"
                class="hidden"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                @change="onProductDisplayImageSelected"
              />
              <a-button
                :loading="productImageUploading"
                @click="productImageInput?.click()"
              >
                上传图片
              </a-button>
              <a-button
                v-if="productForm.displayImageMediaAssetId"
                danger
                @click="clearProductDisplayImage"
              >
                清除
              </a-button>
            </div>
            <p class="text-xs leading-5 text-slate-500">
              支持 PNG、JPEG、WebP，单个文件不超过 5 MB。
            </p>
          </div>
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="productForm.status">
            <a-select-option value="draft">草稿</a-select-option>
            <a-select-option value="active">上架</a-select-option>
            <a-select-option value="inactive">下架</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="排序">
          <a-input-number
            v-model:value="productForm.sortOrder"
            :min="0"
            class="w-full"
          />
        </a-form-item>
        <a-button type="primary" :loading="productSaving" @click="saveProduct">
          保存
        </a-button>
      </a-form>
    </a-drawer>

    <!-- Variants drawer -->
    <a-drawer
      v-model:open="variantDrawerOpen"
      title="SKU 列表"
      size="min(760px, 100vw)"
      :destroy-on-hidden="true"
      class="catalog-drawer"
    >
      <div class="mb-3">
        <a-button v-if="canWrite" type="primary" @click="openCreateVariant">
          新增 SKU
        </a-button>
      </div>
      <a-table
        :columns="variantColumns"
        :data-source="variants"
        row-key="id"
        :loading="variantsLoading"
        :pagination="false"
        :scroll="{ x: 680 }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'status'">
            <a-tag :color="statusColor[record.status] ?? 'default'">{{
              record.status
            }}</a-tag>
          </template>
          <template v-else-if="column.key === 'actions'">
            <a-button size="small" @click="openEditVariant(record)"
              >编辑</a-button
            >
          </template>
        </template>
      </a-table>
    </a-drawer>

    <!-- Variant form modal -->
    <a-modal
      v-model:open="variantFormOpen"
      :title="editingVariant ? '编辑 SKU' : '新增 SKU'"
      :confirm-loading="variantSaving"
      :z-index="1200"
      @ok="saveVariant"
    >
      <a-form layout="vertical">
        <a-form-item label="SKU">
          <a-input v-model:value="variantForm.sku" />
        </a-form-item>
        <a-form-item label="尺码">
          <a-input v-model:value="variantForm.size" />
        </a-form-item>
        <a-form-item label="颜色">
          <a-input v-model:value="variantForm.color" />
        </a-form-item>
        <a-form-item label="条码">
          <a-input v-model:value="variantForm.barcode" />
        </a-form-item>
        <a-form-item label="售价(分)">
          <a-input-number
            v-model:value="variantForm.priceCents"
            :min="0"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="成本(分)">
          <a-input-number
            v-model:value="variantForm.costCents"
            :min="0"
            class="w-full"
          />
        </a-form-item>
        <a-form-item label="目标性别">
          <a-select
            v-model:value="variantForm.targetGender"
            allow-clear
            placeholder="不限（留空）"
          >
            <a-select-option value="male">男款</a-select-option>
            <a-select-option value="female">女款</a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="variantForm.status">
            <a-select-option value="active">上架</a-select-option>
            <a-select-option value="inactive">下架</a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
    </a-modal>

    <a-modal
      v-model:open="tryOnGarmentModalOpen"
      title="新增 Try-On Garment 草稿"
      :footer="null"
      :destroy-on-hidden="true"
    >
      <a-form layout="vertical">
        <a-form-item label="商品">
          <a-input :value="tryOnGarmentProduct?.name" disabled />
        </a-form-item>
        <a-form-item v-if="tryOnGarmentChoices.length" label="已有试衣源">
          <a-select
            v-model:value="tryOnGarmentChoiceId"
            @change="selectTryOnGarment"
          >
            <a-select-option
              v-for="garment in tryOnGarmentChoices"
              :key="garment.id"
              :value="garment.id"
            >
              {{ garment.colorLabel }} · {{ garment.status }}
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="可见颜色">
          <a-input
            v-model:value="tryOnGarmentColorLabel"
            :disabled="Boolean(tryOnGarmentDraft)"
            placeholder="例如：海军蓝"
          />
        </a-form-item>
        <a-form-item label="T 恤模板">
          <a-select
            v-model:value="tryOnGarmentTemplate"
            :disabled="Boolean(tryOnGarmentDraft)"
          >
            <a-select-option value="tshirt_short_sleeve">
              短袖 T 恤
            </a-select-option>
            <a-select-option value="tshirt_long_sleeve">
              长袖 T 恤
            </a-select-option>
          </a-select>
        </a-form-item>
        <a-form-item label="透明 PNG 来源">
          <div class="space-y-3">
            <img
              v-if="tryOnGarmentAsset && !tryOnGarmentPreviewFailed"
              class="h-48 w-full rounded border border-slate-200 bg-slate-50 object-contain"
              :src="tryOnGarmentAsset.managedReference"
              alt="Try-On Garment 来源预览"
              @load="onTryOnGarmentPreviewLoaded"
              @error="onTryOnGarmentPreviewFailed"
            />
            <div
              v-else
              class="flex h-32 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-400"
            >
              请上传前视透明 T 恤 PNG
            </div>
            <input
              ref="tryOnGarmentInput"
              class="hidden"
              type="file"
              accept="image/png"
              @change="onTryOnGarmentSelected"
            />
            <a-button
              :loading="tryOnGarmentUploading"
              @click="tryOnGarmentInput?.click()"
            >
              上传并校验 PNG
            </a-button>
            <p class="text-xs leading-5 text-slate-500">
              仅接受透明 PNG；不会自动抠图、生成来源或运行 Fast/AI
              推理。请人工确认：正面单件服装、无人物/衣架/文字，并且预览可见后再继续。
            </p>
          </div>
        </a-form-item>
        <a-form-item
          v-if="tryOnGarmentDraft?.status === 'active'"
          label="共享尺码影响范围"
        >
          <p class="mb-2 text-xs leading-5 text-slate-500">
            仅勾选的同商品规格会获得资格；颜色、名称、SKU
            或尺码本身不会自动推断。
          </p>
          <a-checkbox-group
            v-model:value="tryOnGarmentVariantIds"
            class="flex flex-col gap-2"
          >
            <a-checkbox
              v-for="variant in tryOnGarmentVariants"
              :key="variant.id"
              :value="variant.id"
            >
              {{ variant.sku
              }}<span v-if="variant.size">（{{ variant.size }}）</span>
              <span v-if="variant.color"> · {{ variant.color }}</span>
            </a-checkbox>
          </a-checkbox-group>
        </a-form-item>
        <a-alert
          v-if="tryOnGarmentFeedback"
          :message="tryOnGarmentFeedback"
          :type="isTryOnGarmentFeedbackError() ? 'error' : 'info'"
          show-icon
          class="mb-4"
        />
        <div class="flex justify-end gap-2">
          <a-button @click="tryOnGarmentModalOpen = false">取消</a-button>
          <a-button
            v-if="!tryOnGarmentDraft"
            type="primary"
            :loading="tryOnGarmentSaving"
            :disabled="
              !tryOnGarmentAsset ||
              !tryOnGarmentPreviewReady ||
              !tryOnGarmentColorLabel.trim()
            "
            @click="saveTryOnGarmentDraft"
          >
            创建草稿
          </a-button>
          <a-button
            v-else
            type="primary"
            :loading="tryOnGarmentConfirming"
            :disabled="
              Boolean(tryOnGarmentDraft.confirmedAt) ||
              !tryOnGarmentPreviewReady
            "
            @click="confirmTryOnGarmentSource"
          >
            {{ tryOnGarmentDraft.confirmedAt ? "来源已确认" : "确认来源" }}
          </a-button>
          <a-button
            v-if="
              tryOnGarmentDraft?.confirmedAt &&
              tryOnGarmentDraft.status === 'draft'
            "
            type="primary"
            :loading="tryOnGarmentActivating"
            @click="activateTryOnGarmentDraft"
          >
            激活 Garment
          </a-button>
          <a-button
            v-if="tryOnGarmentDraft?.status === 'active'"
            type="primary"
            :loading="tryOnGarmentAssociating"
            @click="saveTryOnGarmentAssociations"
          >
            保存共享尺码关联
          </a-button>
          <a-button
            v-if="tryOnGarmentDraft?.status === 'active'"
            danger
            :loading="tryOnGarmentRetiring"
            @click="retireTryOnGarmentDraft"
          >
            退休
          </a-button>
        </div>
      </a-form>
    </a-modal>
  </section>
</template>

<style scoped>
:deep(.catalog-drawer .ant-drawer-body) {
  min-width: 0;
  overflow-x: hidden;
}
</style>
