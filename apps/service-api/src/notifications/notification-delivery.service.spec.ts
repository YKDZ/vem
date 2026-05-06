import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DRIZZLE_CLIENT } from "../database/database.constants";
import { NotificationDeliveryService } from "./notification-delivery.service";

const makeDeliveryRow = (
  targetType: "in_app" | "wechat",
  webhookUrl?: string,
) => ({
  delivery: {
    id: "d1",
    notificationId: "n1",
    targetId: "t1",
    status: "pending" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
    sentAt: null,
    failedReason: null,
  },
  notification: {
    id: "n1",
    title: "低库存警告",
    content: "A01 剩余 2 件",
    severity: "warning",
    type: "low_stock",
    machineId: null,
    status: "unread",
    createdAt: new Date(),
    updatedAt: new Date(),
    readAt: null,
  },
  target: {
    id: "t1",
    name: "Test Target",
    type: targetType,
    status: "enabled",
    configJson: webhookUrl ? ({ webhookUrl } as Record<string, unknown>) : ({} as Record<string, unknown>),
    targetMasked: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
});

function makeSelectChain(rows: unknown[]) {
  type Chain = {
    innerJoin: () => Chain;
    where: () => Chain;
    limit: () => Promise<unknown[]>;
  };
  const chain: Chain = {
    innerJoin: (): Chain => chain,
    where: (): Chain => chain,
    limit: async () => rows,
  };
  return {
    from: (): Chain => chain,
  };
}

function makeUpdateChain(fn: (set: unknown) => void) {
  return {
    set: (val: unknown) => {
      fn(val);
      return { where: async () => [{ id: "d1" }] };
    },
  };
}

describe("NotificationDeliveryService", () => {
  let service: NotificationDeliveryService;
  const mockDb = { select: vi.fn(), update: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        NotificationDeliveryService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
      ],
    }).compile();
    service = module.get(NotificationDeliveryService);
  });

  it("marks in_app delivery as sent without calling fetch", async () => {
    const capturedSet: unknown[] = [];
    mockDb.select.mockReturnValue(makeSelectChain([makeDeliveryRow("in_app")]));
    mockDb.update.mockReturnValue(makeUpdateChain((v) => capturedSet.push(v)));

    await service.deliverPending();

    expect(capturedSet).toHaveLength(1);
    expect(capturedSet[0]).toMatchObject({ status: "sent" });
  });

  it("marks wechat delivery as sent when webhook returns 200", async () => {
    const capturedSet: unknown[] = [];
    mockDb.select.mockReturnValue(
      makeSelectChain([makeDeliveryRow("wechat", "https://example.com/hook")]),
    );
    mockDb.update.mockReturnValue(makeUpdateChain((v) => capturedSet.push(v)));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await service.deliverPending();
    vi.unstubAllGlobals();

    expect(capturedSet[0]).toMatchObject({ status: "sent" });
  });

  it("marks wechat delivery as failed and records reason when webhook returns 500", async () => {
    const capturedSet: unknown[] = [];
    mockDb.select.mockReturnValue(
      makeSelectChain([makeDeliveryRow("wechat", "https://example.com/hook")]),
    );
    mockDb.update.mockReturnValue(makeUpdateChain((v) => capturedSet.push(v)));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    await service.deliverPending();
    vi.unstubAllGlobals();

    expect(capturedSet[0]).toMatchObject({
      status: "failed",
    });
    expect(
      (capturedSet[0] as { failedReason?: string }).failedReason,
    ).toContain("500");
  });

  it("does not call update when no pending deliveries exist", async () => {
    mockDb.select.mockReturnValue(makeSelectChain([]));
    await service.deliverPending();
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});
