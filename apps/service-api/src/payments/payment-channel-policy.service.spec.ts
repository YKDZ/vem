import { describe, expect, it } from "vitest";

import {
  supportedPaymentChannelKeys,
  type UpdatePaymentChannelPolicyInput,
} from "@vem/shared";

import { PaymentChannelPolicyService } from "./payment-channel-policy.service";

function makeMemoryDb() {
  let rows: Array<{
    channelKey: string;
    enabled: boolean;
    rank: number;
    isDefault: boolean;
    updatedByAdminUserId: string | null;
    updatedAt: Date;
  }> = [];

  const select = () => ({
    from: () => ({
      orderBy: async () => [...rows].sort((a, b) => a.rank - b.rank),
    }),
  });
  const tx = {
    delete: () => ({ where: async () => undefined }),
    insert: () => ({
      values: (
        values: Array<{
          channelKey: string;
          enabled: boolean;
          rank: number;
          isDefault: boolean;
          updatedByAdminUserId: string | null;
          updatedAt: Date;
        }>,
      ) => ({
        returning: async () => {
          rows = values;
          return [...rows].sort((a, b) => a.rank - b.rank);
        },
      }),
    }),
  };
  const transaction = async <T>(fn: (txArg: typeof tx) => Promise<T>) =>
    await fn(tx);

  return { select, transaction };
}

describe("PaymentChannelPolicyService", () => {
  it("returns the default global policy when no policy has been stored", async () => {
    const service = new PaymentChannelPolicyService(makeMemoryDb() as never);

    await expect(service.getPolicy()).resolves.toMatchObject({
      channels: supportedPaymentChannelKeys.map((channelKey, index) => ({
        channelKey,
        enabled: true,
        rank: index + 1,
      })),
      defaultChannelKey: "qr_code:alipay",
      updatedAt: null,
      updatedByAdminUserId: null,
    });
  });

  it("persists the updated global policy and returns it in rank order", async () => {
    const db = makeMemoryDb();
    const service = new PaymentChannelPolicyService(db as never);
    const adminId = "550e8400-e29b-41d4-a716-446655440010";
    const input: UpdatePaymentChannelPolicyInput = {
      channels: [
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 1 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 2 },
        { channelKey: "payment_code:alipay", enabled: false, rank: 3 },
        { channelKey: "qr_code:alipay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "payment_code:wechat_pay",
    };

    const updated = await service.updatePolicy(adminId, input);

    expect(updated).toMatchObject({
      ...input,
      updatedByAdminUserId: adminId,
    });
    await expect(service.getPolicy()).resolves.toMatchObject(input);
  });
});
