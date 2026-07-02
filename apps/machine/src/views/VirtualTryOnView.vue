<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";

const route = useRoute();
const router = useRouter();
const catalogStore = useCatalogStore();
const machineStore = useMachineStore();

const videoElement = ref<HTMLVideoElement | null>(null);
const errorMessage = ref<string | null>(null);
const stream = ref<MediaStream | null>(null);
let disposed = false;
let startupSequence = 0;

const catalogKey = computed(() => String(route.params.catalogKey ?? ""));
const variantId = computed(() => String(route.query.variantId ?? ""));
const item = computed(() => catalogStore.itemByCatalogKey(catalogKey.value));
const selectedVariant = computed(
  () =>
    item.value?.variantCandidates.find(
      (variant) => variant.variantId === variantId.value,
    ) ?? null,
);
const silhouetteUrl = computed(
  () => selectedVariant.value?.tryOnSilhouetteUrl ?? null,
);

onMounted(() => {
  void startCamera();
});

onBeforeUnmount(() => {
  disposed = true;
  startupSequence += 1;
  stopCurrentStream();
});

async function startCamera(): Promise<void> {
  const deviceId = machineStore.config.tryOnCameraDeviceId;
  const requestSequence = ++startupSequence;
  errorMessage.value = null;

  if (!silhouetteUrl.value) {
    errorMessage.value = "当前规格暂不支持虚拟试穿。";
    return;
  }
  if (!deviceId) {
    errorMessage.value =
      "试穿摄像头未配置，请联系维护人员检查摄像头配置与调试。";
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    errorMessage.value =
      "当前设备无法打开试穿摄像头，请联系维护人员检查摄像头配置与调试。";
    return;
  }

  let openedStream: MediaStream | null = null;
  try {
    openedStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: deviceId } },
    });
    if (disposed || requestSequence !== startupSequence) {
      stopMediaStreamTracks(openedStream);
      return;
    }
    stream.value = openedStream;
    if (videoElement.value) {
      videoElement.value.srcObject = openedStream;
    }
  } catch {
    if (openedStream) stopMediaStreamTracks(openedStream);
    if (!disposed && requestSequence === startupSequence) {
      errorMessage.value =
        "试穿摄像头启动失败，请联系维护人员检查摄像头配置与调试。";
    }
  }
}

function stopCurrentStream(): void {
  if (stream.value) {
    stopMediaStreamTracks(stream.value);
    stream.value = null;
  }
  if (videoElement.value) {
    videoElement.value.srcObject = null;
  }
}

function stopMediaStreamTracks(target: MediaStream): void {
  for (const track of target.getTracks()) {
    track.stop();
  }
}

async function exitTryOn(): Promise<void> {
  stopCurrentStream();
  await router.push({
    name: "product-detail",
    params: { catalogKey: catalogKey.value },
    query: { variantId: variantId.value },
  });
}
</script>

<template>
  <main class="virtual-try-on-view">
    <video
      ref="videoElement"
      class="try-on-video"
      autoplay
      muted
      playsinline
      data-test="try-on-video"
    ></video>
    <img
      v-if="silhouetteUrl"
      class="try-on-silhouette try-on-silhouette-fixed"
      :src="silhouetteUrl"
      alt=""
      aria-hidden="true"
      data-test="try-on-silhouette"
    />
    <section v-if="errorMessage" class="try-on-error" data-test="try-on-error">
      <p>{{ errorMessage }}</p>
    </section>
    <button
      class="try-on-exit kiosk-touch-target"
      type="button"
      data-test="try-on-exit"
      @click="exitTryOn"
    >
      退出试穿
    </button>
  </main>
</template>

<style scoped>
.virtual-try-on-view {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #111;
}

.try-on-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.try-on-silhouette {
  position: absolute;
  left: 50%;
  top: 50%;
  max-width: min(42vw, 34rem);
  max-height: min(78vh, 48rem);
  transform: translate(-50%, -50%);
  object-fit: contain;
  pointer-events: none;
}

.try-on-error {
  position: absolute;
  left: 50%;
  top: 50%;
  width: min(80vw, 36rem);
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 255, 255, 0.32);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.86);
  color: #fff;
  padding: 1.5rem;
  text-align: center;
}

.try-on-exit {
  position: absolute;
  left: 2rem;
  top: 2rem;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  color: #111827;
  font-weight: 700;
  padding: 0.85rem 1.25rem;
}
</style>
