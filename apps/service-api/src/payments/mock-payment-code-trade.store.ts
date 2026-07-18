import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  eq,
  mockPaymentCodeTrades,
  ne,
  or,
  sql,
  type DrizzleClient,
} from "@vem/db";

import { DRIZZLE_CLIENT } from "../database/database.constants";

export type MockPaymentCodeTrade = typeof mockPaymentCodeTrades.$inferSelect;

@Injectable()
export class MockPaymentCodeTradeStore {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async acceptCharge(input: {
    providerPaymentNo: string;
    idempotencyKey: string;
    providerTradeNo: string;
    amountCents: number;
    authCodeLength: number;
  }): Promise<MockPaymentCodeTrade> {
    const now = new Date();
    await this.db
      .insert(mockPaymentCodeTrades)
      .values({
        providerPaymentNo: input.providerPaymentNo,
        chargeIdempotencyKey: input.idempotencyKey,
        providerTradeNo: input.providerTradeNo,
        amountCents: input.amountCents,
        authCodeLength: input.authCodeLength,
        status: "succeeded",
        paidAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const [trade] = await this.db
      .select()
      .from(mockPaymentCodeTrades)
      .where(
        or(
          eq(mockPaymentCodeTrades.providerPaymentNo, input.providerPaymentNo),
          eq(mockPaymentCodeTrades.chargeIdempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!trade) throw new Error("mock_payment_code_charge_admission_failed");
    if (
      trade.providerPaymentNo !== input.providerPaymentNo ||
      trade.chargeIdempotencyKey !== input.idempotencyKey ||
      trade.amountCents !== input.amountCents
    ) {
      throw new Error("mock_payment_code_idempotency_conflict");
    }
    return trade;
  }

  async find(providerPaymentNo: string): Promise<MockPaymentCodeTrade | null> {
    const [trade] = await this.db
      .select()
      .from(mockPaymentCodeTrades)
      .where(eq(mockPaymentCodeTrades.providerPaymentNo, providerPaymentNo))
      .limit(1);
    return trade ?? null;
  }

  async acceptReversal(input: {
    providerPaymentNo: string;
    providerTradeNo: string | null;
    idempotencyKey: string;
  }): Promise<MockPaymentCodeTrade | null> {
    const now = new Date();
    const [reversed] = await this.db
      .update(mockPaymentCodeTrades)
      .set({
        status: "reversed",
        reversalIdempotencyKey: input.idempotencyKey,
        reversalAcceptedCount: sql`${mockPaymentCodeTrades.reversalAcceptedCount} + 1`,
        reversedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(mockPaymentCodeTrades.providerPaymentNo, input.providerPaymentNo),
          input.providerTradeNo
            ? eq(mockPaymentCodeTrades.providerTradeNo, input.providerTradeNo)
            : undefined,
          ne(mockPaymentCodeTrades.status, "reversed"),
        ),
      )
      .returning();
    const trade = reversed ?? (await this.find(input.providerPaymentNo));
    if (!trade) return null;
    if (
      trade.providerTradeNo !== input.providerTradeNo ||
      trade.reversalIdempotencyKey !== input.idempotencyKey
    ) {
      throw new Error("mock_payment_code_reversal_idempotency_conflict");
    }
    return trade;
  }
}
