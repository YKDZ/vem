<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";

import type { SaleViewSnapshot } from "@/daemon/schemas";

import { applyUiDebugScenarioToStores } from "@/dev/runtime-scenario-loader";
import {
  machineRuntimeScenarios,
  type MachineRuntimeScenario,
} from "@/dev/runtime-scenarios";
import { installUiDebugDaemon } from "@/dev/ui-debug-daemon";
import {
  clearSaleViewOverride,
  enableUiDebugMode,
  getActiveUiDebugScenario,
  getUiDebugScenario,
  getSaleViewForScenario,
  saveSaleViewOverride,
  setActiveUiDebugScenarioId,
  uiDebugScenarios,
  type UiDebugScenarioId,
} from "@/dev/ui-debug-fixtures";
import KioskLayout from "@/layouts/KioskLayout.vue";
import { useCatalogStore } from "@/stores/catalog";
import { useCheckoutStore } from "@/stores/checkout";

const router = useRouter();
const catalogStore = useCatalogStore();
const checkoutStore = useCheckoutStore();

const activeScenarioId = ref<UiDebugScenarioId>(getActiveUiDebugScenario().id);
const saleViewJson = ref("");
const editorError = ref<string | null>(null);
const editorSaved = ref(false);

const activeScenario = computed(
  () =>
    uiDebugScenarios.find(
      (scenario) => scenario.id === activeScenarioId.value,
    ) ?? uiDebugScenarios[0],
);

function refreshEditor(): void {
  saleViewJson.value = JSON.stringify(
    getSaleViewForScenario(activeScenario.value.id),
    null,
    2,
  );
  editorError.value = null;
  editorSaved.value = false;
}

function selectScenario(id: UiDebugScenarioId): void {
  activeScenarioId.value = id;
  setActiveUiDebugScenarioId(id);
  applyUiDebugScenarioToStores(activeScenario.value);
  refreshEditor();
}

function saveEditor(): void {
  try {
    const parsed = JSON.parse(saleViewJson.value) as unknown;
    saveSaleViewOverride(activeScenario.value.id, parsed as SaleViewSnapshot);
    catalogStore.applySnapshot(getSaleViewForScenario(activeScenario.value.id));
    editorError.value = null;
    editorSaved.value = true;
  } catch (error) {
    editorError.value = error instanceof Error ? error.message : String(error);
    editorSaved.value = false;
  }
}

function resetEditor(): void {
  clearSaleViewOverride(activeScenario.value.id);
  applyUiDebugScenarioToStores(activeScenario.value);
  refreshEditor();
}

async function goBoot(): Promise<void> {
  await router.push("/boot");
}

async function goCatalog(): Promise<void> {
  applyUiDebugScenarioToStores(activeScenario.value);
  await router.push("/catalog");
}

async function goProductDetail(): Promise<void> {
  applyUiDebugScenarioToStores(activeScenario.value);
  const item = catalogStore.availableItems[0];
  if (!item) return;
  checkoutStore.selectItem(item);
  await router.push({
    name: "product-detail",
    params: { catalogKey: item.catalogKey },
  });
}

async function goCheckout(): Promise<void> {
  applyUiDebugScenarioToStores(activeScenario.value);
  const item = catalogStore.availableItems[0];
  if (!item) return;
  const concreteItem =
    catalogStore.saleableVariantItemFor(item.catalogKey, item.variantId) ??
    item;
  checkoutStore.selectItem(concreteItem);
  await router.push("/checkout");
}

async function goPayment(): Promise<void> {
  const scenario =
    activeScenario.value.transaction.orderNo === null
      ? uiDebugScenarios.find((candidate) => candidate.id === "payment_qr")!
      : activeScenario.value;
  setActiveUiDebugScenarioId(scenario.id);
  activeScenarioId.value = scenario.id;
  applyUiDebugScenarioToStores(scenario);
  await router.push("/payment");
}

async function goPaymentCode(): Promise<void> {
  const scenario = uiDebugScenarios.find(
    (candidate) => candidate.id === "payment_qr",
  )!;
  setActiveUiDebugScenarioId(scenario.id);
  activeScenarioId.value = scenario.id;
  applyUiDebugScenarioToStores(scenario);
  await router.push("/payment");
}

async function goDispensing(
  scenarioId: UiDebugScenarioId = "dispensing",
): Promise<void> {
  const scenario = uiDebugScenarios.find(
    (candidate) => candidate.id === scenarioId,
  )!;
  setActiveUiDebugScenarioId(scenario.id);
  activeScenarioId.value = scenario.id;
  applyUiDebugScenarioToStores(scenario);
  await router.push("/dispensing");
}

async function goResult(kind: string): Promise<void> {
  const scenario = uiDebugScenarios.find(
    (candidate) =>
      candidate.id ===
      (kind === "dispense_failed" ? "dispense_failed" : "ready"),
  )!;
  setActiveUiDebugScenarioId(scenario.id);
  activeScenarioId.value = scenario.id;
  applyUiDebugScenarioToStores(scenario);
  await router.push({ name: "result", params: { kind } });
}

async function goStaticRoute(path: string): Promise<void> {
  applyUiDebugScenarioToStores(activeScenario.value);
  await router.push(path);
}

