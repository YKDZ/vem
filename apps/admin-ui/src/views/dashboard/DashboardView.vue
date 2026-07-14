<script setup lang="ts">
import * as echarts from "echarts";
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import {
  getDashboardSummary,
  getSalesTrend,
  getTopProducts,
  type DashboardSummary,
  type DashboardTopProduct,
  type DashboardTrendPoint,
} from "@/api/dashboard";
import { formatCents } from "@/utils/format";

const loading = ref(false);
const summary = ref<DashboardSummary>({
  todaySalesCents: 0,
  todayOrderCount: 0,
  lowStockCount: 0,
  onlineMachineCount: 0,
  pendingIssueCount: 0,
});
const topProducts = ref<DashboardTopProduct[]>([]);
const salesTrend = ref<DashboardTrendPoint[]>([]);
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const topProductColumns = [
  { title: "商品", dataIndex: "productName", key: "productName" },
  { title: "SKU", dataIndex: "sku", key: "sku" },
  { title: "销量", dataIndex: "quantity", key: "quantity" },
  { title: "销售额", dataIndex: "salesCents", key: "salesCents" },
];

async function loadData(): Promise<void> {
  loading.value = true;
  try {
    const [summaryData, trendData, topProductData] = await Promise.all([
      getDashboardSummary(),
      getSalesTrend(),
      getTopProducts(),
    ]);
    summary.value = summaryData;
    salesTrend.value = trendData;
    topProducts.value = topProductData;
    loading.value = false;
    await nextTick();
    if (chartEl.value) {
      chart?.dispose();
      chart = echarts.init(chartEl.value);
      chart.setOption({
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "category",
          data: salesTrend.value.map((item) => item.date),
        },
        yAxis: { type: "value" },
        series: [
          {
            name: "销售额",
            type: "line",
            smooth: true,
            data: salesTrend.value.map((item) => item.salesCents / 100),
          },
        ],
      });
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  if (chartEl.value) chart = echarts.init(chartEl.value);
  void loadData();
});

onBeforeUnmount(() => {
  chart?.dispose();
  chart = null;
});
</script>

<template>
  <section class="space-y-6">
    <div class="grid gap-4 md:grid-cols-5">
      <a-card>
        <a-statistic
          title="今日销售额"
          :value="summary.todaySalesCents"
          :formatter="() => formatCents(summary.todaySalesCents)"
        />
      </a-card>
      <a-card
        ><a-statistic title="今日订单" :value="summary.todayOrderCount"
      /></a-card>
      <a-card
        ><a-statistic title="低库存" :value="summary.lowStockCount"
      /></a-card>
      <a-card
        ><a-statistic title="在线机器" :value="summary.onlineMachineCount"
      /></a-card>
      <a-card>
        <a-statistic title="待处理通知" :value="summary.pendingIssueCount" />
      </a-card>
    </div>
    <a-card title="销售趋势" :loading="loading">
      <div ref="chartEl" class="h-80" />
    </a-card>
    <div>
      <a-card title="热销商品" class="overflow-hidden">
        <a-table
          :columns="topProductColumns"
          :data-source="topProducts"
          row-key="variantId"
          :pagination="false"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'salesCents'">
              {{ formatCents(record.salesCents) }}
            </template>
          </template>
        </a-table>
      </a-card>
    </div>
  </section>
</template>
