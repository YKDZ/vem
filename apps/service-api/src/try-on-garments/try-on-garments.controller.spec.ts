import "reflect-metadata";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import {
  adminCreateTryOnGarmentContract,
  adminGetTryOnGarmentContract,
  adminTryOnGarmentConfirmationContract,
  adminTryOnGarmentActivationContract,
  adminTryOnGarmentRetirementContract,
} from "@vem/shared";
import { describe, expect, it } from "vitest";

import { ADMIN_ENDPOINT_CONTRACT } from "../common/admin-endpoint-contract.decorator";
import { TryOnGarmentsController } from "./try-on-garments.controller";

describe("TryOnGarmentsController endpoint binding", () => {
  it.each([
    ["createDraft", adminCreateTryOnGarmentContract],
    ["getById", adminGetTryOnGarmentContract],
    ["confirm", adminTryOnGarmentConfirmationContract],
    ["activate", adminTryOnGarmentActivationContract],
    ["retire", adminTryOnGarmentRetirementContract],
  ] as const)(
    "binds %s route directly to its shared contract",
    (method, contract) => {
      const handler = TryOnGarmentsController.prototype[method];
      expect(Reflect.getMetadata(ADMIN_ENDPOINT_CONTRACT, handler)).toBe(
        contract,
      );
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(contract.path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        contract.method === "GET" ? 0 : 1,
      );
    },
  );
});
