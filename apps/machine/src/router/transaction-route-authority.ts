import type { Pinia } from "pinia";
import type { RouteLocationRaw, Router } from "vue-router";

import { watch, type WatchStopHandle } from "vue";

import { useCheckoutStore } from "@/stores/checkout";
import { useConnectivityStore } from "@/stores/connectivity";

const DEFAULT_TOUCHSCREEN_SESSION_INACTIVITY_MS = 45_000;
const CUSTOMER_SESSION_ROUTE_NAMES = new Set([
  "product-detail",
  "virtual-try-on",
  "checkout",
  "payment",
]);
const MAX_RUNTIME_TRACE_RECORDS = 200;

export type MachineNavigationIntent =
  | { type: "customer.navigate"; target: RouteLocationRaw }
  | { type: "customer.touch"; atMs?: number }
  | { type: "customer.inactive"; atMs?: number }
  | { type: "presence.departed" }
  | { type: "readiness.navigate"; target: RouteLocationRaw }
  | { type: "startup.navigate"; target: RouteLocationRaw }
  | { type: "operator.navigate"; target: RouteLocationRaw }
  | { type: "transaction.projection" };

export type MachineRuntimeTraceRecord = {
  id: number;
  at: string;
  intentType: MachineNavigationIntent["type"];
  decision: "accepted" | "rejected" | "delayed";
  reasonCode: string;
  fromRoute: string;
  targetRoute: string | null;
  transactionOrderNo: string | null;
  transactionStage: string;
  readinessRevision: string | null;
  touchscreenSessionActive: boolean;
};

export class MachineRuntimeTrace {
  private records: MachineRuntimeTraceRecord[] = [];
  private nextId = 1;

  record(record: Omit<MachineRuntimeTraceRecord, "id" | "at">): void {
    this.records.push({
      id: this.nextId,
      at: new Date().toISOString(),
      ...record,
    });
    this.nextId += 1;
    if (this.records.length > MAX_RUNTIME_TRACE_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RUNTIME_TRACE_RECORDS);
    }
  }

  snapshot(): readonly MachineRuntimeTraceRecord[] {
    return this.records;
  }
}

export type MachineNavigationAuthority = {
  submit(intent: MachineNavigationIntent): Promise<void>;
  dispose(): void;
  trace: MachineRuntimeTrace;
};

type AuthorityOptions = {
  now?: () => number;
  touchscreenSessionInactivityMs?: number;
};

function routeTargetForTransaction(
  checkoutStore: ReturnType<typeof useCheckoutStore>,
): RouteLocationRaw | null {
  const view = checkoutStore.customerCheckoutView;
  return view.stage === "none" ? null : view.routeTarget;
}

function routeName(router: Router): string {
  const name = router.currentRoute.value.name;
  return typeof name === "string" ? name : "";
}

function routePath(router: Router, target: RouteLocationRaw): string {
  return router.resolve(target).fullPath;
}

