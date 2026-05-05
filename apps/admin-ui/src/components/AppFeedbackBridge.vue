<script setup lang="ts">
import { App } from "antdv-next";
import { onBeforeUnmount, onMounted } from "vue";

const { message, notification } = App.useApp();

function handleMessage(event: Event): void {
  const detail = (
    event as CustomEvent<{
      type: "success" | "error" | "warning" | "info";
      content: string;
    }>
  ).detail;
  if (!detail) return;
  void message[detail.type](detail.content);
}

function handleNotification(event: Event): void {
  const detail = (event as CustomEvent<{ title: string; description: string }>)
    .detail;
  if (!detail) return;
  notification.info({ title: detail.title, description: detail.description });
}

onMounted(() => {
  window.addEventListener("vem:message", handleMessage);
  window.addEventListener("vem:notification", handleNotification);
});

onBeforeUnmount(() => {
  window.removeEventListener("vem:message", handleMessage);
  window.removeEventListener("vem:notification", handleNotification);
});
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
