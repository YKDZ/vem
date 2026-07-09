import { Inject, Injectable } from "@nestjs/common";
import {
  asc,
  paymentChannelPolicies,
  sql,
  type DrizzleClient,
} from "@vem/db";
import {
  paymentChannelPolicyResponseSchema,
  supportedPaymentChannelKeys,
  updatePaymentChannelPolicySchema,
  type PaymentChannelPolicyResponse,
  type UpdatePaymentChannelPolicyInput,
} from "@vem/shared";

import { DRIZZLE_CLIENT } from "../database/database.constants";

type PaymentChannelPolicyRow = {
  channelKey: string;
  enabled: boolean;
  rank: number;
  isDefault: boolean;
  updatedByAdminUserId: string | null;
  updatedAt: Date;
};

@Injectable()
export class PaymentChannelPolicyService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async getPolicy(): Promise<PaymentChannelPolicyResponse> {
    const rows = await this.db
      .select({
        channelKey: paymentChannelPolicies.channelKey,
        enabled: paymentChannelPolicies.enabled,
        rank: paymentChannelPolicies.rank,
        isDefault: paymentChannelPolicies.isDefault,
        updatedByAdminUserId: paymentChannelPolicies.updatedByAdminUserId,
        updatedAt: paymentChannelPolicies.updatedAt,
      })
      .from(paymentChannelPolicies)
      .orderBy(asc(paymentChannelPolicies.rank));

    return this.toResponse(rows);
  }

  async updatePolicy(
    adminUserId: string | null,
    input: UpdatePaymentChannelPolicyInput,
  ): Promise<PaymentChannelPolicyResponse> {
    const policy = updatePaymentChannelPolicySchema.parse(input);
    const now = new Date();
    const rows = await this.db.transaction(async (tx) => {
      await tx.delete(paymentChannelPolicies).where(sql`true`);
      return await tx
        .insert(paymentChannelPolicies)
        .values(
          policy.channels.map((channel) => ({
            channelKey: channel.channelKey,
            enabled: channel.enabled,
            rank: channel.rank,
            isDefault: channel.channelKey === policy.defaultChannelKey,
            updatedByAdminUserId: adminUserId,
            updatedAt: now,
          })),
        )
        .returning({
          channelKey: paymentChannelPolicies.channelKey,
          enabled: paymentChannelPolicies.enabled,
          rank: paymentChannelPolicies.rank,
          isDefault: paymentChannelPolicies.isDefault,
          updatedByAdminUserId: paymentChannelPolicies.updatedByAdminUserId,
          updatedAt: paymentChannelPolicies.updatedAt,
        });
    });

    return this.toResponse(rows);
  }

  private toResponse(
    rows: PaymentChannelPolicyRow[],
  ): PaymentChannelPolicyResponse {
    if (rows.length === 0) {
      return paymentChannelPolicyResponseSchema.parse({
        channels: supportedPaymentChannelKeys.map((channelKey, index) => ({
          channelKey,
          enabled: true,
          rank: index + 1,
        })),
        defaultChannelKey: "qr_code:alipay",
        updatedAt: null,
        updatedByAdminUserId: null,
      });
    }

    const orderedRows = [...rows].sort((a, b) => a.rank - b.rank);
    const defaultRow = orderedRows.find((row) => row.isDefault);
    const latestRow = orderedRows.reduce((latest, row) =>
      row.updatedAt > latest.updatedAt ? row : latest,
    );

    return paymentChannelPolicyResponseSchema.parse({
      channels: orderedRows.map((row) => ({
        channelKey: row.channelKey,
        enabled: row.enabled,
        rank: row.rank,
      })),
      defaultChannelKey: defaultRow?.channelKey ?? "qr_code:alipay",
      updatedAt: latestRow.updatedAt.toISOString(),
      updatedByAdminUserId: latestRow.updatedByAdminUserId,
    });
  }
}
