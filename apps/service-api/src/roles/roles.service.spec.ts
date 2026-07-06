import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { RolesService } from "./roles.service";

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};

const mockAuditService = {
  record: vi.fn().mockResolvedValue(undefined),
};

describe("RolesService", () => {
  let service: RolesService;
  let txPermissionRows: Array<{ id: string; code: string }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    txPermissionRows = [];

    const existingRole = {
      id: "550e8400-e29b-41d4-a716-446655440001",
      code: "operator",
      name: "运营",
      description: null,
      isBuiltin: false,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const updatedRole = { ...existingRole };

    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([existingRole]),
      }),
    });

    mockDb.transaction.mockImplementation(
      async (cb: (tx: typeof mockDb) => Promise<unknown>) => {
        const tx = {
          update: vi.fn().mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([updatedRole]),
              }),
            }),
          }),
          delete: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockResolvedValue(undefined),
          }),
          select: vi.fn().mockReturnValue({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue(txPermissionRows),
            }),
          }),
          transaction: vi.fn(),
        };
        return await cb(tx);
      },
    );

    const module = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<RolesService>(RolesService);
  });

  it("replaces role permissions and records audit log", async () => {
    txPermissionRows = [
      { id: "550e8400-e29b-41d4-a716-446655440010", code: "orders.read" },
      { id: "550e8400-e29b-41d4-a716-446655440011", code: "payments.read" },
    ];

    const updated = await service.update(
      "operator-admin-id",
      "550e8400-e29b-41d4-a716-446655440001",
      {
        permissionCodes: ["orders.read", "payments.read"],
      },
    );

    expect(updated.id).toBe("550e8400-e29b-41d4-a716-446655440001");
    expect(mockAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: "operator-admin-id",
        action: "roles.update",
        resourceType: "role",
        resourceId: "550e8400-e29b-41d4-a716-446655440001",
      }),
    );
  });

  it("returns and audits only permission codes that were persisted", async () => {
    txPermissionRows = [
      { id: "550e8400-e29b-41d4-a716-446655440010", code: "orders.read" },
    ];

    const updated = await service.update(
      "operator-admin-id",
      "550e8400-e29b-41d4-a716-446655440001",
      {
        permissionCodes: ["orders.read", "payments.read"],
      },
    );

    expect(updated.permissionCodes).toEqual(["orders.read"]);
    expect(mockAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        afterJson: expect.objectContaining({
          permissionCodes: ["orders.read"],
        }),
      }),
    );
  });
});
