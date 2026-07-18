import { readonly, ref, type Ref } from "vue";

import {
  isVisionTryOnCapabilityDegraded,
  openVisionTryOnSession,
  type VisionTryOnSession,
  type VisionTryOnSessionInput,
  type VisionTryOnStopReason,
} from "@/native/vision";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

export interface TryOnPreviewStartInput extends VisionTryOnSessionInput {
  silhouetteUrl?: string | null;
}

export function useTryOnPreview(): {
  previewUrl: Readonly<Ref<string | null>>;
  errorMessage: Readonly<Ref<string | null>>;
  isStarting: Readonly<Ref<boolean>>;
  startPreview: (input?: TryOnPreviewStartInput) => Promise<void>;
  stopPreview: (reason?: VisionTryOnStopReason) => Promise<void>;
} {
  const machineStore = useMachineStore();
  const visionStore = useVisionStore();
  const previewUrl = ref<string | null>(null);
  const errorMessage = ref<string | null>(null);
  const isStarting = ref(false);
  const activeSession = ref<VisionTryOnSession | null>(null);
  let requestSequence = 0;

  async function startPreview(
    input: TryOnPreviewStartInput = {},
  ): Promise<void> {
    requestSequence += 1;
    const sequence = requestSequence;
    isStarting.value = true;
    errorMessage.value = null;
    previewUrl.value = null;

    await stopActiveSession("replaced");
    if (sequence !== requestSequence) return;

    if (!input.silhouetteUrl) {
      if (sequence === requestSequence) {
        errorMessage.value = "当前规格暂不支持虚拟试穿。";
        isStarting.value = false;
      }
      return;
    }

    try {
      const session = await openVisionTryOnSession(
        { machineCode: machineStore.machineCode },
        {
          catalogKey: input.catalogKey,
          variantId: input.variantId,
        },
      );
      if (sequence !== requestSequence) {
        await session.stop("replaced");
        return;
      }
      activeSession.value = session;
      previewUrl.value = session.previewUrl;
    } catch (error) {
      if (sequence === requestSequence) {
        if (isVisionTryOnCapabilityDegraded(error)) {
          visionStore.markTryOnCapabilityDegraded();
        }
        errorMessage.value =
          "虚拟试穿预览启动失败，请联系维护人员检查视觉服务与摄像头。";
      }
    } finally {
      if (sequence === requestSequence) {
        isStarting.value = false;
      }
    }
  }

  async function stopPreview(
    reason: VisionTryOnStopReason = "user_exit",
  ): Promise<void> {
    requestSequence += 1;
    isStarting.value = false;
    errorMessage.value = null;
    previewUrl.value = null;
    await stopActiveSession(reason);
  }

  async function stopActiveSession(
    reason: VisionTryOnStopReason,
  ): Promise<void> {
    const session = activeSession.value;
    activeSession.value = null;
    if (!session) return;
    try {
      await session.stop(reason);
    } catch {
      return;
    }
  }

  return {
    previewUrl: readonly(previewUrl),
    errorMessage: readonly(errorMessage),
    isStarting: readonly(isStarting),
    startPreview,
    stopPreview,
  };
}
