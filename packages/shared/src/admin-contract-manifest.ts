export type AdminContractManifestEntry = Readonly<{
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  providerMethod: string;
  callerPath?: string;
  callerMethods?: readonly string[];
  schemaReferences?: Readonly<{
    pathParamsSchema?: readonly string[];
    querySchema?: readonly string[];
    bodySchema?: readonly string[];
    responseSchema?: readonly string[];
  }>;
}>;

export type AdminContractManifest = Readonly<{
  slice: string;
  controllerPaths: readonly string[];
  callerPaths: readonly string[];
  contracts: Readonly<Record<string, AdminContractManifestEntry>>;
}>;

/**
 * Static registration of one converged Admin contract slice. The repository
 * contract guard parses these manifests (not this runtime object) to lock the
 * provider/caller boundary without naming-convention heuristics.
 */
export function defineAdminContractManifest<T extends AdminContractManifest>(
  manifest: T,
): T {
  return manifest;
}
