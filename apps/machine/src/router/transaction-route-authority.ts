import type { Pinia } from "pinia";
import type { RouteLocationRaw, Router } from "vue-router";

import { watch, type WatchStopHandle } from "vue";

import { useCheckoutStore } from "@/stores/checkout";
import { useSaleCapabilityStore } from "@/stores/sale-capability";

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
  | { type: "transaction.dismiss"; target: RouteLocationRaw }
  | { type: "browser.navigate"; target: RouteLocationRaw }
  | { type: "transaction.projection" };

export type MachineRuntimeTraceRecord = {
  id: number;
  at: string;
  intentType: MachineNavigationIntent["type"];
  decision: "accepted" | "rejected" | "delayed";
  reasonCode: string;
  fromRoute: string;
  requestedRoute: string | null;
  decidedRoute: string | null;
  finalRoute: string | null;
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
    this.records.push(
      Object.freeze({
        id: this.nextId,
        at: new Date().toISOString(),
        ...record,
      }),
    );
    this.nextId += 1;
    if (this.records.length > MAX_RUNTIME_TRACE_RECORDS) {
      this.records.splice(0, this.records.length - MAX_RUNTIME_TRACE_RECORDS);
    }
  }

  snapshot(): readonly MachineRuntimeTraceRecord[] {
    return Object.freeze(
      this.records.map((record) => Object.freeze({ ...record })),
    );
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
  if (checkoutStore.paymentCreationAttemptActive) {
    return { name: "checkout" };
  }
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
  const saleCapabilityStore = useSaleCapabilityStore(pinia);
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
    input: {
      fromRoute: string;
      requested: RouteLocationRaw | null;
      decided: RouteLocationRaw | null;
      final?: RouteLocationRaw | null;
    },
  ): void {
    const requestedRoute = input.requested
      ? routePath(router, input.requested)
      : null;
    const decidedRoute = input.decided
      ? routePath(router, input.decided)
      : null;
    const finalRoute = input.final
      ? routePath(router, input.final)
      : decidedRoute;
    trace.record({
      intentType: intent.type,
      decision,
      reasonCode,
      fromRoute: input.fromRoute,
      requestedRoute,
      decidedRoute,
      finalRoute,
      targetRoute: finalRoute,
      transactionOrderNo: checkoutStore.customerCheckoutView.orderCredential,
      transactionStage: transactionStage(),
      readinessRevision: saleCapabilityStore.orderingKey,
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
    const fromRoute = router.currentRoute.value.fullPath;
    const requestedTarget = "target" in intent ? intent.target : null;
    const recordDecision = (
      decision: MachineRuntimeTraceRecord["decision"],
      reasonCode: string,
      decided: RouteLocationRaw | null,
    ): void => {
      // Trace inputs are resolved before any router write so the record stays
      // diagnostic even when a subsequent browser guard redirects again.
      record(intent, decision, reasonCode, {
        fromRoute,
        requested: requestedTarget,
        decided,
      });
    };

    if (intent.type === "transaction.dismiss") {
      if (checkoutStore.customerCheckoutView.stage !== "result") {
        recordDecision("rejected", "no_terminal_transaction_to_dismiss", null);
        return;
      }
      checkoutStore.dismissCurrentTerminalTransaction();
      recordDecision(
        "accepted",
        "terminal_transaction_dismissed",
        intent.target,
      );
      await writeRoute(intent.target);
      return;
    }

    const transactionTarget = routeTargetForTransaction(checkoutStore);
    if (transactionTarget && intent.type !== "customer.touch") {
      if (intent.type === "transaction.projection") {
        recordDecision("accepted", "transaction_projection", transactionTarget);
        await writeRoute(transactionTarget);
        return;
      }
      if (
        requestedTarget &&
        routePath(router, requestedTarget) ===
          routePath(router, transactionTarget)
      ) {
        recordDecision(
          "accepted",
          "transaction_projection_current",
          transactionTarget,
        );
        return;
      }
      recordDecision("rejected", "active_transaction_route", transactionTarget);
      await writeRoute(transactionTarget);
      return;
    }

    if (intent.type === "customer.touch") {
      touchscreenSessionActive = true;
      lastTouchAtMs = intent.atMs ?? now();
      scheduleInactivity();
      recordDecision("accepted", "touchscreen_session_renewed", null);
      return;
    }

    if (intent.type === "customer.inactive") {
      if (intent.atMs !== undefined && intent.atMs !== lastTouchAtMs) {
        recordDecision("rejected", "stale_touchscreen_inactivity", null);
        return;
      }
      touchscreenSessionActive = false;
      lastTouchAtMs = null;
      clearInactivityTimer();
      if (!CUSTOMER_SESSION_ROUTE_NAMES.has(routeName(router))) {
        recordDecision("rejected", "route_not_inactivity_eligible", null);
        return;
      }
      const target = { name: "catalog" };
      recordDecision("accepted", "touchscreen_session_expired", target);
      await writeRoute(target);
      return;
    }

    if (intent.type === "presence.departed") {
      if (touchscreenSessionActive) {
        recordDecision("rejected", "touchscreen_session_active", null);
        return;
      }
      if (!CUSTOMER_SESSION_ROUTE_NAMES.has(routeName(router))) {
        recordDecision("rejected", "route_not_departure_eligible", null);
        return;
      }
      const target = { name: "catalog" };
      recordDecision("accepted", "presence_departure", target);
      await writeRoute(target);
      return;
    }

    if (
      intent.type === "readiness.navigate" &&
      touchscreenSessionActive &&
      CUSTOMER_SESSION_ROUTE_NAMES.has(routeName(router))
    ) {
      recordDecision("rejected", "touchscreen_session_active", intent.target);
      return;
    }

    if (intent.type === "transaction.projection") {
      recordDecision("rejected", "no_active_transaction", null);
      return;
    }

    recordDecision(
      "accepted",
      `${intent.type.replace(".", "_")}_accepted`,
      intent.target,
    );
    await writeRoute(intent.target);
  }

  const stopTransactionProjection: WatchStopHandle = watch(
    () => routeTargetForTransaction(checkoutStore),
    (target) => {
      if (router.currentRoute.value.matched.length === 0) return;
      if (!target) return;
      void submit({ type: "transaction.projection" });
    },
    { deep: true },
  );
  const removeRouteGuard = router.beforeEach((to, from) => {
    const transactionTarget = routeTargetForTransaction(checkoutStore);
    const intent: MachineNavigationIntent = {
      type: "browser.navigate",
      target: to,
    };
    const fromRoute = from.fullPath;
    const requested = to.redirectedFrom ?? to;
    if (
      transactionTarget &&
      router.resolve(transactionTarget).fullPath !== to.fullPath
    ) {
      record(intent, "rejected", "active_transaction_route", {
        fromRoute,
        requested,
        decided: transactionTarget,
      });
      return transactionTarget;
    }
    record(intent, "accepted", "browser_navigation_accepted", {
      fromRoute,
      requested,
      decided: to,
    });
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
