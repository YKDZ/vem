import {
  projectCustomerCheckoutView,
  type CustomerCheckoutRouteTarget,
} from "@/checkout/customer-checkout-view";

import type {
  BringUpSnapshot,
  ConfigSummary,
  HealthSnapshot,
  ReadySnapshot,
  TransactionSnapshot,
} from "./schemas";

export type StartupRoute =
  | "/maintenance"
  | "/bring-up"
  | "/offline"
  | "/catalog"
  | "/payment"
  | "/dispensing"
  | { name: "result"; params: { kind: string } };

function startupRouteFromProjectionTarget(
  target: CustomerCheckoutRouteTarget,
): StartupRoute {
  if ("path" in target) return target.path;
  if (target.name === "payment") return "/payment";
  if (target.name === "catalog") return "/catalog";
  return target;
}

export function routeForStartup(input: {
  daemonAvailable: boolean;
  health: HealthSnapshot | null;
  config?: ConfigSummary | null;
  bringUp?: BringUpSnapshot | null;
  ready: ReadySnapshot | null;
  transaction: TransactionSnapshot | null;
}): StartupRoute {
  if (!input.daemonAvailable) return "/maintenance";
  const transactionView = projectCustomerCheckoutView({
    transaction: input.transaction,
    nowMs: Date.now(),
    dismissedTerminalOrderNos: [],
    restored: true,
    readiness: {
      saleReady: input.ready?.canSell === true,
      suggestedRoute:
        input.ready?.suggestedRoute === "maintenance"
          ? "maintenance"
          : input.ready?.suggestedRoute === "catalog"
            ? "catalog"
            : "offline",
      requiresMaintenanceReview:
        input.ready?.suggestedRoute === "maintenance" ||
        input.ready?.blockingCodes.includes("WHOLE_MACHINE_HARDWARE_FAULT") ===
          true,
    },
  });
  if (transactionView.stage !== "none") {
    return startupRouteFromProjectionTarget(transactionView.routeTarget);
  }

  const bringUpReady =
    input.bringUp?.state === "sell_ready" ||
    input.bringUp?.state === "runtime_ready" ||
    input.bringUp?.state === "simulated_hardware_ready";
  if (input.bringUp && !bringUpReady) {
    return "/bring-up";
  }
  if (!input.bringUp) {
    if (!input.config) return "/bring-up";
    if (!input.config.provisioned) return "/bring-up";
    if (!input.health?.configConfigured) return "/maintenance";
  }

  if (input.bringUp?.state === "sell_ready") return "/catalog";
  if (
    bringUpReady &&
    (input.ready?.canSell || input.bringUp?.allowedActions.startSales)
  ) {
    return "/catalog";
  }
  if (input.ready?.canSell) return "/catalog";
  if (input.ready?.suggestedRoute === "maintenance") return "/maintenance";
  return "/offline";
}
