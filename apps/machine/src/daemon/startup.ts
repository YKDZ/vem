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
  restoredTransaction: TransactionSnapshot | null;
}): StartupRoute {
  if (!input.daemonAvailable) return "/maintenance";
  const transactionView = projectCustomerCheckoutView({
    transaction: input.restoredTransaction,
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

  // A missing or old daemon projection is not a compatibility mode. Fail
  // closed in Maintenance rather than reconstructing bring-up from legacy
  // config/readiness flags or presenting an offline bypass.
  if (!input.bringUp) return "/maintenance";

  // The daemon's current task is the authoritative Bring-Up cursor.  Do not
  // let a readiness summary make the console skip an unfinished task.
  if (input.bringUp.currentTask) return "/bring-up";

  const bringUpReady =
    input.bringUp?.state === "sell_ready" ||
    input.bringUp?.state === "runtime_ready" ||
    input.bringUp?.state === "simulated_hardware_ready";
  if (!bringUpReady) return "/maintenance";

  if (input.bringUp.state === "sell_ready") return "/catalog";
  if (
    bringUpReady &&
    (input.ready?.canSell || input.bringUp?.allowedActions.startSales)
  ) {
    return "/catalog";
  }
  return "/maintenance";
}

/**
 * A bounded Boot Check may fail after the transaction read succeeded (for
 * example health/ready/schema reads can reject). Keep the recovered customer
 * journey as the only navigation authority for that failure path.
 */
export function routeForBootFailure(
  restoredTransaction: TransactionSnapshot | null,
): StartupRoute {
  return routeForStartup({
    daemonAvailable: restoredTransaction !== null,
    health: null,
    config: null,
    bringUp: null,
    ready: null,
    restoredTransaction,
  });
}
