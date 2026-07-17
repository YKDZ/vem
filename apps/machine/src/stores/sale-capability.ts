import type { MachinePaymentOption } from "@vem/shared";

import { defineStore } from "pinia";

import type {
  SaleStartCapabilityChangedEvent,
  SaleStartCapabilitySnapshot,
} from "@/daemon/schemas";

import { daemonClient } from "@/daemon/client";

const CAPABILITY_POLL_INTERVAL_MS = 15_000;
const RETIRED_GENERATION_LIMIT = 8;
const SUPPORTED_OPTION_KEYS = [
  "mock:mock",
  "qr_code:wechat_pay",
  "qr_code:alipay",
  "payment_code:mock",
  "payment_code:wechat_pay",
  "payment_code:alipay",
] as const;
const SUPPORTED_PROVIDER_CODES = ["mock", "wechat_pay", "alipay"] as const;
const SUPPORTED_PAYMENT_METHODS = [
  "mock",
  "qr_code",
  "face_pay",
  "payment_code",
] as const;
const SUPPORTED_PAYMENT_ICONS = ["mock", "wechat", "alipay"] as const;

type RuntimeCoordinator = {
  subscription: { close(): void } | null;
  pollTimer: ReturnType<typeof globalThis.setInterval> | null;
};

const runtimeCoordinators = new WeakMap<object, RuntimeCoordinator>();

