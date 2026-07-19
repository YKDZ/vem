function sessionIdFromReport(value) {
  if (value == null || typeof value !== "object") return null;
  if (
    typeof value.sessionId === "string" &&
    value.sessionId &&
    !value.sessionId.startsWith("serial-session://")
  )
    return value.sessionId;
  for (const child of Object.values(value)) {
    const sessionId = sessionIdFromReport(child);
    if (sessionId) return sessionId;
  }
  return null;
}

function terminalRoute(route) {
  return route === "#/catalog" || /^#\/result(?:\/|$)/.test(route ?? "");
}

const terminalNextActions = new Set([
  "success",
  "payment_expired",
  "payment_failed",
  "dispense_failed",
  "refund_pending",
  "refunded",
  "manual_handling",
  "closed",
]);

const terminalOrderStatuses = new Set([
  "fulfilled",
  "succeeded",
  "failed",
  "payment_expired",
  "payment_failed",
  "canceled",
  "cancelled",
  "expired",
  "dispense_failed",
  "refunded",
  "partial_refunded",
  "manual_handling",
  "closed",
]);

const activeNextActions = new Set(["wait_payment", "dispensing"]);
const activeOrderStatuses = new Set([
  "waiting_payment",
  "pending_payment",
  "paid",
  "dispensing",
]);

export function isTerminalTransaction(transaction) {
  if (typeof transaction !== "object" || transaction == null) return false;
  if (
    typeof transaction.nextAction === "string" &&
    terminalNextActions.has(transaction.nextAction)
  )
    return true;
  if (
    typeof transaction.orderStatus === "string" &&
    terminalOrderStatuses.has(transaction.orderStatus)
  )
    return true;
  return false;
}

export function isActiveTransaction(transaction) {
  if (typeof transaction !== "object" || transaction == null) return false;
  if (isTerminalTransaction(transaction)) return false;
  if (
    typeof transaction.nextAction === "string" &&
    activeNextActions.has(transaction.nextAction)
  )
    return true;
  if (
    typeof transaction.orderStatus === "string" &&
    activeOrderStatuses.has(transaction.orderStatus)
  )
    return true;
  return false;
}

function transactionLeaked(transaction) {
  return isActiveTransaction(transaction);
}

function terminalPolicyFailures(track, facts) {
  const failures = [];
  if (transactionLeaked(facts.transaction))
    failures.push("transaction remains active");
  if (!facts.inventory || typeof facts.inventory !== "object")
    failures.push("inventory fact is absent");
  return failures;
}

export async function captureTrackTerminalFacts({
  track,
  context,
  readRoute,
  daemonGet,
  platformQuery,
}) {
  const diagnostics = [];
  const observe = async (label, operation) => {
    try {
      return await operation();
    } catch (error) {
      diagnostics.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };
  const facts = {
    route: await observe("route", readRoute),
    transaction: await observe("transaction", () =>
      daemonGet("/v1/transactions/current"),
    ),
    saleStartCapability: await observe("saleStartCapability", () =>
      daemonGet("/v1/sale-start-capability"),
    ),
    saleView: await observe("saleView", () => daemonGet("/v1/sale-view")),
    hardwareBindings: await observe("hardwareBindings", () =>
      daemonGet("/v1/hardware-bindings"),
    ),
    inventory: await observe("inventory", platformQuery),
    deviceSession: { sessionId: sessionIdFromReport(context?.report) },
  };
  if (diagnostics.length > 0) {
    return {
      ok: false,
      facts,
      reason: `${track.key} terminal facts are incomplete: ${diagnostics.join("; ")}`,
      diagnostics,
    };
  }
  if (!terminalRoute(facts.route)) {
    return {
      ok: false,
      facts,
      reason: `${track.key} terminal route is not settled: ${facts.route ?? "missing"}`,
      diagnostics,
    };
  }
  const policyFailures = terminalPolicyFailures(track, facts);
  if (policyFailures.length > 0) {
    return {
      ok: false,
      facts,
      reason: `${track.key} terminal policy failed: ${policyFailures.join("; ")}`,
      diagnostics: policyFailures,
    };
  }
  return { ok: true, facts, reason: null, diagnostics };
}

export async function recoverTrackHandoff({
  track,
  terminal,
  fixtureAllocation,
  returnToCatalog,
  disableFaultInjection,
  restoreSerialSession,
  restoreFixtureStock,
  cancelActiveTransaction,
  waitForTransactionTerminal,
}) {
  const actions = [];
  const errors = [];
  const attempt = async (name, operation) => {
    try {
      await operation();
      actions.push(name);
    } catch (error) {
      errors.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const route = terminal?.facts?.route;
  if (transactionLeaked(terminal?.facts?.transaction)) {
    await attempt("cancelActiveTransaction", () =>
      cancelActiveTransaction(terminal.facts.transaction),
    );
    if (errors.length > 0) return { ok: false, actions, errors };
    try {
      const settled = await waitForTransactionTerminal?.();
      if (!settled || transactionLeaked(settled)) {
        return {
          ok: false,
          actions,
          errors: [
            "recovery failure: active transaction did not reach a real terminal state",
          ],
        };
      }
    } catch (error) {
      return {
        ok: false,
        actions,
        errors: [
          `recovery failure: active transaction wait failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }
  await attempt("disableFaultInjection", disableFaultInjection);
  const sessionId = terminal?.facts?.deviceSession?.sessionId;
  if (sessionId) {
    await attempt("restoreSerialSession", () =>
      restoreSerialSession(sessionId),
    );
  }
  if (track.restoreFixtureStock === true) {
    const fixture = fixtureAllocation?.[track.fixtureKey ?? track.key];
    if (!fixture?.inventoryId) {
      errors.push(
        `restoreFixtureStock: fixture allocation is absent for ${track.key}`,
      );
    } else {
      await attempt("restoreFixtureStock", () => restoreFixtureStock(fixture));
    }
  }
  if (route && route !== "#/catalog") {
    await attempt("returnToCatalog", returnToCatalog);
  }
  return { ok: errors.length === 0, actions, errors };
}
