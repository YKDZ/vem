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

  beforeEach(async () => {
    vi.clearAllMocks();

    const existingRole = {
      id: "role-id-1",
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
              where: vi.fn().mockResolvedValue([]),
            }),
          }),
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
    const updated = await service.update("operator-admin-id", "role-id-1", {
      permissionCodes: ["orders.read", "payments.read"],
    });

    expect(updated.id).toBe("role-id-1");
    expect(mockAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: "operator-admin-id",
        action: "roles.update",
        resourceType: "role",
        resourceId: "role-id-1",
      }),
    );
  });
});
