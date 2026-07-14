<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { resolveManagedMediaReference } from "@/catalog/managed-media";

const props = defineProps<{
  reference: string | null | undefined;
  diagnosticKey: string;
  apiBaseUrl: string;
  fallback: string;
  alt: string;
}>();

const emit = defineEmits<{
  diagnostic: [event: { diagnosticKey: string; message: string }];
}>();

const resolution = computed(() =>
  resolveManagedMediaReference(props.reference, props.apiBaseUrl),
);
const source = ref(props.fallback);

watch(
  resolution,
  (next) => {
    source.value = next.url ?? props.fallback;
    if (next.diagnostic) {
      emit("diagnostic", {
        diagnosticKey: props.diagnosticKey,
        message: next.diagnostic,
      });
    }
  },
  { immediate: true },
);

function usePlaceholder(): void {
  if (source.value === props.fallback) return;
  source.value = props.fallback;
  emit("diagnostic", {
    diagnosticKey: props.diagnosticKey,
    message: "managed media failed to load",
  });
}
</script>

<template>
  <img :src="source" :alt="alt" @error="usePlaceholder" />
</template>
