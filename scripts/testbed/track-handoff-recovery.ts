type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function publishedHandoffSerialSessionId(report: unknown): string | null {
  if (report == null || typeof report !== "object") return null;
  const record = report as JsonRecord;
  if (
    typeof record.handoffSerialSessionId !== "string" ||
    String(record.handoffSerialSessionId).trim() === ""
  )
    return null;
  return String(record.handoffSerialSessionId).trim();
}

function terminalRoute(track: JsonRecord, route: unknown): boolean {
  return (
    route === "#/catalog" ||
    /^#\/result(?:\/|$)/.test(String(route ?? "")) ||
    (track.allowActiveTransactionHandoff === true &&
      /^#\/payment(?:\/|$)/.test(String(route ?? "")))
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

export function isTerminalTransaction(transaction: unknown): boolean {
  if (typeof transaction !== "object" || transaction == null) return false;
  const record = recordValue(transaction);
  if (
    typeof record.nextAction === "string" &&
    terminalNextActions.has(record.nextAction as string)
  )
    return true;
  if (
    typeof record.orderStatus === "string" &&
    terminalOrderStatuses.has(record.orderStatus as string)
  )
    return true;
  return false;
}

export function isActiveTransaction(transaction: unknown): boolean {
  if (typeof transaction !== "object" || transaction == null) return false;
  const record = recordValue(transaction);
  if (isTerminalTransaction(transaction)) return false;
  if (
    typeof record.nextAction === "string" &&
    activeNextActions.has(record.nextAction as string)
  )
    return true;
  if (
    typeof record.orderStatus === "string" &&
    activeOrderStatuses.has(record.orderStatus as string)
  )
    return true;
  return false;
}

function transactionLeaked(transaction: unknown): boolean {
  return isActiveTransaction(transaction);
}

function hasWholeMachineLockBlocker(capability: unknown): boolean {
  const capabilityRecord = recordValue(capability);
  return (
    Array.isArray(capabilityRecord.blockers) &&
    (capabilityRecord.blockers as unknown[]).some(
      (blocker: unknown) =>
        recordValue(blocker).code === "WHOLE_MACHINE_LOCKED",
    )
  );
}

function terminalPolicyFailures(track: JsonRecord, facts: JsonRecord): string[] {
  const failures: string[] = [];
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
}: {
  track: JsonRecord;
  context: JsonRecord;
  readRoute: () => Promise<unknown>;
  daemonGet: (path: string) => Promise<unknown>;
  platformQuery: () => Promise<unknown>;
}): Promise<JsonRecord> {
  const diagnostics: string[] = [];
  const observe = async (
    label: string,
    operation: () => Promise<unknown>,
    { attempts = 1 }: { attempts?: number } = {},
  ): Promise<unknown> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts)
          await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    diagnostics.push(
      `${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    return null;
  };
  const facts = {
    route: await observe("route", readRoute),
    transaction: await observe(
      "transaction",
      () => daemonGet("/v1/transactions/current"),
      { attempts: 3 },
    ),
    saleStartCapability: await observe(
      "saleStartCapability",
      () => daemonGet("/v1/sale-start-capability"),
      { attempts: 3 },
    ),
    saleView: await observe("saleView", () => daemonGet("/v1/sale-view")),
    hardwareBindings: await observe(
      "hardwareBindings",
      () => daemonGet("/v1/hardware-bindings"),
      { attempts: 3 },
    ),
    inventory: await observe("inventory", platformQuery, { attempts: 3 }),
    handoffSerialSessionId: publishedHandoffSerialSessionId(
      recordValue(context).report,
    ),
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
}: {
  track: JsonRecord;
  terminal: JsonRecord | null | undefined;
  fixtureAllocation: JsonRecord | null | undefined;
  returnToCatalog: () => Promise<unknown>;
  disableFaultInjection: () => Promise<unknown>;
  restoreSerialSession: (sessionId: string) => Promise<unknown>;
  restoreFixtureStock: (fixture: JsonRecord) => Promise<unknown>;
  cancelActiveTransaction: (transaction: JsonRecord) => Promise<unknown>;
  waitForTransactionTerminal?: () => Promise<unknown>;
  recoverAfterFailure?: boolean;
  readLateTransaction?: () => Promise<unknown>;
  selfCheckHardware?: () => Promise<unknown>;
  clearWholeMachineLock?: (note: string) => Promise<unknown>;
  wholeMachineLockOperatorNote?: string;
}): Promise<JsonRecord> {
  const actions: string[] = [];
  const errors: string[] = [];
  const evidence: JsonRecord = {};
  const attempt = async (
    name: string,
    operation: () => unknown | Promise<unknown>,
  ): Promise<unknown> => {
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
  const route = recordValue(terminal?.facts).route;
  const cancelAndWaitForTerminal = async (transaction: JsonRecord) => {
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
  const terminalFacts = recordValue(terminal?.facts);
  if (transactionLeaked(terminalFacts.transaction)) {
    if (
      !(await cancelAndWaitForTerminal(
        recordValue(terminalFacts.transaction),
      ))
    ) {
      return { ok: false, actions, errors, evidence };
    }
  }
  // A completed customer sale must leave through the rendered result control
  // before recovery is allowed to start a Local Operations stock task.
  if (/^#\/result(?:\/|$)/.test(String(route ?? ""))) {
    await attempt("returnToCatalog", returnToCatalog);
    if (errors.length > 0) return { ok: false, actions, errors, evidence };
  }
  if (
    hasWholeMachineLockBlocker(terminalFacts.saleStartCapability)
  ) {
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
      !(await cancelAndWaitForTerminal(recordValue(lateTransaction)))
    ) {
      return { ok: false, actions, errors, evidence };
    }
  }
  const sessionId = terminalFacts.handoffSerialSessionId;
  if (sessionId) {
    await attempt("restoreSerialSession", () =>
      restoreSerialSession(String(sessionId)),
    );
  }
  if (track.restoreFixtureStock === true) {
    const fixture = recordValue(fixtureAllocation)[
      String(track.fixtureKey ?? track.key)
    ];
    const fixtureRecord = recordValue(fixture);
    if (!fixtureRecord?.inventoryId) {
      errors.push(
        `restoreFixtureStock: fixture allocation is absent for ${track.key}`,
      );
    } else {
      const fixtureStock = await attempt("restoreFixtureStock", () =>
        restoreFixtureStock(fixtureRecord),
      );
      if (fixtureStock !== undefined) evidence.fixtureStock = fixtureStock;
    }
  }
  if (
    route &&
    route !== "#/catalog" &&
    !/^#\/result(?:\/|$)/.test(String(route))
  ) {
    await attempt("returnToCatalog", returnToCatalog);
  }
  return { ok: errors.length === 0, actions, errors, evidence };
}
