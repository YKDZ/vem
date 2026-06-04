import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { MachinesController } from "./machines.controller";

describe("MachinesController environment commands", () => {
  it("requires machines.command and forwards the requester", async () => {
    const commandEnvironment = vi.fn().mockResolvedValue({ id: "command-1" });
    const controller = new MachinesController({ commandEnvironment } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.commandEnvironment,
    );

    expect(permissions).toEqual(["machines.command"]);
    await expect(
      controller.commandEnvironment(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        { airConditionerOn: true },
      ),
    ).resolves.toEqual({ id: "command-1" });
    expect(commandEnvironment).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      { airConditionerOn: true },
      "admin-1",
    );
  });
});
