<script setup lang="ts">
import { computed, onMounted } from "vue";

import KioskLayout from "@/layouts/KioskLayout.vue";
import { useVisionStore } from "@/stores/vision";

const visionStore = useVisionStore();

const prettyStatus = computed(() =>
  JSON.stringify(
    {
      enabled: visionStore.enabled,
      online: visionStore.online,
      message: visionStore.message,
      updatedAt: visionStore.updatedAt,
    },
    null,
    2,
  ),
);

onMounted(async () => {
  await visionStore.refresh();
});
</script>

<template>
  <KioskLayout>
    <section class="grid gap-6 text-white">
      <div class="rounded-4xl border border-white/10 bg-white/10 p-6">
        <p class="text-sm tracking-[0.35em] text-fuchsia-200 uppercase">
          VISION DEV
        </p>
        <h2 class="mt-3 text-3xl font-black">daemon 视觉状态联调</h2>
        <p class="mt-3 text-slate-300">
          本页面只读取 daemon 暴露的视觉状态，不再直接连接视觉 WebSocket。
        </p>
      </div>

      <section class="rounded-4xl border border-white/10 bg-slate-950/40 p-6">
        <h3 class="text-xl font-bold text-sky-100">当前状态</h3>
        <pre class="mt-4 overflow-auto text-sm text-slate-200">{{
          prettyStatus
        }}</pre>
      </section>
    </section>
  </KioskLayout>
</template>
