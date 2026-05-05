import { machineCatalogItemSchema } from "@vem/shared";
import { z } from "zod";

import type { MachineApiClient } from "./request";

const machineCatalogResponseSchema = z.array(machineCatalogItemSchema);

export type MachineCatalogItem = z.infer<typeof machineCatalogItemSchema>;

export async function getMachineCatalog(
  client: MachineApiClient,
  machineCode: string,
): Promise<MachineCatalogItem[]> {
  const response = await client.get<unknown>(
    `/machines/${encodeURIComponent(machineCode)}/catalog`,
  );
  return machineCatalogResponseSchema.parse(response);
}
