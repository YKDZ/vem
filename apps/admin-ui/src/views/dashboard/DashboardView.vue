<script setup lang="ts">
import * as echarts from "echarts";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import {
  getDashboardSummary,
  getCustomerProfile,
  getSalesTrend,
  getTopProducts,
  type DashboardCustomerProfile,
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
const customerProfile = ref<DashboardCustomerProfile[]>([]);
const chartEl = ref<HTMLDivElement | null>(null);
let chart: echarts.ECharts | null = null;

const topProductColumns = [
  { title: "商品", dataIndex: "productName", key: "productName" },
  { title: "SKU", dataIndex: "sku", key: "sku" },
  { title: "销量", dataIndex: "quantity", key: "quantity" },
  { title: "销售额", dataIndex: "salesCents", key: "salesCents" },
];
const trendColumns = [
  { title: "日期", dataIndex: "date", key: "date" },
  { title: "订单数", dataIndex: "orderCount", key: "orderCount" },
  { title: "销售额", dataIndex: "salesCents", key: "salesCents" },
];
const profileColumns = [
  { title: "顾客画像", dataIndex: "label", key: "label" },
  { title: "识别次数", dataIndex: "count", key: "count" },
  { title: "占比", key: "ratio" },
];
const operationColumns = [
  { title: "运营指标", dataIndex: "label", key: "label" },
  { title: "当前值", dataIndex: "value", key: "value" },
  { title: "状态", dataIndex: "status", key: "status" },
];
const profileTotal = computed(() =>
  customerProfile.value.reduce((total, item) => total + item.count, 0),
);
const operationRows = computed(() => [
  {
    key: "online-machines",
    label: "在线机器",
    value: summary.value.onlineMachineCount,
    status: summary.value.onlineMachineCount > 0 ? "正常" : "需关注",
  },
  {
    key: "low-stock",
    label: "低库存商品",
    value: summary.value.lowStockCount,
    status: summary.value.lowStockCount > 0 ? "需补货" : "正常",
  },
  {
    key: "pending-issues",
    label: "待处理通知",
    value: summary.value.pendingIssueCount,
    status: summary.value.pendingIssueCount > 0 ? "待处理" : "正常",
  },
]);

async function loadData(): Promise<void> {
  loading.value = true;
  try {
    const [summaryData, trendData, topProductData, profileData] =
      await Promise.all([
        getDashboardSummary(),
        getSalesTrend(),
        getTopProducts(),
        getCustomerProfile(),
      ]);
    summary.value = summaryData;
    salesTrend.value = trendData;
    topProducts.value = topProductData;
    customerProfile.value = profileData;
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
    <div class="grid gap-6 xl:grid-cols-2">
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
      <a-card title="近期销售明细" class="overflow-hidden">
        <a-table
          :columns="trendColumns"
          :data-source="salesTrend"
          row-key="date"
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
      <a-card title="顾客画像分布" class="overflow-hidden">
        <a-table
          :columns="profileColumns"
          :data-source="customerProfile"
          row-key="label"
          :pagination="false"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ratio'">
              {{
                profileTotal > 0
                  ? `${((record.count / profileTotal) * 100).toFixed(1)}%`
                  : "0%"
              }}
            </template>
          </template>
        </a-table>
      </a-card>
      <a-card title="运营状态一览" class="overflow-hidden">
        <a-table
          :columns="operationColumns"
          :data-source="operationRows"
          row-key="key"
          :pagination="false"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'status'">
              <a-tag :color="record.status === '正常' ? 'success' : 'warning'">
                {{ record.status }}
              </a-tag>
            </template>
          </template>
        </a-table>
      </a-card>
    </div>
  </section>
</template>
