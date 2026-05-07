import { describe, expect, it, vi } from "vitest";

import { NotificationsService } from "./notifications.service";

function makeDb() {
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    insert,
    _mocks: { values, onConflictDoNothing },
  };
}

function makeService(db: ReturnType<typeof makeDb>) {
  return new NotificationsService(db as never);
}

describe("NotificationsService.createOperationalNotification", () => {
  it("inserts notification with onConflictDoNothing on dedupeKey", async () => {
    const db = makeDb();
    const service = makeService(db);

    await service.createOperationalNotification(db as never, {
      type: "payment_provider_unready",
      title: "支付上线门禁失败",
      content: "检查项 mock_provider_disabled 未通过",
      severity: "critical",
      resourceType: "payment_ops_check",
      dedupeKey: "payment_ops_check:mock_provider_disabled",
    });

    expect(db.insert).toHaveBeenCalledOnce();
    expect(db._mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "payment_provider_unready",
        dedupeKey: "payment_ops_check:mock_provider_disabled",
      }),
    );
    expect(db._mocks.onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("second call with same dedupeKey does not throw (onConflictDoNothing idempotent)", async () => {
    const db = makeDb();
    const service = makeService(db);

    const input = {
      type: "payment_webhook_invalid" as const,
      title: "Webhook验签失败",
      content: "5次失败",
      severity: "critical" as const,
      resourceType: "payment_webhook_attempts",
      dedupeKey: "payment_webhook_invalid:2026-05-06T15",
    };

    await service.createOperationalNotification(db as never, input);
    await service.createOperationalNotification(db as never, input);

    expect(db.insert).toHaveBeenCalledTimes(2);
    expect(db._mocks.onConflictDoNothing).toHaveBeenCalledTimes(2);
  });
});
