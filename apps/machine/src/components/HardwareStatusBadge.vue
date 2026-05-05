<script setup lang="ts">
defineProps<{
  ready: boolean;
  message: string;
}>();
</script>

<template>
  <span
    class="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
    :class="
      ready ? 'bg-sky-400/15 text-sky-200' : 'bg-amber-400/15 text-amber-200'
    "
  >
    <span
      class="size-2 rounded-full"
      :class="ready ? 'bg-sky-300' : 'bg-amber-300'"
    />
    {{ message }}
  </span>
</template>
