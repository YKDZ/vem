<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();
</script>

<template>
  <a-result status="403" title="403" sub-title="你没有权限访问该页面">
    <template #extra>
      <a-button type="primary" @click="router.replace('/dashboard')">
        返回首页
      </a-button>
    </template>
  </a-result>
</template>
