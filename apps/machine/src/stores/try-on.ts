import { defineStore } from "pinia";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  openVisionFastAttempt,
  type VisionFastAttempt,
  type VisionFastAttemptEvent,
} from "@/native/vision";
import { useCatalogStore } from "@/stores/catalog";
import { useMachineStore } from "@/stores/machine";
import { useVisionStore } from "@/stores/vision";
import {
  canStartFastTryOn,
  validateTryOnResultReference,
  visionGarmentSourceFor,
} from "@/try-on/eligibility";

export type TryOnPhase =
  | "idle"
  | "starting"
  | "accepted"
  | "generating"
  | "completed"
  | "failed";

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
    failureReason: null as string | null,
  }),
  getters: {
    hasActiveAttempt: (state): boolean =>
      state.phase === "starting" ||
      state.phase === "accepted" ||
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
    async startFast(item?: MachineCatalogItem): Promise<boolean> {
      if (item) this.prepare(item);
      const context = this.context;
      if (!context) return false;
      const attemptId = createAttemptId();
      const owner = beginOperation(attemptId);
      this.phase = "starting";
      this.attemptId = attemptId;
      this.result = null;
      this.failureReason = null;
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
      if (!currentItem || !canStartFastTryOn(currentItem, vision)) {
        if (isCurrentOperation(owner, attemptId)) {
          this.phase = "failed";
          this.failureReason = "fast_unavailable";
          clearOperation(owner);
        }
        return false;
      }
      try {
        const garment = visionGarmentSourceFor(currentItem);
        if (!isCurrentOperation(owner, attemptId)) return false;
        const attempt = await openVisionFastAttempt(
          { machineCode: useMachineStore().machineCode },
          { attemptId, variantId: currentItem.variantId, garment },
          (event, resultContext) => {
            if (isCurrentOperation(owner, attemptId)) {
              this.applyEvent(attemptId, event, resultContext);
            }
          },
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
          this.failureReason = "fast_unavailable";
          clearOperation(owner);
        }
        return false;
      }
    },
    async retry(): Promise<boolean> {
      return await this.startFast();
    },
    clear(): void {
      this.cancelCurrentAttempt();
      this.phase = "idle";
      this.attemptId = null;
      this.context = null;
      this.result = null;
      this.failureReason = null;
    },
    cancelCurrentAttempt(): void {
      cancelCurrentOperation();
    },
    applyEvent(
      attemptId: string,
      event: VisionFastAttemptEvent,
      resultContext: Parameters<typeof validateTryOnResultReference>[1],
    ): void {
      if (this.attemptId !== attemptId) return;
      if (event.type === "vision.try_on.attempt.accepted") {
        if (this.phase === "starting") this.phase = "accepted";
        return;
      }
      if (event.type === "vision.try_on.attempt.progress") {
        if (this.phase === "starting" || this.phase === "accepted") {
          this.phase = "generating";
        }
        return;
      }
      if (event.type === "vision.try_on.attempt.completed") {
        if (this.phase === "completed" || this.phase === "failed") return;
        try {
          this.result = validateTryOnResultReference(
            event.payload.result,
            resultContext,
          );
          this.phase = "completed";
          this.failureReason = null;
          clearOperation(currentOperation);
        } catch {
          this.phase = "failed";
          this.failureReason = "fast_failed";
          clearOperation(currentOperation);
        }
        return;
      }
      if (this.phase === "completed" || this.phase === "failed") return;
      this.phase = "failed";
      this.failureReason = event.payload.reason;
      clearOperation(currentOperation);
    },
  },
});

type OperationOwner = {
  generation: number;
  attemptId: string;
  controller: AbortController;
  attempt: VisionFastAttempt | null;
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
