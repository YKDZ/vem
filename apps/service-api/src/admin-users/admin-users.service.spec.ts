import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service";
import { PasswordService } from "../auth/password.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { AdminUsersService } from "./admin-users.service";

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  transaction: vi.fn(),
};

const mockPasswordService = {
  hashPassword: vi.fn().mockResolvedValue("hashed-password"),
};

const mockAuditService = {
  record: vi.fn().mockResolvedValue(undefined),
};

describe("AdminUsersService", () => {
  let service: AdminUsersService;

  beforeEach(async () => {
    vi.clearAllMocks();

    const createdUser = {
      id: "user-id-1",
      username: "ops01",
      displayName: "运营 01",
      mobile: null,
      email: null,
      status: "active",
      lastLoginAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    mockDb.transaction.mockImplementation(
      async (cb: (tx: typeof mockDb) => Promise<unknown>) => {
        const tx = {
          insert: vi.fn().mockReturnValue({
            values: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([createdUser]),
            }),
          }),
          update: vi.fn(),
          delete: vi.fn(),
          select: vi.fn(),
        };
        return await cb(tx);
      },
    );

    const module = await Test.createTestingModule({
      providers: [
        AdminUsersService,
        { provide: DRIZZLE_CLIENT, useValue: mockDb },
        { provide: PasswordService, useValue: mockPasswordService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<AdminUsersService>(AdminUsersService);
  });

  it("hashes password and records audit log when creating admin user", async () => {
    const created = await service.create("operator-admin-id", {
      username: "ops01",
      password: "StrongPassword123",
      displayName: "运营 01",
      status: "active",
      roleIds: [],
    });

    expect(created.username).toBe("ops01");
    expect(mockPasswordService.hashPassword).toHaveBeenCalledWith(
      "StrongPassword123",
    );
    expect(mockAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: "operator-admin-id",
        action: "admin_users.create",
        resourceType: "admin_user",
        resourceId: created.id,
      }),
    );
  });
});
