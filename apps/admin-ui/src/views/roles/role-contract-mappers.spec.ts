import { describe, expect, it } from "vitest";

import {
  toCreateRoleContract,
  toUpdateRoleContract,
  type RoleFormModel,
} from "./role-contract-mappers";

describe("Admin Role form contract mappers", () => {
  const form: RoleFormModel = {
    code: "ops_manager",
    name: "Ops Manager",
    description: "",
    status: "active",
    permissionCodes: ["adminUsers.read", "roles.write"],
  };

  it("maps role form fields into the shared role contract", () => {
    expect(toCreateRoleContract(form)).toEqual({
      code: "ops_manager",
      name: "Ops Manager",
      description: null,
      status: "active",
      permissionCodes: ["adminUsers.read", "roles.write"],
    });
  });

  it("validates role permission assignment against shared Permission Code", () => {
    expect(() =>
      toUpdateRoleContract({
        ...form,
        permissionCodes: ["roles.write", "not.a.permission"],
      }),
    ).toThrow();
  });
});
