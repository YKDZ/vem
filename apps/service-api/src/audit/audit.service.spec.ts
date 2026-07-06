import { auditLogPageResponseSchema } from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { AuditService } from "./audit.service";

describe("AuditService admin contracts", () => {
  it("maps database audit rows to the strict shared response contract", async () => {
    const offset = vi.fn().mockResolvedValue([
      {
        id: "550e8400-e29b-41d4-a716-446655440001",
        adminUserId: "550e8400-e29b-41d4-a716-446655440002",
        action: "payments.provider_config.update",
        resourceType: "payment_provider_config",
        resourceId: "550e8400-e29b-41d4-a716-446655440003",
        ipAddress: "127.0.0.1",
        userAgent: "Playwright",
        beforeJson: null,
        afterJson: { providerCode: "alipay" },
        createdAt: new Date("2026-07-06T00:54:57.788Z"),
      },
    ]);
    const db = {
      select: vi
        .fn()
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({ offset }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: "1" }]),
          }),
        }),
    };
    const service = new AuditService(db as never);

    const result = await service.list({ page: 1, pageSize: 20 });

    expect(auditLogPageResponseSchema.parse(result)).toEqual(result);
    expect(result.items[0]).not.toHaveProperty("ipAddress");
    expect(result.items[0]).not.toHaveProperty("userAgent");
  });
});
