<script setup lang="ts">
import { permissionCodes } from "@vem/shared";
import { computed } from "vue";

const permissionCount = computed(() => permissionCodes.length);
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-8 text-slate-950">
    <section
      class="mx-auto max-w-3xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
    >
      <h1 class="text-2xl font-semibold">VEM 管理后台</h1>
      <p class="mt-6 text-sm text-slate-500">
        已加载权限码数量：{{ permissionCount }}
      </p>
    </section>
  </main>
</template>
