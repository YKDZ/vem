import { describe, expect, it, vi } from "vitest";

import { DashboardService } from "./dashboard.service";

describe("DashboardService read contracts", () => {
  it("returns numeric sales trend aggregates when the database driver returns strings", async () => {
    const orderBy = vi.fn().mockResolvedValue([
      {
        date: "2026-07-05",
        salesCents: "12345",
        orderCount: "7",
      },
    ]);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({ orderBy }),
          }),
        }),
      }),
    };
    const service = new DashboardService(db as never);

    await expect(service.getSalesTrend({})).resolves.toEqual([
      {
        date: "2026-07-05",
        salesCents: 12345,
        orderCount: 7,
      },
    ]);
  });

  it("returns numeric top-product aggregates when the database driver returns strings", async () => {
    const limit = vi.fn().mockResolvedValue([
      {
        variantId: "550e8400-e29b-41d4-a716-446655440001",
        productName: "Sparkling Water",
        sku: "WATER-001",
        quantity: "12",
        salesCents: "6000",
      },
    ]);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit }),
            }),
          }),
        }),
      }),
    };
    const service = new DashboardService(db as never);

    await expect(service.getTopProducts({})).resolves.toEqual([
      {
        variantId: "550e8400-e29b-41d4-a716-446655440001",
        productName: "Sparkling Water",
        sku: "WATER-001",
        quantity: 12,
        salesCents: 6000,
      },
    ]);
  });

  it("returns numeric customer-profile counts when the database driver returns strings", async () => {
    const orderBy = vi.fn().mockResolvedValue([
      {
        label: "25-34",
        count: "9",
      },
    ]);
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockReturnValue({ orderBy }),
          }),
        }),
      }),
    };
    const service = new DashboardService(db as never);

    await expect(service.getCustomerProfile({})).resolves.toEqual([
      {
        label: "25-34",
        count: 9,
      },
    ]);
  });
});