async function goRuntimeScenario(
  scenario: MachineRuntimeScenario,
): Promise<void> {
  const fixture = getUiDebugScenario(scenario.fixtureScenarioId);
  setActiveUiDebugScenarioId(fixture.id);
  activeScenarioId.value = fixture.id;
  applyUiDebugScenarioToStores(fixture);
  await router.push(scenario.targetRoute);
}

onMounted(() => {
  enableUiDebugMode();
  installUiDebugDaemon();
  applyUiDebugScenarioToStores(activeScenario.value);
  refreshEditor();
});
</script>

<template>
  <KioskLayout>
    <section class="flex min-h-full flex-col gap-5 text-white">
      <div class="rounded-3xl border border-white/10 bg-white/10 p-5">
        <p class="text-sm tracking-[0.35em] text-sky-200 uppercase">UI DEBUG</p>
        <h2 class="mt-2 text-3xl font-black">浏览器调试通道</h2>
        <p class="mt-2 text-sm text-slate-300">
          当前仅在 Vite DEV + uiDebug 开关下启用，页面数据来自本地 mock daemon。
        </p>
      </div>

      <section class="grid gap-3">
        <button
          v-for="scenario in uiDebugScenarios"
          :key="scenario.id"
          class="rounded-2xl border px-4 py-3 text-left"
          :class="
            scenario.id === activeScenarioId
              ? 'border-sky-300 bg-sky-300/20'
              : 'border-white/10 bg-slate-950/30'
          "
          type="button"
          @click="selectScenario(scenario.id)"
        >
          <p class="text-lg font-black">{{ scenario.name }}</p>
          <p class="mt-1 text-sm text-slate-300">{{ scenario.description }}</p>
        </button>
      </section>

      <section class="rounded-3xl border border-white/10 bg-white/10 p-5">
        <h3 class="text-xl font-black">场景矩阵</h3>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <button
            v-for="scenario in machineRuntimeScenarios"
            :key="scenario.id"
            class="debug-button text-left"
            type="button"
            @click="goRuntimeScenario(scenario)"
          >
            <span class="block text-base">{{ scenario.name }}</span>
            <span class="mt-1 block text-xs text-slate-300">
              {{ scenario.targetRoute }}
            </span>
          </button>
        </div>
      </section>

      <section class="rounded-3xl border border-white/10 bg-white/10 p-5">
        <h3 class="text-xl font-black">快速跳转</h3>
        <div class="mt-4 grid grid-cols-2 gap-3">
          <button class="debug-button" type="button" @click="goBoot">
            Boot
          </button>
          <button class="debug-button" type="button" @click="goCatalog">
            Catalog
          </button>
          <button class="debug-button" type="button" @click="goProductDetail">
            商品详情
          </button>
          <button class="debug-button" type="button" @click="goCheckout">
            Checkout
          </button>
          <button class="debug-button" type="button" @click="goPayment">
            Payment
          </button>
          <button class="debug-button" type="button" @click="goPaymentCode">
            Payment Code
          </button>
          <button class="debug-button" type="button" @click="goDispensing()">
            Dispensing
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goDispensing('dispensing_pickup_15s')"
          >
            Dispensing 15s
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goDispensing('dispensing_pickup_25s')"
          >
            Dispensing 25s
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goResult('success')"
          >
            Result Success
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goResult('dispense_failed')"
          >
            Result Failed
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goStaticRoute('/offline')"
          >
            Offline
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goStaticRoute('/maintenance')"
          >
            Maintenance
          </button>
          <button
            class="debug-button"
            type="button"
            @click="goStaticRoute('/provisioning')"
          >
            Provisioning
          </button>
        </div>
      </section>

      <section class="rounded-3xl border border-white/10 bg-white/10 p-5">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h3 class="text-xl font-black">Sale View JSON</h3>
            <p class="mt-1 text-sm text-slate-300">
              修改后保存即可影响目录、详情和下单前展示。
            </p>
          </div>
          <div class="flex gap-2">
            <button
              class="debug-button compact"
              type="button"
              @click="saveEditor"
            >
              保存
            </button>
            <button
              class="debug-button compact"
              type="button"
              @click="resetEditor"
            >
              重置
            </button>
          </div>
        </div>
        <textarea
          v-model="saleViewJson"
          class="mt-4 h-80 w-full rounded-2xl border border-white/10 bg-slate-950/75 p-4 font-mono text-xs leading-relaxed text-slate-100 outline-none"
          spellcheck="false"
        />
        <p
          v-if="editorError"
          class="mt-3 rounded-2xl bg-rose-500/20 p-3 text-rose-100"
        >
          {{ editorError }}
        </p>
        <p
          v-if="editorSaved"
          class="mt-3 rounded-2xl bg-emerald-400/15 p-3 text-emerald-100"
        >
          已保存并应用当前场景数据。
        </p>
      </section>
    </section>
  </KioskLayout>
</template>

<style scoped>
.debug-button {
  border-radius: 1rem;
  border: 1px solid rgb(255 255 255 / 0.12);
  background: rgb(15 23 42 / 0.45);
  padding: 0.85rem 1rem;
  text-align: center;
  font-weight: 900;
  color: white;
}

.debug-button.compact {
  padding: 0.65rem 0.9rem;
  font-size: 0.875rem;
}
</style>
