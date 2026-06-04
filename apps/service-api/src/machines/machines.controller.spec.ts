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

describe("MachinesController planogram lifecycle", () => {
  it("requires machines.write when publishing a planogram version", async () => {
    const publishMachinePlanogramVersion = vi
      .fn()
      .mockResolvedValue({ planogramVersion: "PLAN-1" });
    const controller = new MachinesController({
      publishMachinePlanogramVersion,
    } as never);

    const permissions = Reflect.getMetadata(
      REQUIRED_PERMISSIONS_KEY,
      MachinesController.prototype.publishPlanogramVersion,
    );

    const body = { planogramVersion: "PLAN-1", slots: [] };
    expect(permissions).toEqual(["machines.write"]);
    await expect(
      controller.publishPlanogramVersion(
        { id: "admin-1" } as never,
        "550e8400-e29b-41d4-a716-446655440000",
        body as never,
      ),
    ).resolves.toEqual({ planogramVersion: "PLAN-1" });
    expect(publishMachinePlanogramVersion).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      body,
      "admin-1",
    );
  });

  it("uses machine identity for published planogram fetch and ack", async () => {
    const getPublishedPlanogramByMachineCode = vi
      .fn()
      .mockResolvedValue({ planogramVersion: "PLAN-1" });
    const acknowledgeMachinePlanogramVersion = vi
      .fn()
      .mockResolvedValue({ status: "active" });
    const controller = new MachinesController({
      getPublishedPlanogramByMachineCode,
      acknowledgeMachinePlanogramVersion,
    } as never);

    await expect(
      controller.getPublishedPlanogramVersion(
        { code: "M001" } as never,
        "M001",
      ),
    ).resolves.toEqual({ planogramVersion: "PLAN-1" });
    await expect(
      controller.acknowledgePlanogramVersion(
        { code: "M001" } as never,
        "M001",
        "PLAN-1",
      ),
    ).resolves.toEqual({ status: "active" });

    expect(getPublishedPlanogramByMachineCode).toHaveBeenCalledWith("M001");
    expect(acknowledgeMachinePlanogramVersion).toHaveBeenCalledWith(
      "M001",
      "PLAN-1",
    );
  });
});