function runtimeCoordinator(store: object): RuntimeCoordinator {
  const existing = runtimeCoordinators.get(store);
  if (existing) return existing;
  const created: RuntimeCoordinator = { subscription: null, pollTimer: null };
  runtimeCoordinators.set(store, created);
  return created;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSupportedValue<Value extends string>(
  value: string,
  supported: readonly Value[],
): value is Value {
  return supported.some((candidate) => candidate === value);
}

function asPaymentOption(
  option: SaleStartCapabilitySnapshot["paymentOptions"]["options"][number],
): MachinePaymentOption | null {
  if (
    !isSupportedValue(option.optionKey, SUPPORTED_OPTION_KEYS) ||
    !isSupportedValue(option.providerCode, SUPPORTED_PROVIDER_CODES) ||
    !isSupportedValue(option.method, SUPPORTED_PAYMENT_METHODS) ||
    !isSupportedValue(option.icon, SUPPORTED_PAYMENT_ICONS)
  ) {
    return null;
  }
  return {
    optionKey: option.optionKey,
    providerCode: option.providerCode,
    method: option.method,
    displayName: option.displayName,
    description: option.description,
    icon: option.icon,
    recommended: option.recommended,
    disabled: !option.ready,
    disabledReason: option.disabledReason,
  };
}

export const useSaleCapabilityStore = defineStore("sale-capability", {
  state: () => ({
    accepted: null as SaleStartCapabilitySnapshot | null,
    retiredGenerations: [] as string[],
    updating: false,
    stale: false,
    diagnostic: null as string | null,
    lastRejectedObservation: null as string | null,
    refreshSequence: 0,
    latestAcceptedRefreshSequence: 0,
    latestRefreshOutcomeSequence: 0,
    refreshesInFlight: 0,
  }),
  getters: {
    canStartSale: (state): boolean => state.accepted?.canStartSale === true,
    orderingKey: (state): string | null =>
      state.accepted
        ? `${state.accepted.generation}:${state.accepted.revision}`
        : null,
    blockerCodes: (state): string[] =>
      state.accepted?.blockers.map((reason) => reason.code) ?? [],
    blockingMessages: (state): string[] =>
      state.accepted?.blockers.map((reason) => reason.message) ?? [],
    degradationMessages: (state): string[] =>
      state.accepted?.degradations.map((reason) => reason.message) ?? [],
    paymentOptions: (state): MachinePaymentOption[] =>
      state.accepted?.paymentOptions.options.flatMap((option) => {
        const supported = asPaymentOption(option);
        return supported ? [supported] : [];
      }) ?? [],
    defaultPaymentOptionKey: (state): string | null =>
      state.accepted?.paymentOptions.defaultOptionKey ?? null,
    hasAcceptedCapability: (state): boolean => state.accepted !== null,
    hasBlocker:
      (state) =>
      (code: string): boolean =>
        state.accepted?.blockers.some((reason) => reason.code === code) ??
        false,
  },
  actions: {
    acceptSnapshot(
      snapshot: SaleStartCapabilitySnapshot,
      refreshSequence?: number,
    ): boolean {
      const current = this.accepted;
      if (current?.generation === snapshot.generation) {
        if (snapshot.revision <= current.revision) {
          this.lastRejectedObservation = `${snapshot.generation}:${snapshot.revision}`;
          return false;
        }
      } else if (
        this.retiredGenerations.includes(snapshot.generation) ||
        (current !== null &&
          refreshSequence !== undefined &&
          refreshSequence < this.latestAcceptedRefreshSequence)
      ) {
        this.lastRejectedObservation = `${snapshot.generation}:${snapshot.revision}`;
        return false;
      } else if (current) {
        this.retiredGenerations = [
          ...this.retiredGenerations.filter(
            (generation) => generation !== current.generation,
          ),
          current.generation,
        ].slice(-RETIRED_GENERATION_LIMIT);
      }

      this.accepted = snapshot;
      if (refreshSequence !== undefined) {
        this.latestAcceptedRefreshSequence = Math.max(
          this.latestAcceptedRefreshSequence,
          refreshSequence,
        );
      }
      this.lastRejectedObservation = null;
      return true;
    },
    async refresh(): Promise<SaleStartCapabilitySnapshot | null> {
      this.refreshSequence += 1;
      const requestSequence = this.refreshSequence;
      this.refreshesInFlight += 1;
      this.updating = true;
      try {
        const snapshot = await daemonClient.getSaleStartCapability();
        this.acceptSnapshot(snapshot, requestSequence);
        if (requestSequence >= this.latestRefreshOutcomeSequence) {
          this.latestRefreshOutcomeSequence = requestSequence;
          this.stale = false;
          this.diagnostic = null;
        }
        return this.accepted;
      } catch (error) {
        if (requestSequence >= this.latestRefreshOutcomeSequence) {
          this.latestRefreshOutcomeSequence = requestSequence;
          this.stale = true;
          this.diagnostic = errorMessage(error);
        }
        return this.accepted;
      } finally {
        this.refreshesInFlight = Math.max(0, this.refreshesInFlight - 1);
        this.updating = this.refreshesInFlight > 0;
      }
    },
    invalidate(event: SaleStartCapabilityChangedEvent): void {
      const current = this.accepted;
      if (
        (current?.generation === event.generation &&
          event.revision <= current.revision) ||
        this.retiredGenerations.includes(event.generation)
      ) {
        return;
      }
      void this.refresh();
    },
    markStale(error: unknown): void {
      this.stale = true;
      this.diagnostic = errorMessage(error);
    },
    startRuntime(): void {
      const coordinator = runtimeCoordinator(this);
      if (coordinator.subscription) return;

      void this.refresh();
      coordinator.subscription = daemonClient.subscribeEvents({
        onEvent: (event) => {
          if (event.type === "sale_start_capability_changed") {
            this.invalidate(event);
          }
        },
        onError: (error) => {
          this.markStale(error);
        },
        onStale: () => void this.refresh(),
      });
      coordinator.pollTimer = globalThis.setInterval(() => {
        void this.refresh();
      }, CAPABILITY_POLL_INTERVAL_MS);
    },
    stopRuntime(): void {
      const coordinator = runtimeCoordinator(this);
      coordinator.subscription?.close();
      coordinator.subscription = null;
      if (coordinator.pollTimer !== null) {
        globalThis.clearInterval(coordinator.pollTimer);
        coordinator.pollTimer = null;
      }
    },
  },
});
