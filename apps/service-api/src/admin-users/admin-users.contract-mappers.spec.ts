import { describe, expect, it } from "vitest";

import {
  mapCreateAdminUserDtoToInsert,
  mapUpdateAdminUserDtoToPatch,
  toAdminUserResponse,
} from "./admin-users.contract-mappers";

describe("admin user contract mappers", () => {
  it("maps create DTOs into explicit admin user database inserts", () => {
    expect(
      mapCreateAdminUserDtoToInsert(
        {
          username: "ops01",
          password: "StrongPassword123",
          displayName: "Ops User",
          mobile: undefined,
          email: null,
          status: "active",
          roleIds: [],
        },
        "hashed-password",
      ),
    ).toEqual({
      username: "ops01",
      passwordHash: "hashed-password",
      displayName: "Ops User",
      mobile: null,
      email: null,
      status: "active",
    });
  });

  it("maps update DTOs into explicit admin user database patches", () => {
    const patch = mapUpdateAdminUserDtoToPatch(
      {
        displayName: "Ops Lead",
        mobile: null,
        password: "ChangedPassword123",
      },
      "changed-hash",
    );

    expect(patch).toMatchObject({
      displayName: "Ops Lead",
      mobile: null,
      passwordHash: "changed-hash",
    });
    expect(patch).not.toHaveProperty("roleIds");
    expect(patch.updatedAt).toBeInstanceOf(Date);
  });

  it("assembles strict admin user responses with assigned role ids", () => {
    expect(
      toAdminUserResponse(
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          username: "ops01",
          displayName: "Ops User",
          mobile: null,
          email: null,
          status: "active",
          lastLoginAt: null,
          createdAt: new Date("2026-07-05T00:00:00.000Z"),
          updatedAt: new Date("2026-07-05T00:10:00.000Z"),
        },
        ["550e8400-e29b-41d4-a716-446655440010"],
      ),
    ).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440001",
      username: "ops01",
      displayName: "Ops User",
      mobile: null,
      email: null,
      status: "active",
      roles: ["550e8400-e29b-41d4-a716-446655440010"],
      lastLoginAt: null,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:10:00.000Z",
    });
  });
});
