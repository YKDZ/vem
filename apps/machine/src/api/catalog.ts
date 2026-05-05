import type { MachineCatalogItem } from "@/types/catalog";

import type { MachineApiClient } from "./request";

export async function getMachineCatalog(
  client: MachineApiClient,
  machineCode: string,
): Promise<MachineCatalogItem[]> {
  return await client.get<MachineCatalogItem[]>(
    `/machines/${encodeURIComponent(machineCode)}/catalog`,
  );
}
