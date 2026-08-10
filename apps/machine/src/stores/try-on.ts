import { defineStore } from "pinia";

import type { MachineCatalogItem } from "@/types/catalog";

import {
  openVisionFastAttempt,
  type VisionFastAttempt,
  type VisionFastAttemptEvent,
} from "@/native/vision";
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
  item: MachineCatalogItem;
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
        item,
      };
    },
    async startFast(item: MachineCatalogItem): Promise<boolean> {
      const vision = useVisionStore();
      if (!canStartFastTryOn(item, vision)) return false;
      const attemptId = createAttemptId();
      const context: TryOnContext = {
        catalogKey: item.catalogKey,
        productId: item.productId,
        variantId: item.variantId,
        item,
      };
      this.context = context;
      this.cancelCurrentAttempt();
      this.phase = "starting";
      this.attemptId = attemptId;
      this.context = context;
      this.result = null;
      this.failureReason = null;
      try {
        const garment = visionGarmentSourceFor(item);
        const attempt = await openVisionFastAttempt(
          { machineCode: useMachineStore().machineCode },
          { attemptId, variantId: item.variantId, garment },
          (event) => {
            this.applyEvent(attemptId, event);
          },
        );
        activeAttempt = attempt;
        if (this.attemptId !== attemptId) attempt.close();
        return this.attemptId === attemptId;
      } catch {
        if (this.attemptId === attemptId) {
          this.phase = "failed";
          this.failureReason = "fast_unavailable";
        }
        return false;
      }
    },
    async retry(): Promise<boolean> {
      const item = this.context?.item;
      return item ? await this.startFast(item) : false;
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
      activeAttempt?.close();
      activeAttempt = null;
    },
    applyEvent(attemptId: string, event: VisionFastAttemptEvent): void {
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
          this.result = validateTryOnResultReference(event.payload.result);
          this.phase = "completed";
          this.failureReason = null;
        } catch {
          this.phase = "failed";
          this.failureReason = "fast_failed";
        }
        return;
      }
      if (this.phase === "completed" || this.phase === "failed") return;
      this.phase = "failed";
      this.failureReason = event.payload.reason;
    },
  },
});

let activeAttempt: VisionFastAttempt | null = null;

function createAttemptId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "550e8400-e29b-41d4-a716-446655440124";
}
