<script setup lang="ts">
import { computed, ref, watch } from "vue";

import {
  managedMediaDiagnosticKey,
  resolveDaemonReadyUrl,
} from "@/catalog/managed-media";

const props = defineProps<{
  reference: string | null | undefined;
  diagnosticKey: string;
  fallback: string;
  alt: string;
  readyUrl?: string | null;
}>();

const emit = defineEmits<{
  diagnostic: [event: { diagnosticKey: string; message: string }];
}>();

// Catalog media has no browser/platform fallback.  Only the daemon-generated
// grant URL can point an image element at bytes; absent or warming projections
// stay on the stable local placeholder.
const resolution = computed(() =>
  resolveDaemonReadyUrl(props.readyUrl ?? null, props.fallback),
);
const source = ref(props.fallback);

watch(
  resolution,
  (next) => {
    source.value = next.url ?? props.fallback;
    if (next.diagnostic) {
      emit("diagnostic", {
        diagnosticKey: managedMediaDiagnosticKey(
          props.diagnosticKey,
          props.reference,
        ),
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
    diagnosticKey: managedMediaDiagnosticKey(
      props.diagnosticKey,
      props.reference,
    ),
    message: "managed media failed to load",
  });
}
</script>

<template>
  <img :src="source" :alt="alt" @error="usePlaceholder" />
</template>
