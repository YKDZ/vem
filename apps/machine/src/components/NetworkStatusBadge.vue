<script setup lang="ts">
defineProps<{
  label: string;
  online: boolean;
}>();
</script>

<template>
  <span
    class="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
    :class="
      online
        ? 'bg-emerald-400/15 text-emerald-200'
        : 'bg-rose-400/15 text-rose-200'
    "
  >
    <span
      class="size-2 rounded-full"
      :class="online ? 'bg-emerald-300' : 'bg-rose-300'"
    />
    {{ label }}
  </span>
</template>
