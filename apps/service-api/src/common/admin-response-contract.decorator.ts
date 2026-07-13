import type { AdminApiResponseContract } from "@vem/shared";
import type { z } from "zod";

import { SetMetadata } from "@nestjs/common";

export const ADMIN_RESPONSE_CONTRACT = Symbol("admin-response-contract");

export function AdminResponseContract(
  contract: AdminApiResponseContract<
    "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    string,
    z.ZodType
  >,
): MethodDecorator {
  return SetMetadata(ADMIN_RESPONSE_CONTRACT, contract);
}
