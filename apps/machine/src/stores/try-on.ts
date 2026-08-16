import { defineStore } from "pinia";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  openVisionFastAttempt,
  openVisionGarmentAdjustment,
  openVisionTryOnAttempt,
  type VisionTryOnAttempt,
  type VisionTryOnAttemptEvent,
  type VisionTryOnMode,
} from "@/native/vision";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";
import {
  canStartAiTryOn,
  canStartFastTryOn,
  validateTryOnPreviewReference,
  validateTryOnResultReference,
  visionGarmentSourceFor,
} from "@/try-on/eligibility";

export type TryOnPhase =
  | "idle"
  | "starting"
  | "accepted"
  | "acquiring"
  | "generating"
  | "completed"
  | "failed"
  | "canceled";

export type TryOnGuidance =
  | "no_person"
  | "multiple_people"
  | "align"
  | "counting_down";

export type TryOnGenerationStage =
  | "preparing"
  | "loading_model"
  | "generating"
  | "validating_result"
  | "rendering";

type TryOnContext = {
  catalogKey: string;
  productId: string;
  variantId: string;
};

export const useTryOnStore = defineStore("tryOn", {
  state: () => ({
    phase: "idle" as TryOnPhase,
    attemptId: null as string | null,
    mode: null as VisionTryOnMode | null,
    context: null as TryOnContext | null,
    result: null as ReturnType<typeof validateTryOnResultReference> | null,
    failureReason: null as string | null,
    previewUrl: null as string | null,
    guidance: null as TryOnGuidance | null,
    holdRemainingMs: null as number | null,
    occupancy: null as "none" | "single" | "multiple" | null,
    manualCaptureAllowed: false,
    manualCaptureSubmitted: false,
    garmentScale: 1,
    adjusting: false,
    generationStage: null as TryOnGenerationStage | null,
  }),
  getters: {
    hasActiveAttempt: (state): boolean =>
      state.phase === "starting" ||
      state.phase === "accepted" ||
      state.phase === "acquiring" ||
      state.phase === "generating",
  },
  actions: {
    prepare(item: MachineCatalogItem): void {
      this.context = {
        catalogKey: item.catalogKey,
        productId: item.productId,
        variantId: item.variantId,
      };
    },
    async start(
      mode: VisionTryOnMode,
      item?: MachineCatalogItem,
    ): Promise<boolean> {
      if (item) this.prepare(item);
      const context = this.context;
      if (!context) return false;
      const attemptId = createAttemptId();
      const owner = beginOperation(attemptId);
      this.phase = "starting";
      this.attemptId = attemptId;
      this.mode = mode;
      this.result = null;
      this.failureReason = null;
      this.clearAcquisitionPresentation();
      let currentItem: MachineCatalogItem | null = null;
      try {
        // The route stores a stable selection only. Every start and retry
        // adopts the current daemon sale-view before it reads an association,
        // descriptor, readiness URL, or grant.
        const catalog = useCatalogStore();
        await catalog.refresh();
        if (!isCurrentOperation(owner, attemptId)) return false;
        currentItem = catalog.saleableVariantItemFor(
          context.catalogKey,
          context.variantId,
        );
      } catch {
        currentItem = null;
      }
      if (!isCurrentOperation(owner, attemptId)) return false;
      const vision = useVisionStore();
      const available =
        mode === "fast"
          ? canStartFastTryOn(currentItem, vision)
          : canStartAiTryOn(currentItem, vision);
      if (!currentItem || !available) {
        if (isCurrentOperation(owner, attemptId)) {
          this.phase = "failed";
          this.failureReason =
            mode === "fast" ? "fast_unavailable" : "ai_unavailable";
          clearOperation(owner);
        }
        return false;
      }
      try {
        const garment = visionGarmentSourceFor(currentItem);
        if (!isCurrentOperation(owner, attemptId)) return false;
        const onEvent = (
          event: VisionTryOnAttemptEvent,
          resultContext: Parameters<typeof this.applyEvent>[2],
        ) => {
          if (isCurrentOperation(owner, attemptId)) {
            this.applyEvent(attemptId, event, resultContext);
          }
        };
        const attempt =
          mode === "fast"
            ? await openVisionFastAttempt(
                { machineCode: useMachineStore().machineCode },
                { attemptId, variantId: currentItem.variantId, garment },
                onEvent,
                owner.controller.signal,
              )
            : await openVisionTryOnAttempt(
                { machineCode: useMachineStore().machineCode },
                { attemptId, mode, variantId: currentItem.variantId, garment },
                onEvent,
                owner.controller.signal,
              );
        if (!isCurrentOperation(owner, attemptId)) {
          attempt.close();
          return false;
        }
        owner.attempt = attempt;
        return true;
      } catch {
        if (isCurrentOperation(owner, attemptId)) {
          this.phase = "failed";
          this.failureReason =
            mode === "fast" ? "fast_unavailable" : "ai_unavailable";
          clearOperation(owner);
        }
        return false;
      }
    },
    async startFast(item?: MachineCatalogItem): Promise<boolean> {
      return await this.start("fast", item);
    },
    async startAi(item?: MachineCatalogItem): Promise<boolean> {
      return await this.start("ai", item);
    },
    async retry(): Promise<boolean> {
      return await this.start(this.mode ?? "fast");
    },
    clear(): void {
      this.cancelCurrentAttempt("route_leave");
      this.phase = "idle";
      this.attemptId = null;
      this.mode = null;
      this.context = null;
      this.result = null;
      this.failureReason = null;
      this.garmentScale = 1;
      this.adjusting = false;
      this.clearAcquisitionPresentation();
    },
    requestManualCapture(): boolean {
      const owner = currentOperation;
      if (
        this.phase !== "acquiring" ||
        !this.manualCaptureAllowed ||
        this.manualCaptureSubmitted ||
        !this.attemptId ||
        !isCurrentOperation(owner, this.attemptId)
      ) {
        return false;
      }
      const submitted = owner.attempt?.capture() ?? false;
      if (submitted) {
        this.manualCaptureSubmitted = true;
        this.manualCaptureAllowed = false;
      }
      return submitted;
    },
    cancelCurrentAttempt(reason: "user" | "route_leave" = "user"): boolean {
      const owner = currentOperation;
      if (!this.hasActiveAttempt || !this.attemptId || !owner) return false;
      const attemptId = this.attemptId;
      const sent = owner.attempt?.cancel(reason) ?? false;
      if (isCurrentOperation(owner, attemptId)) {
        owner.controller.abort();
        this.phase = "canceled";
        this.failureReason = reason;
        this.clearAcquisitionPresentation();
        clearOperation(owner);
      }
      return sent || owner.attempt === null;
    },
    applyEvent(
      attemptId: string,
      event: VisionTryOnAttemptEvent,
      resultContext: Parameters<typeof validateTryOnResultReference>[1],
    ): void {
      if (this.attemptId !== attemptId) return;
      if (event.type === "vision.try_on.attempt.accepted") {
        if (this.phase === "starting") this.phase = "accepted";
        return;
      }
      if (event.type === "vision.try_on.attempt.acquiring") {
        if (this.phase === "accepted" || this.phase === "acquiring") {
          try {
            const preview = validateTryOnPreviewReference(
              event.payload.preview,
              resultContext,
            );
            this.phase = "acquiring";
            this.previewUrl = preview.reference;
            this.guidance = event.payload.guidance;
            this.holdRemainingMs =
              "holdRemainingMs" in event.payload
                ? event.payload.holdRemainingMs
                : null;
            this.occupancy = event.payload.occupancy;
            // An accepted manual intent is irrevocable for this attempt.
            // Subsequent Vision guidance is current display truth only.
            this.manualCaptureAllowed = this.manualCaptureSubmitted
              ? false
              : event.payload.manualCaptureAllowed;
          } catch {
            this.phase = "failed";
            this.failureReason = "fast_failed";
            this.clearAcquisitionPresentation();
            clearOperation(currentOperation);
          }
        }
        return;
      }
      if (event.type === "vision.try_on.attempt.generating") {
        if (
          this.phase === "acquiring" ||
          (this.phase === "generating" &&
            isGenerationStageAtLeast(event.payload.stage, this.generationStage))
        ) {
          this.phase = "generating";
          this.clearAcquisitionPresentation();
          this.generationStage = event.payload.stage;
        }
        return;
      }
      if (event.type === "vision.try_on.attempt.completed") {
        if (this.phase !== "generating") return;
        try {
          this.result = validateTryOnResultReference(
            event.payload.result,
            resultContext,
          );
          this.phase = "completed";
          this.failureReason = null;
          this.clearAcquisitionPresentation();
          clearOperation(currentOperation);
          // A persisted garment scale survives retry: the fresh result is
          // immediately re-rendered at the customer's chosen proportion.
          void this.reapplyGarmentScale();
        } catch {
          this.phase = "failed";
          this.failureReason = "fast_failed";
          this.clearAcquisitionPresentation();
          clearOperation(currentOperation);
        }
        return;
      }
      if (
        this.phase === "completed" ||
        this.phase === "failed" ||
        this.phase === "canceled"
      )
        return;
      if (event.type === "vision.try_on.attempt.canceled") {
        this.phase = "canceled";
        this.failureReason = event.payload.reason;
        this.clearAcquisitionPresentation();
        clearOperation(currentOperation);
        return;
      }
      this.phase = "failed";
      this.failureReason = event.payload.reason;
      this.clearAcquisitionPresentation();
      clearOperation(currentOperation);
    },
    async requestGarmentScale(scale: number): Promise<boolean> {
      if (
        this.phase !== "completed" ||
        this.mode !== "fast" ||
        this.attemptId === null ||
        this.adjusting
      ) {
        return false;
      }
      const bounded = Math.min(1.6, Math.max(0.8, scale));
      const attemptId = this.attemptId;
      this.adjusting = true;
      try {
        const adjusted = await openVisionGarmentAdjustment(
          { machineCode: useMachineStore().machineCode },
          { attemptId, garmentScale: bounded },
        );
        if (this.attemptId !== attemptId || this.phase !== "completed") {
          return false;
        }
        this.result = validateTryOnResultReference(adjusted.result, {
          attemptId,
          visionSocketUrl: adjusted.visionSocketUrl,
        });
        this.garmentScale = bounded;
        return true;
      } catch {
        return false;
      } finally {
        this.adjusting = false;
      }
    },
    async reapplyGarmentScale(): Promise<void> {
      if (this.phase !== "completed" || this.mode !== "fast") return;
      if (this.garmentScale === 1) return;
      await this.requestGarmentScale(this.garmentScale);
    },
    clearAcquisitionPresentation(): void {
      this.previewUrl = null;
      this.guidance = null;
      this.holdRemainingMs = null;
      this.occupancy = null;
      this.manualCaptureAllowed = false;
      this.manualCaptureSubmitted = false;
      this.generationStage = null;
    },
  },
});

