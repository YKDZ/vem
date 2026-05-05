<script setup lang="ts">
import zhCN from "antdv-next/locale/zh_CN";
import { RouterView } from "vue-router";

import AppFeedbackBridge from "@/components/AppFeedbackBridge.vue";
</script>

<template>
  <a-config-provider
    :locale="zhCN"
    :theme="{ token: { colorPrimary: '#2563eb', borderRadius: 8 } }"
  >
    <a-app>
      <AppFeedbackBridge />
      <RouterView />
    </a-app>
  </a-config-provider>
</template>
