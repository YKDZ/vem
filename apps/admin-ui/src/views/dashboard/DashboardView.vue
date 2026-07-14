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
const salesChartEl = ref<HTMLDivElement | null>(null);
const topProductsChartEl = ref<HTMLDivElement | null>(null);
let salesChart: echarts.ECharts | null = null;
let topProductsChart: echarts.ECharts | null = null;

function renderCharts(): void {
  if (salesChartEl.value) {
    salesChart?.dispose();
    salesChart = echarts.init(salesChartEl.value);
    salesChart.setOption({
      tooltip: { trigger: "axis" },
      legend: { data: ["销售额", "订单数"] },
      grid: { left: 64, right: 64, bottom: 40 },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: salesTrend.value.map((item) => item.date),
      },
      yAxis: [
        {
          type: "value",
          name: "销售额（元）",
          axisLabel: { formatter: "¥{value}" },
        },
        {
          type: "value",
          name: "订单数",
          minInterval: 1,
        },
      ],
      series: [
        {
          name: "销售额",
          type: "line",
          smooth: true,
          showSymbol: false,
          areaStyle: { opacity: 0.08 },
          data: salesTrend.value.map((item) => item.salesCents / 100),
        },
        {
          name: "订单数",
          type: "line",
          smooth: true,
          showSymbol: false,
          yAxisIndex: 1,
          data: salesTrend.value.map((item) => item.orderCount),
        },
      ],
    });
  }

  if (topProductsChartEl.value) {
    topProductsChart?.dispose();
    topProductsChart = echarts.init(topProductsChartEl.value);
    const products = [...topProducts.value].reverse();
    topProductsChart.setOption({
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      title: [
        { text: "销量", left: 160, textStyle: { fontSize: 13 } },
        { text: "销售额", left: "58%", textStyle: { fontSize: 13 } },
      ],
      grid: [
        { left: 160, width: "32%", top: 48, bottom: 32 },
        { left: "58%", right: 48, top: 48, bottom: 32 },
      ],
      xAxis: [
        { type: "value", minInterval: 1 },
        {
          type: "value",
          axisLabel: { formatter: "¥{value}" },
          gridIndex: 1,
        },
      ],
      yAxis: [
        {
          type: "category",
          data: products.map((item) => item.productName),
          axisLabel: { width: 140, overflow: "truncate" },
        },
        {
          type: "category",
          data: products.map((item) => item.productName),
          axisLabel: { show: false },
          axisTick: { show: false },
          gridIndex: 1,
        },
      ],
      series: [
        {
          name: "销量",
          type: "bar",
          barMaxWidth: 18,
          data: products.map((item) => item.quantity),
        },
        {
          name: "销售额",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 18,
          data: products.map((item) => item.salesCents / 100),
        },
      ],
    });
  }
}

function resizeCharts(): void {
  salesChart?.resize();
  topProductsChart?.resize();
}

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
    renderCharts();
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  window.addEventListener("resize", resizeCharts);
  void loadData();
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", resizeCharts);
  salesChart?.dispose();
  topProductsChart?.dispose();
  salesChart = null;
  topProductsChart = null;
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
      <div ref="salesChartEl" class="h-80" />
    </a-card>
    <a-card title="热销商品" :loading="loading">
      <div ref="topProductsChartEl" class="h-96" />
    </a-card>
  </section>
</template>
