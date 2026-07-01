<script setup lang="ts">
import type { ProductStatus, VariantStatus } from "@vem/shared";

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
  uploadTryOnSilhouette,
  type PageResult,
  type Product,
  type ProductVariant,
} from "@/api/products";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/utils/format";

type ProductForm = {
  name: string;
  description: string;
  displayImageMediaAssetId: string | null;
  displayImagePublicUrl: string | null;
  status: ProductStatus;
  sortOrder: number;
};

type VariantForm = {
  productId: string;
  sku: string;
  priceCents: number;
  costCents: number;
  status: VariantStatus;
  size: string;
  color: string;
  barcode: string;
  targetGender: "male" | "female" | null;
  tryOnSilhouetteMediaAssetId: string | null;
  tryOnSilhouettePublicUrl: string | null;
};

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
  productDrawerOpen.value = true;
}

function openEditProduct(p: Product): void {
  editingProduct.value = p;
  productForm.value = {
    name: p.name,
    description: p.description ?? "",
    displayImageMediaAssetId: p.displayImageMediaAssetId,
    displayImagePublicUrl: p.displayImageMediaAsset?.publicUrl ?? null,
    status: p.status,
    sortOrder: p.sortOrder,
  };
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
    if (editingProduct.value) {
      await updateProduct(editingProduct.value.id, {
        name: productForm.value.name,
        description: productForm.value.description || null,
        displayImageMediaAssetId: productForm.value.displayImageMediaAssetId,
        status: productForm.value.status,
        sortOrder: productForm.value.sortOrder,
      });
    } else {
      await createProduct({
        name: productForm.value.name,
        description: productForm.value.description || null,
        displayImageMediaAssetId: productForm.value.displayImageMediaAssetId,
        status: productForm.value.status,
        sortOrder: productForm.value.sortOrder,
      });
    }
    productDrawerOpen.value = false;
    await loadProducts();
  } finally {
    productSaving.value = false;
  }
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
  tryOnSilhouetteMediaAssetId: null,
  tryOnSilhouettePublicUrl: null,
});
const variantSaving = ref(false);
const tryOnSilhouetteUploading = ref(false);

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
    tryOnSilhouetteMediaAssetId: null,
    tryOnSilhouettePublicUrl: null,
  };
  variantFormOpen.value = true;
}

function openEditVariant(v: ProductVariant): void {
  editingVariant.value = v;
  variantForm.value = {
    productId: v.productId,
    sku: v.sku,
    priceCents: v.priceCents,
    costCents: v.costCents ?? 0,
    status: v.status,
    size: v.size ?? "",
    color: v.color ?? "",
    barcode: v.barcode ?? "",
    targetGender: v.targetGender ?? null,
    tryOnSilhouetteMediaAssetId: v.tryOnSilhouetteMediaAssetId,
    tryOnSilhouettePublicUrl: v.tryOnSilhouetteMediaAsset?.publicUrl ?? null,
  };
  variantFormOpen.value = true;
}

async function onTryOnSilhouetteSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;

  tryOnSilhouetteUploading.value = true;
  try {
    const asset = await uploadTryOnSilhouette(file);
    variantForm.value.tryOnSilhouetteMediaAssetId = asset.id;
    variantForm.value.tryOnSilhouettePublicUrl = asset.publicUrl;
  } finally {
    tryOnSilhouetteUploading.value = false;
  }
}

function clearTryOnSilhouette(): void {
  variantForm.value.tryOnSilhouetteMediaAssetId = null;
  variantForm.value.tryOnSilhouettePublicUrl = null;
}

async function saveVariant(): Promise<void> {
  variantSaving.value = true;
  try {
    const body = {
      productId: variantForm.value.productId,
      sku: variantForm.value.sku,
      priceCents: variantForm.value.priceCents,
      costCents: variantForm.value.costCents || null,
      status: variantForm.value.status,
      size: variantForm.value.size || null,
      color: variantForm.value.color || null,
      barcode: variantForm.value.barcode || null,
      targetGender: variantForm.value.targetGender || null,
      tryOnSilhouetteMediaAssetId:
        variantForm.value.tryOnSilhouetteMediaAssetId,
    };
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
          <div class="space-y-3">
            <img
              v-if="productForm.displayImagePublicUrl"
              class="h-32 w-32 rounded border border-slate-200 object-cover"
              :src="productForm.displayImagePublicUrl"
              :alt="productForm.name || '商品展示图'"
            />
            <div class="flex items-center gap-2">
              <a-button :loading="productImageUploading">
                <label class="cursor-pointer">
                  上传图片
                  <input
                    class="hidden"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    @change="onProductDisplayImageSelected"
                  />
                </label>
              </a-button>
              <a-button
                v-if="productForm.displayImageMediaAssetId"
                danger
                @click="clearProductDisplayImage"
              >
                清除
              </a-button>
            </div>
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
      width="700"
      :destroy-on-hidden="true"
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
        <a-form-item label="试穿剪影">
          <div class="space-y-3">
            <img
              v-if="variantForm.tryOnSilhouettePublicUrl"
              class="h-32 w-24 rounded border border-slate-200 object-contain"
              :src="variantForm.tryOnSilhouettePublicUrl"
              :alt="`${variantForm.sku || 'SKU'} 试穿剪影`"
            />
            <div class="flex items-center gap-2">
              <a-button :loading="tryOnSilhouetteUploading">
                <label class="cursor-pointer">
                  上传剪影
                  <input
                    class="hidden"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    @change="onTryOnSilhouetteSelected"
                  />
                </label>
              </a-button>
              <a-button
                v-if="variantForm.tryOnSilhouetteMediaAssetId"
                danger
                @click="clearTryOnSilhouette"
              >
                清除
              </a-button>
            </div>
          </div>
        </a-form-item>
        <a-form-item label="状态">
          <a-select v-model:value="variantForm.status">
            <a-select-option value="active">上架</a-select-option>
            <a-select-option value="inactive">下架</a-select-option>
          </a-select>
        </a-form-item>
      </a-form>
    </a-modal>
  </section>
</template>