export function createMachineNavigationAuthority(
  router: Router,
  pinia: Pinia,
  options: AuthorityOptions = {},
): MachineNavigationAuthority {
  const checkoutStore = useCheckoutStore(pinia);
  const connectivityStore = useConnectivityStore(pinia);
  const trace = new MachineRuntimeTrace();
  const now = options.now ?? Date.now;
  const inactivityMs =
    options.touchscreenSessionInactivityMs ??
    DEFAULT_TOUCHSCREEN_SESSION_INACTIVITY_MS;
  let touchscreenSessionActive = false;
  let lastTouchAtMs: number | null = null;
  let inactivityTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  function transactionStage(): string {
    return checkoutStore.customerCheckoutView.stage;
  }

  function record(
    intent: MachineNavigationIntent,
    decision: MachineRuntimeTraceRecord["decision"],
    reasonCode: string,
    target: RouteLocationRaw | null,
  ): void {
    trace.record({
      intentType: intent.type,
      decision,
      reasonCode,
      fromRoute: router.currentRoute.value.fullPath,
      targetRoute: target ? routePath(router, target) : null,
      transactionOrderNo: checkoutStore.customerCheckoutView.orderCredential,
      transactionStage: transactionStage(),
      readinessRevision: connectivityStore.ready?.updatedAt ?? null,
      touchscreenSessionActive,
    });
  }

  function clearInactivityTimer(): void {
    if (inactivityTimer !== null) {
      globalThis.clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }
  }

  function scheduleInactivity(): void {
    clearInactivityTimer();
    if (lastTouchAtMs === null) return;
    const observedTouchAt = lastTouchAtMs;
    inactivityTimer = globalThis.setTimeout(() => {
      void submit({ type: "customer.inactive", atMs: observedTouchAt });
    }, inactivityMs);
  }

  async function writeRoute(target: RouteLocationRaw): Promise<void> {
    if (routePath(router, target) === router.currentRoute.value.fullPath) {
      return;
    }
    await router.replace(target);
  }

  async function submit(intent: MachineNavigationIntent): Promise<void> {
    const transactionTarget = routeTargetForTransaction(checkoutStore);
    if (transactionTarget && intent.type !== "customer.touch") {
      if (intent.type === "transaction.projection") {
        await writeRoute(transactionTarget);
        record(intent, "accepted", "transaction_projection", transactionTarget);
        return;
      }
      const requestedTarget = "target" in intent ? intent.target : null;
      if (
        requestedTarget &&
        routePath(router, requestedTarget) ===
          routePath(router, transactionTarget)
      ) {
        record(
          intent,
          "accepted",
          "transaction_projection_current",
          transactionTarget,
        );
        return;
      }
      await writeRoute(transactionTarget);
      record(intent, "rejected", "active_transaction_route", transactionTarget);
      return;
    }

    if (intent.type === "customer.touch") {
      touchscreenSessionActive = true;
      lastTouchAtMs = intent.atMs ?? now();
      scheduleInactivity();
      record(intent, "accepted", "touchscreen_session_renewed", null);
      return;
    }

    if (intent.type === "customer.inactive") {
      if (intent.atMs !== undefined && intent.atMs !== lastTouchAtMs) {
        record(intent, "rejected", "stale_touchscreen_inactivity", null);
        return;
      }
      touchscreenSessionActive = false;
      lastTouchAtMs = null;
      clearInactivityTimer();
      const target = { name: "catalog" };
      await writeRoute(target);
      record(intent, "accepted", "touchscreen_session_expired", target);
      return;
    }

    if (intent.type === "presence.departed") {
      if (touchscreenSessionActive) {
        record(intent, "rejected", "touchscreen_session_active", null);
        return;
      }
      if (!CUSTOMER_SESSION_ROUTE_NAMES.has(routeName(router))) {
        record(intent, "rejected", "route_not_departure_eligible", null);
        return;
      }
      const target = { name: "catalog" };
      await writeRoute(target);
      record(intent, "accepted", "presence_departure", target);
      return;
    }

    if (
      intent.type === "readiness.navigate" &&
      touchscreenSessionActive &&
      CUSTOMER_SESSION_ROUTE_NAMES.has(routeName(router))
    ) {
      record(intent, "rejected", "touchscreen_session_active", intent.target);
      return;
    }

    if (intent.type === "transaction.projection") {
      record(intent, "rejected", "no_active_transaction", null);
      return;
    }

    await writeRoute(intent.target);
    record(
      intent,
      "accepted",
      `${intent.type.replace(".", "_")}_accepted`,
      intent.target,
    );
  }

  const stopTransactionProjection: WatchStopHandle = watch(
    () => checkoutStore.customerCheckoutView.routeTarget,
    () => {
      if (router.currentRoute.value.matched.length === 0) return;
      void submit({ type: "transaction.projection" });
    },
    { deep: true },
  );
  const removeRouteGuard = router.beforeEach((to) => {
    const transactionTarget = routeTargetForTransaction(checkoutStore);
    if (!transactionTarget) return;
    if (router.resolve(transactionTarget).fullPath === to.fullPath) return;
    return transactionTarget;
  });
  const onDirectPointerInteraction = (event: PointerEvent | Event): void => {
    if (
      "pointerType" in event &&
      typeof event.pointerType === "string" &&
      event.pointerType.length > 0 &&
      event.pointerType !== "touch"
    ) {
      return;
    }
    void submit({ type: "customer.touch" });
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pointerdown", onDirectPointerInteraction, {
      passive: true,
    });
  }

  return {
    submit,
    trace,
    dispose() {
      clearInactivityTimer();
      stopTransactionProjection();
      removeRouteGuard();
      if (typeof window !== "undefined") {
        window.removeEventListener("pointerdown", onDirectPointerInteraction);
      }
    },
  };
}

let installedAuthority: MachineNavigationAuthority | null = null;

export function machineRuntimeTrace(): readonly MachineRuntimeTraceRecord[] {
  return installedAuthority?.trace.snapshot() ?? [];
}

export function installTransactionRouteAuthority(
  router: Router,
  pinia: Pinia,
): () => void {
  installedAuthority?.dispose();
  installedAuthority = createMachineNavigationAuthority(router, pinia);
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "__VEM_MACHINE_RUNTIME_TRACE__", {
      configurable: true,
      get: machineRuntimeTrace,
    });
  }
  return () => {
    installedAuthority?.dispose();
    installedAuthority = null;
    if (typeof window !== "undefined") {
      delete (window as Window & { __VEM_MACHINE_RUNTIME_TRACE__?: unknown })
        .__VEM_MACHINE_RUNTIME_TRACE__;
    }
  };
}

export async function submitMachineNavigationIntent(
  intent: MachineNavigationIntent,
): Promise<void> {
  if (!installedAuthority) {
    throw new Error("Machine Navigation Authority is not installed");
  }
  await installedAuthority.submit(intent);
}
