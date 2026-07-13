<script setup lang="ts">
import { ref } from "vue";

import QweatherTab from "@/views/system-settings/QweatherTab.vue";

const activeTab = ref("weather");
</script>

<template>
  <section>
    <header class="mb-4">
      <h1 class="m-0 text-xl font-semibold text-slate-900">系统配置</h1>
      <p class="mt-2 mb-0 text-sm text-slate-500">
        管理平台依赖的外部服务和全局运行参数。
      </p>
    </header>

    <a-card :body-style="{ paddingTop: '8px' }">
      <a-tabs v-model:active-key="activeTab">
        <a-tab-pane key="weather" tab="天气服务">
          <QweatherTab />
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </section>
</template>
