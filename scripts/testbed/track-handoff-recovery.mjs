function publishedHandoffSerialSessionId(report) {
  if (report == null || typeof report !== "object") return null;
  if (
    typeof report.handoffSerialSessionId !== "string" ||
    report.handoffSerialSessionId.trim() === ""
  )
    return null;
  return report.handoffSerialSessionId.trim();
}

function terminalRoute(track, route) {
  return (
    route === "#/catalog" ||
    /^#\/result(?:\/|$)/.test(route ?? "") ||
    (track.allowActiveTransactionHandoff === true &&
      /^#\/payment(?:\/|$)/.test(route ?? ""))
  );
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

function hasWholeMachineLockBlocker(capability) {
  return (
    Array.isArray(capability?.blockers) &&
    capability.blockers.some(
      (blocker) => blocker?.code === "WHOLE_MACHINE_LOCKED",
    )
  );
}

function terminalPolicyFailures(track, facts) {
  const failures = [];
  if (
    transactionLeaked(facts.transaction) &&
    track.allowActiveTransactionHandoff !== true
  )
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
    handoffSerialSessionId: publishedHandoffSerialSessionId(context?.report),
  };
  if (diagnostics.length > 0) {
    return {
      ok: false,
      facts,
      reason: `${track.key} terminal facts are incomplete: ${diagnostics.join("; ")}`,
      diagnostics,
    };
  }
  if (!terminalRoute(track, facts.route)) {
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
  recoverAfterFailure = false,
  readLateTransaction,
  selfCheckHardware,
  clearWholeMachineLock,
  wholeMachineLockOperatorNote = "verified track handoff recovery",
}) {
  const actions = [];
  const errors = [];
  const evidence = {};
  const attempt = async (name, operation) => {
    try {
      const result = await operation();
      actions.push(name);
      return result;
    } catch (error) {
      errors.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  const route = terminal?.facts?.route;
  const cancelAndWaitForTerminal = async (transaction) => {
    await attempt("cancelActiveTransaction", () =>
      cancelActiveTransaction(transaction),
    );
    if (errors.length > 0) return false;
    try {
      const settled = await waitForTransactionTerminal?.();
      if (!settled || transactionLeaked(settled)) {
        errors.push(
          "recovery failure: active transaction did not reach a real terminal state",
        );
        return false;
      }
    } catch (error) {
      errors.push(
        `recovery failure: active transaction wait failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    return true;
  };
  if (transactionLeaked(terminal?.facts?.transaction)) {
    if (!(await cancelAndWaitForTerminal(terminal.facts.transaction))) {
      return { ok: false, actions, errors, evidence };
    }
  }
  if (hasWholeMachineLockBlocker(terminal?.facts?.saleStartCapability)) {
    if (typeof selfCheckHardware !== "function") {
      errors.push(
        "recoverWholeMachineLock: selfCheckHardware is required for WHOLE_MACHINE_LOCKED",
      );
      return { ok: false, actions, errors, evidence };
    }
    await attempt("selfCheckHardware", selfCheckHardware);
    if (errors.length > 0) return { ok: false, actions, errors, evidence };
    if (typeof clearWholeMachineLock !== "function") {
      errors.push(
        "recoverWholeMachineLock: clearWholeMachineLock is required for WHOLE_MACHINE_LOCKED",
      );
      return { ok: false, actions, errors, evidence };
    }
    await attempt("clearWholeMachineLock", () =>
      clearWholeMachineLock(wholeMachineLockOperatorNote),
    );
  }
  await attempt("disableFaultInjection", disableFaultInjection);
  if (recoverAfterFailure && typeof readLateTransaction === "function") {
    let lateTransaction = null;
    try {
      lateTransaction = await readLateTransaction();
    } catch (error) {
      errors.push(
        `readLateTransaction: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      transactionLeaked(lateTransaction) &&
      !(await cancelAndWaitForTerminal(lateTransaction))
    ) {
      return { ok: false, actions, errors, evidence };
    }
  }
  const sessionId = terminal?.facts?.handoffSerialSessionId;
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
      const fixtureStock = await attempt("restoreFixtureStock", () =>
        restoreFixtureStock(fixture),
      );
      if (fixtureStock !== undefined) evidence.fixtureStock = fixtureStock;
    }
  }
  if (route && route !== "#/catalog") {
    await attempt("returnToCatalog", returnToCatalog);
  }
  return { ok: errors.length === 0, actions, errors, evidence };
}
