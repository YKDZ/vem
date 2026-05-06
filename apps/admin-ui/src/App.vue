<script setup lang="ts">
import zhCN from "antdv-next/locale/zh_CN";
import { RouterView } from "vue-router";

import AppFeedbackBridge from "@/components/AppFeedbackBridge.vue";
</script>

<template>
  <a-config-provider
    :locale="zhCN"
    :theme="{
      token: {
        colorPrimary: '#2563eb',
        borderRadius: 8,
        colorBgLayout: '#f4f6fb',
      },
      components: {
        Layout: {
          siderBg: '#ffffff',
          headerBg: '#ffffff',
        },
        Menu: {
          itemBg: 'transparent',
          subMenuItemBg: 'transparent',
        },
      },
    }"
  >
    <a-app>
      <AppFeedbackBridge />
      <RouterView />
    </a-app>
  </a-config-provider>
</template>
