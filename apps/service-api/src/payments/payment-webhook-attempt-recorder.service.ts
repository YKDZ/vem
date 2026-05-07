import { Inject, Injectable } from "@nestjs/common";
import { eq, paymentWebhookAttempts, type DrizzleClient } from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  buildRawBodyExcerpt,
  buildRedactedPayload,
  headersHash,
  rawBodySha256,
  redactHeaders,
  retentionUntil,
} from "./payment-redaction.util";

export type StartWebhookAttemptInput = {
  providerCode: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBodyText: string;
  remoteIp: string | null;
  userAgent: string | null;
};

export type FinishWebhookAttemptInput = {
  attemptId: string;
  providerId?: string | null;
  paymentId?: string | null;
  refundId?: string | null;
  matchedConfigId?: string | null;
  eventKind: "payment" | "refund" | "unknown";
  eventType?: string | null;
  providerEventId?: string | null;
  paymentNo?: string | null;
  refundNo?: string | null;
  orderNo?: string | null;
  signatureValid?: boolean | null;
  businessValid?: boolean | null;
  handled: boolean;
  duplicate?: boolean;
  failureReason?: string | null;
  errorCode?: string | null;
  httpStatus?: number | null;
};

@Injectable()
export class PaymentWebhookAttemptRecorderService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async start(input: StartWebhookAttemptInput): Promise<string> {
    const bodyHash = rawBodySha256(input.rawBodyText);
    const bodyBytes = Buffer.byteLength(input.rawBodyText, "utf8");
    const excerpt = buildRawBodyExcerpt(input.rawBodyText);
    const headersSummary = redactHeaders(input.headers);
    const hHash = headersHash(input.headers);
    const redactedPayload = buildRedactedPayload(input.body);

    const [row] = await this.db
      .insert(paymentWebhookAttempts)
      .values({
        providerCode: input.providerCode,
        eventKind: "unknown",
        remoteIp: input.remoteIp ?? undefined,
        userAgent: input.userAgent ?? undefined,
        headersHash: hHash,
        headersSummaryJson: headersSummary,
        rawBodySha256: bodyHash,
        rawBodyBytes: bodyBytes,
        rawBodyExcerpt: excerpt,
        redactedPayloadJson: redactedPayload ?? undefined,
        handled: false,
        duplicate: false,
        retentionUntil: retentionUntil(),
      })
      .returning({ id: paymentWebhookAttempts.id });

    return row.id;
  }

  async finish(input: FinishWebhookAttemptInput): Promise<void> {
    await this.db
      .update(paymentWebhookAttempts)
      .set({
        providerId: input.providerId ?? undefined,
        paymentId: input.paymentId ?? undefined,
        refundId: input.refundId ?? undefined,
        matchedConfigId: input.matchedConfigId ?? undefined,
        eventKind: input.eventKind,
        eventType: input.eventType ?? undefined,
        providerEventId: input.providerEventId ?? undefined,
        paymentNo: input.paymentNo ?? undefined,
        refundNo: input.refundNo ?? undefined,
        orderNo: input.orderNo ?? undefined,
        signatureValid: input.signatureValid ?? undefined,
        businessValid: input.businessValid ?? undefined,
        handled: input.handled,
        duplicate: input.duplicate ?? false,
        failureReason: input.failureReason ?? undefined,
        errorCode: input.errorCode ?? undefined,
        httpStatus: input.httpStatus ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(paymentWebhookAttempts.id, input.attemptId));
  }
}
