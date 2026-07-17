import {
  projectCustomerCheckoutView,
  type CustomerCheckoutRouteTarget,
} from "@/checkout/customer-checkout-view";
import type { EffectiveMachineRuntimeConfiguration } from "@vem/shared";

import type { TransactionSnapshot } from "./schemas";

export type StartupRoute =
  | "/maintenance"
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
  effectiveRuntimeConfiguration: EffectiveMachineRuntimeConfiguration | null;
  restoredTransaction: TransactionSnapshot | null;
}): StartupRoute {
  if (!input.daemonAvailable) return "/maintenance";
  const transactionView = projectCustomerCheckoutView({
    transaction: input.restoredTransaction,
    nowMs: Date.now(),
    dismissedTerminalOrderNos: [],
    restored: true,
    readiness: {
      saleReady: false,
      suggestedRoute: "offline",
      requiresMaintenanceReview: false,
    },
  });
  if (transactionView.stage !== "none") {
    return startupRouteFromProjectionTarget(transactionView.routeTarget);
  }

  // Claim acceptance and the resulting machine identity are the startup
  // authority. Readiness and the cache's renderer shape are operational
  // observations; neither may move a claimed machine into Local Operations.
  const configuration = input.effectiveRuntimeConfiguration;
  return configuration !== null &&
    configuration.profileRefresh.status === "accepted" &&
    configuration.machine !== null
    ? "/catalog"
    : "/maintenance";
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
    effectiveRuntimeConfiguration: null,
    restoredTransaction,
  });
}
