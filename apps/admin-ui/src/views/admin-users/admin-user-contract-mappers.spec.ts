import { describe, expect, it } from "vitest";

import {
  toCreateAdminUserContract,
  toUpdateAdminUserContract,
  type AdminUserFormModel,
} from "./admin-user-contract-mappers";

describe("Admin Identity form contract mappers", () => {
  const form: AdminUserFormModel = {
    username: "ops01",
    password: "StrongPassword123",
    displayName: "Ops User",
    mobile: "",
    email: "",
    status: "active",
    roleIds: ["550e8400-e29b-41d4-a716-446655440010"],
  };

  it("maps create form fields into the shared admin user contract", () => {
    expect(toCreateAdminUserContract(form)).toEqual({
      username: "ops01",
      password: "StrongPassword123",
      displayName: "Ops User",
      mobile: null,
      email: null,
      status: "active",
      roleIds: ["550e8400-e29b-41d4-a716-446655440010"],
    });
  });

  it("omits blank edit password while preserving nullable contact fields", () => {
    expect(toUpdateAdminUserContract({ ...form, password: "" })).toEqual({
      username: "ops01",
      displayName: "Ops User",
      mobile: null,
      email: null,
      status: "active",
      roleIds: ["550e8400-e29b-41d4-a716-446655440010"],
    });
  });
});
