import type {
  CustomerAudioCueEvent,
  createMachineAudioCuePlaybackAdapter,
} from "@/audio-cues/browser-playback";
import type { TransactionSnapshot } from "@/daemon/schemas";

import { createMachineAudioCuePlaybackAdapter as createDefaultAudioCueRequester } from "@/audio-cues/browser-playback";

type TransactionCueRequester = Pick<
  ReturnType<typeof createMachineAudioCuePlaybackAdapter>,
  "requestCustomerAudioCue"
>;

type TransactionCustomerAudioCueEvent = Extract<
  CustomerAudioCueEvent,
  { orderKey: string }
>;

type TransactionCueSnapshot = TransactionSnapshot & {
  orderKey?: string | null;
};

export async function requestPaymentSuccessCue(
  snapshot: TransactionCueSnapshot | null,
  requester: TransactionCueRequester = createDefaultAudioCueRequester(),
): Promise<boolean> {
  if (
    !snapshot ||
    snapshot.paymentStatus !== "succeeded" ||
    snapshot.nextAction !== "dispensing"
  ) {
    return false;
  }
  return requestTransactionCue(
    {
      type: "payment.succeeded",
      orderKey: orderKeyFor(snapshot),
      requestedAt: snapshot.updatedAt,
      nowMs: millisecondsFor(snapshot.updatedAt),
    },
    requester,
  );
}

export async function requestDispensingStartedCue(
  snapshot: TransactionCueSnapshot | null,
  requester: TransactionCueRequester = createDefaultAudioCueRequester(),
): Promise<boolean> {
  if (!snapshot || snapshot.nextAction !== "dispensing") {
    return false;
  }
  return requestTransactionCue(
    {
      type: "dispensing.started",
      orderKey: orderKeyFor(snapshot),
      requestedAt: snapshot.updatedAt,
      nowMs: millisecondsFor(snapshot.updatedAt),
    },
    requester,
  );
}

export async function requestTerminalResultCue(
  snapshot: TransactionCueSnapshot | null,
  requester: TransactionCueRequester = createDefaultAudioCueRequester(),
): Promise<boolean> {
  if (!snapshot) return false;
  const type = terminalCueTypeFor(snapshot.nextAction);
  if (!type) return false;
  return requestTransactionCue(
    {
      type,
      orderKey: orderKeyFor(snapshot),
      requestedAt: snapshot.updatedAt,
      nowMs: millisecondsFor(snapshot.updatedAt),
    },
    requester,
  );
}

function terminalCueTypeFor(
  nextAction: string | null | undefined,
): TransactionCustomerAudioCueEvent["type"] | null {
  switch (nextAction) {
    case null:
    case undefined:
      return null;
    case "success":
      return "dispense.succeeded";
    case "dispense_failed":
      return "dispense.failed";
    case "refund_pending":
      return "refund.pending";
    case "refunded":
      return "refund.completed";
    case "manual_handling":
    case "result_unknown":
      return "manual_handling.required";
    default:
      return null;
  }
}

async function requestTransactionCue(
  event: Omit<TransactionCustomerAudioCueEvent, "orderKey"> & {
    orderKey: string | null;
  },
  requester: TransactionCueRequester,
): Promise<boolean> {
  if (!event.orderKey) return false;
  try {
    return await requester.requestCustomerAudioCue({
      ...event,
      orderKey: event.orderKey,
    });
  } catch {
    return false;
  }
}

function orderKeyFor(snapshot: TransactionCueSnapshot): string | null {
  return firstNonBlank(snapshot.orderKey, snapshot.orderNo, snapshot.orderId);
}

function firstNonBlank(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function millisecondsFor(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