type OperationOwner = {
  generation: number;
  attemptId: string;
  controller: AbortController;
  attempt: VisionTryOnAttempt | null;
};

let nextOperationGeneration = 0;
let currentOperation: OperationOwner | null = null;

function beginOperation(attemptId: string): OperationOwner {
  cancelCurrentOperation();
  const owner = {
    generation: nextOperationGeneration + 1,
    attemptId,
    controller: new AbortController(),
    attempt: null,
  };
  nextOperationGeneration = owner.generation;
  currentOperation = owner;
  return owner;
}

function isCurrentOperation(
  owner: OperationOwner | null,
  attemptId: string,
): owner is OperationOwner {
  return (
    owner !== null &&
    currentOperation === owner &&
    owner.attemptId === attemptId &&
    !owner.controller.signal.aborted
  );
}

function cancelCurrentOperation(): void {
  if (!currentOperation) {
    nextOperationGeneration += 1;
    return;
  }
  const owner = currentOperation;
  currentOperation = null;
  nextOperationGeneration += 1;
  owner.controller.abort();
  owner.attempt?.close();
  owner.attempt = null;
}

function clearOperation(owner: OperationOwner | null): void {
  if (!owner || currentOperation !== owner) return;
  currentOperation = null;
  owner.attempt?.close();
  owner.attempt = null;
}

function createAttemptId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "550e8400-e29b-41d4-a716-446655440124";
}

function isGenerationStageAtLeast(
  candidate: TryOnGenerationStage,
  current: TryOnGenerationStage | null,
): boolean {
  if (current === null) return true;
  return generationStageOrder(candidate) >= generationStageOrder(current);
}

function generationStageOrder(stage: TryOnGenerationStage): number {
  return [
    "preparing",
    "loading_model",
    "generating",
    "validating_result",
    "rendering",
  ].indexOf(stage);
}
