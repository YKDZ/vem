import {
  createMaintenanceSessionRequestSchema,
  maintenanceAccessOverviewResponseSchema,
  maintenanceSessionResponseSchema,
  type MaintenanceAccessOverviewResponse,
  type MaintenanceSessionResponse,
} from "@vem/shared";
import { z } from "zod";

import { getContract, postContract } from "./request";

export async function getMaintenanceAccessOverview(): Promise<MaintenanceAccessOverviewResponse> {
  return await getContract(
    "/maintenance-access",
    createMaintenanceSessionRequestSchema.partial(),
    maintenanceAccessOverviewResponseSchema,
    {},
  );
}

export async function createMaintenanceSession(
  body: z.input<typeof createMaintenanceSessionRequestSchema>,
): Promise<MaintenanceSessionResponse> {
  return await postContract(
    "/maintenance-access/sessions",
    createMaintenanceSessionRequestSchema,
    maintenanceSessionResponseSchema,
    body,
  );
}
