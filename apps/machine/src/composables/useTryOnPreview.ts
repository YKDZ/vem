import { visionTryOnPreviewUrlSchema } from "@vem/shared";
import { readonly, ref, type Ref } from "vue";

import { projectCustomerError } from "@/customer-error-projection/customer-error-projection";
import {
  isVisionTryOnCapabilityDegraded,
  openVisionTryOnSession,
  type VisionTryOnSession,
  type VisionTryOnSessionInput,
  type VisionTryOnStopReason,
} from "@/native/vision";
import { recordCustomerErrorEvidence } from "@/runtime/customer-error-evidence";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";

export interface TryOnPreviewStartInput extends VisionTryOnSessionInput {
  silhouetteUrl?: string | null;
}

type TryOnSessionCorrelation = {
  sessionId: string | null;
  catalogKey: string | null;
  variantId: string | null;
};

type ActiveTryOnSession = {
  session: VisionTryOnSession;
  correlation: TryOnSessionCorrelation;
};

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
  const activeSession = ref<ActiveTryOnSession | null>(null);
  let requestSequence = 0;

  async function startPreview(
    input: TryOnPreviewStartInput = {},
  ): Promise<void> {
    requestSequence += 1;
    const sequence = requestSequence;
    let correlation: TryOnSessionCorrelation = {
      sessionId: null,
      catalogKey: input.catalogKey ?? null,
      variantId: input.variantId ?? null,
    };
    isStarting.value = true;
    errorMessage.value = null;
    previewUrl.value = null;

    await stopActiveSession("replaced");
    if (sequence !== requestSequence) return;

    try {
      const session = await openVisionTryOnSession(
        { machineCode: machineStore.machineCode },
        {
          catalogKey: input.catalogKey,
          variantId: input.variantId,
        },
      );
      const sessionCorrelation = {
        ...correlation,
        sessionId: session.sessionId,
      };
      correlation = sessionCorrelation;
      if (sequence !== requestSequence) {
        await stopSession(
          session,
          sessionCorrelation,
          "replaced",
          "try_on.cleanup_stale_session",
        );
        return;
      }
      const parsedPreviewUrl = visionTryOnPreviewUrlSchema.safeParse(
        session.previewUrl,
      );
      if (!parsedPreviewUrl.success) {
        try {
          await session.stop("error");
        } catch (error) {
          recordTryOnFailure("try_on.stop_preview", error, sessionCorrelation);
        }
        throw new Error("Vision returned a non-loopback preview URL");
      }
      activeSession.value = { session, correlation: sessionCorrelation };
      previewUrl.value = parsedPreviewUrl.data;
    } catch (error) {
      if (sequence === requestSequence) {
        if (isVisionTryOnCapabilityDegraded(error)) {
          visionStore.markTryOnCapabilityDegraded();
        }
        recordTryOnFailure("try_on.start_preview", error, correlation);
        errorMessage.value = projectCustomerError("device", error).message;
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
    const active = activeSession.value;
    activeSession.value = null;
    if (!active) return;
    await stopSession(
      active.session,
      active.correlation,
      reason,
      "try_on.stop_preview",
    );
  }

  async function stopSession(
    session: VisionTryOnSession,
    correlation: TryOnSessionCorrelation,
    reason: VisionTryOnStopReason,
    operation: string,
  ): Promise<void> {
    try {
      await session.stop(reason);
    } catch (error) {
      recordTryOnFailure(operation, error, correlation);
    }
  }

  function recordTryOnFailure(
    operation: string,
    error: unknown,
    correlation: TryOnSessionCorrelation,
  ): void {
    const projection = projectCustomerError("device", error);
    recordCustomerErrorEvidence({
      stage: projection.stage,
      customerMessage: projection.message,
      technicalError: error,
      operation,
      checkoutAttemptIdempotencyKey: null,
      orderId: null,
      paymentId: null,
      orderNo: null,
      tryOnSessionId: correlation.sessionId,
      tryOnCatalogKey: correlation.catalogKey,
      tryOnVariantId: correlation.variantId,
    });
  }

  return {
    previewUrl: readonly(previewUrl),
    errorMessage: readonly(errorMessage),
    isStarting: readonly(isStarting),
    startPreview,
    stopPreview,
  };
}
