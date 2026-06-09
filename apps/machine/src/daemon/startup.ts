import type {
  ConfigSummary,
  HealthSnapshot,
  ReadySnapshot,
  TransactionSnapshot,
} from "./schemas";

export type StartupRoute =
  | "/maintenance"
  | "/provisioning"
  | "/offline"
  | "/catalog"
  | "/payment"
  | "/dispensing"
  | { name: "result"; params: { kind: string } };

export function routeForStartup(input: {
  daemonAvailable: boolean;
  health: HealthSnapshot | null;
  config?: ConfigSummary | null;
  ready: ReadySnapshot | null;
  transaction: TransactionSnapshot | null;
}): StartupRoute {
  if (!input.daemonAvailable) return "/maintenance";
  if (!input.config) return "/provisioning";
  if (input.config?.provisioned === false) return "/provisioning";
  if (!input.health?.configConfigured) return "/maintenance";

  const next = input.transaction?.nextAction;
  if (next === "submit_payment" || next === "wait_payment") {
    return "/payment";
  }

  if (next === "dispensing") {
    return "/dispensing";
  }

  if (
    next === "success" ||
    next === "payment_failed" ||
    next === "payment_expired" ||
    next === "dispense_failed" ||
    next === "refund_pending" ||
    next === "refunded" ||
    next === "manual_handling" ||
    next === "closed"
  ) {
    return { name: "result", params: { kind: next } };
  }

  return input.ready?.canSell ? "/catalog" : "/offline";
}
