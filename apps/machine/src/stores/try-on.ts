import { defineStore } from "pinia";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  openVisionGarmentAdjustment,
  openVisionTryOnAttempt,
  type VisionTryOnAttempt,
  type VisionTryOnAttemptEvent,
} from "@/native/vision";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";
import {
  canStartTryOn,
  validateTryOnCapturedFrame,
  validateTryOnPreviewReference,
  validateTryOnResultReference,
  visionGarmentSourceFor,
} from "@/try-on/eligibility";

export type TryOnPhase =
  | "idle"
  | "starting"
  | "accepted"
  | "acquiring"
  | "captured"
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
    context: null as TryOnContext | null,
    result: null as ReturnType<typeof validateTryOnResultReference> | null,
    resultUnavailable: false,
    failureReason: null as string | null,
    previewUrl: null as string | null,
    captured: null as ReturnType<typeof validateTryOnCapturedFrame> | null,
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
      state.phase === "captured" ||
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
    async start(item?: MachineCatalogItem): Promise<boolean> {
      if (item) this.prepare(item);
      const context = this.context;
      if (!context) return false;
      const attemptId = createAttemptId();
      const owner = beginOperation(attemptId);
      this.phase = "starting";
      this.attemptId = attemptId;
      this.result = null;
      this.resultUnavailable = false;
      this.failureReason = null;
      // 成衣缩放属于单个已完成结果；重试会新建捕获，必须回到合同规定的 100% 基线。
      this.garmentScale = 1;
      this.adjusting = false;
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
      const available = canStartTryOn(currentItem, vision);
      if (!currentItem || !available) {
        if (isCurrentOperation(owner, attemptId)) {
          this.phase = "failed";
          this.failureReason = "try_on_unavailable";
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
        const onCompletedResourceOwnerLost = (
          resultContext: Parameters<typeof this.applyEvent>[2],
        ) => {
          if (
            !isCurrentOperation(owner, attemptId) ||
            resultContext.attemptId !== attemptId ||
            this.phase !== "completed"
          ) {
            return;
          }
          this.result = null;
          this.resultUnavailable = true;
          this.adjusting = false;
          owner.controller.abort();
          clearOperation(owner);
        };
        const attempt = await openVisionTryOnAttempt(
          { machineCode: useMachineStore().machineCode },
          { attemptId, variantId: currentItem.variantId, garment },
          onEvent,
          owner.controller.signal,
          onCompletedResourceOwnerLost,
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
          this.failureReason = "try_on_unavailable";
          clearOperation(owner);
        }
        return false;
      }
    },
    async retry(): Promise<boolean> {
      return await this.start();
    },
    clear(): void {
      this.cancelCurrentAttempt("route_leave");
      cancelCurrentOperation();
      this.phase = "idle";
      this.attemptId = null;
      this.context = null;
      this.result = null;
      this.resultUnavailable = false;
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
        this.occupancy !== "single" ||
        this.guidance !== "counting_down" ||
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
    failCapturedPresentation(attemptId: string): void {
      const owner = currentOperation;
      if (
        this.attemptId !== attemptId ||
        !this.captured ||
        !isCurrentOperation(owner, attemptId)
      ) {
        return;
      }
      // 捕获 PNG 无法由浏览器解码时，不能继续向顾客展示可能属于另一帧的
      // preview 或早到结果。把该 attempt 作为失败结束并释放其原生资源 owner。
      this.phase = "failed";
      this.failureReason = "try_on_failed";
      this.result = null;
      this.resultUnavailable = false;
      this.clearAcquisitionPresentation();
      clearOperation(owner);
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
      // 回调闭包、签名协议载荷和结果上下文都必须指向同一活跃 attempt。另一位顾客的
      // 迟到资源不是可恢复的显示更新，必须保持当前 attempt 不变。
      if (
        this.attemptId !== attemptId ||
        event.payload.attemptId !== attemptId ||
        resultContext.attemptId !== attemptId
      )
        return;
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
            this.failureReason = "try_on_failed";
            this.clearAcquisitionPresentation();
            clearOperation(currentOperation);
          }
        }
        return;
      }
      if (event.type === "vision.try_on.attempt.generating") {
        if (
          this.phase === "captured" ||
          (this.phase === "generating" &&
            isGenerationStageAtLeast(event.payload.stage, this.generationStage))
        ) {
          this.phase = "generating";
          this.guidance = null;
          this.holdRemainingMs = null;
          this.occupancy = null;
          this.manualCaptureAllowed = false;
          this.manualCaptureSubmitted = false;
          this.generationStage = event.payload.stage;
        }
        return;
      }
      if (event.type === "vision.try_on.attempt.captured") {
        if (this.phase !== "acquiring") return;
        try {
          this.captured = validateTryOnCapturedFrame(
            event.payload.captured,
            resultContext,
          );
          this.phase = "captured";
        } catch {
          this.phase = "failed";
          this.failureReason = "try_on_failed";
          this.clearAcquisitionPresentation();
          clearOperation(currentOperation);
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
          this.resultUnavailable = false;
          // 保留已校验的捕获候选直到当前尝试真正结束。原生事件可以在同一个
          // Vue flush 中连续发出 captured、generating、completed；若这里清空，
          // 展示层就永远没有机会对同一张已加载图片做原子晋升。
          this.clearAcquisitionPresentation({
            clearCaptured: false,
            clearPreview: false,
          });
        } catch {
          this.phase = "failed";
          this.failureReason = "try_on_failed";
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
      const owner = currentOperation;
      if (
        this.phase !== "completed" ||
        this.attemptId === null ||
        !this.result ||
        this.resultUnavailable ||
        this.adjusting ||
        !isSupportedGarmentScale(scale) ||
        !isCurrentOperation(owner, this.attemptId)
      ) {
        return false;
      }
      const attemptId = this.attemptId;
      this.adjusting = true;
      try {
        const adjusted = await openVisionGarmentAdjustment(
          { machineCode: useMachineStore().machineCode },
          { attemptId, garmentScale: scale },
          owner.controller.signal,
        );
        if (
          this.attemptId !== attemptId ||
          this.phase !== "completed" ||
          this.resultUnavailable ||
          !isCurrentOperation(owner, attemptId)
        ) {
          return false;
        }
        this.result = validateTryOnResultReference(adjusted.result, {
          attemptId,
          visionSocketUrl: adjusted.visionSocketUrl,
        });
        this.garmentScale = scale;
        return true;
      } catch {
        return false;
      } finally {
        if (this.attemptId === attemptId) {
          this.adjusting = false;
        }
      }
    },
    clearAcquisitionPresentation({
      clearCaptured = true,
      clearPreview = true,
    } = {}): void {
      if (clearPreview) this.previewUrl = null;
      if (clearCaptured) this.captured = null;
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
  return ["preparing", "generating", "validating_result", "rendering"].indexOf(
    stage,
  );
}

function isSupportedGarmentScale(scale: number): boolean {
  const percent = scale * 100;
  const roundedPercent = Math.round(percent);
  const isWholePercent =
    Math.abs(percent - roundedPercent) <=
    Number.EPSILON * Math.max(1, Math.abs(percent)) * 4;
  return (
    Number.isFinite(scale) &&
    isWholePercent &&
    roundedPercent >= 80 &&
    roundedPercent <= 160 &&
    roundedPercent % 5 === 0
  );
}
