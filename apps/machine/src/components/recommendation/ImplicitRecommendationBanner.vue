<script setup lang="ts">
defineProps<{
  state: "active" | "multiple";
}>();
</script>

<template>
  <div
    class="implicit-recommendation-banner"
    :class="`implicit-recommendation-banner-${state}`"
    role="status"
    data-test="implicit-recommendation-banner"
    :data-recommendation-state="state"
  >
    <span class="implicit-recommendation-pulse" aria-hidden="true"></span>
    <strong v-if="state === 'active'">智能选码已开启</strong>
    <strong v-else>请一位顾客站到镜头前获取尺码建议</strong>
  </div>
</template>

<style scoped>
.implicit-recommendation-banner {
  display: flex;
  min-height: 3.25rem;
  align-items: center;
  gap: 0.8rem;
  padding: 0.7rem 1.15rem;
  border: 1px solid rgba(118, 138, 100, 0.48);
  border-radius: 999px;
  background: rgba(245, 250, 239, 0.94);
  color: #4f6540;
  box-shadow: 0 10px 26px rgba(82, 101, 65, 0.12);
  font-size: clamp(0.9rem, 1.48vw, 1.08rem);
  letter-spacing: 0.04em;
}

.implicit-recommendation-banner-multiple {
  border-color: rgba(201, 172, 105, 0.72);
  background: rgba(255, 251, 235, 0.96);
  color: #75633e;
}

.implicit-recommendation-pulse {
  width: 0.72rem;
  height: 0.72rem;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #738a61;
  box-shadow: 0 0 0 0.38rem rgba(115, 138, 97, 0.14);
}

.implicit-recommendation-banner-multiple .implicit-recommendation-pulse {
  background: #b28a42;
  box-shadow: 0 0 0 0.38rem rgba(178, 138, 66, 0.14);
}
</style>
