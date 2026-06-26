import { describe, expect, it, vi } from "vitest";

import { NotificationsService } from "./notifications.service";

function makeDb() {
  const onConflictDoNothing = vi.fn().mockResolvedValue([]);
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const values = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const where = vi.fn().mockResolvedValue([]);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });

  return {
    insert,
    update,
    _mocks: { values, onConflictDoNothing, onConflictDoUpdate, set, where },
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

describe("NotificationsService.createMachineOfflineNotification", () => {
  it("upserts the machine_offline timeout notification by dedupeKey", async () => {
    const db = makeDb();
    const service = makeService(db);
    const detectedAt = new Date("2026-06-26T04:05:00.000Z");

    await service.createMachineOfflineNotification(db as never, {
      machineId: "8f6d41b6-06fc-4f33-9307-e533f4cc5b29",
      machineCode: "M001",
      lastSeenAt: new Date("2026-06-26T04:02:30.000Z"),
      timeoutSeconds: 120,
      detectedAt,
    });

    expect(db._mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "machine_offline",
        title: "机器心跳超时",
        severity: "critical",
        resourceType: "machine",
        resourceId: "8f6d41b6-06fc-4f33-9307-e533f4cc5b29",
        dedupeKey:
          "machine_offline_timeout:8f6d41b6-06fc-4f33-9307-e533f4cc5b29",
      }),
    );
    expect(db._mocks.onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.anything(),
      set: expect.objectContaining({
        status: "unread",
        updatedAt: detectedAt,
      }),
    });
  });

  it("archives the machine_offline timeout notification on recovery", async () => {
    const db = makeDb();
    const service = makeService(db);
    const recoveredAt = new Date("2026-06-26T04:06:00.000Z");

    await service.resolveMachineOfflineNotification(db as never, {
      machineId: "8f6d41b6-06fc-4f33-9307-e533f4cc5b29",
      machineCode: "M001",
      recoveredAt,
      lastSeenAt: recoveredAt,
    });

    expect(db.update).toHaveBeenCalledOnce();
    expect(db._mocks.set).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "机器心跳已恢复",
        severity: "info",
        status: "archived",
        updatedAt: recoveredAt,
      }),
    );
    expect(db._mocks.where).toHaveBeenCalledOnce();
  });
});
