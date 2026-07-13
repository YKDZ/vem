import {
  maintenanceRelayCredentialExchangeResponseSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceRelayObservedStateSchema,
  type MaintenanceRelayDesiredState,
  type MaintenanceRelayObservedState,
} from "@vem/shared/schemas/maintenance-access";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import {
  createPinnedPrivateDnsLookup,
  resolveServiceApiTransport,
  serviceApiRequiresPinnedDns,
  type RelayDnsResolver,
} from "./transport.js";

type RelayRequestInit = {
  method?: string;
  redirect: "error";
  dispatcher?: Dispatcher;
  headers: Record<string, string>;
  body?: string;
};
type RelayResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
type RelayRequest = (
  input: string | URL,
  init?: RelayRequestInit,
) => Promise<RelayResponse>;

const defaultRelayRequest: RelayRequest = async (input, init) =>
  await undiciFetch(input, init);

export type HttpRelayControlPlaneOptions = {
  allowInsecureHttp?: boolean;
  request?: RelayRequest;
  resolveDns?: RelayDnsResolver;
};

export type RelayControlPlane = {
  exchangeCredential: () => Promise<{ accessToken: string; expiresAt: string }>;
  fetchDesiredState: (
    accessToken: string,
  ) => Promise<MaintenanceRelayDesiredState>;
  reportObservedState: (
    accessToken: string,
    observed: MaintenanceRelayObservedState,
  ) => Promise<void>;
};

export class HttpRelayControlPlane implements RelayControlPlane {
  private readonly request: RelayRequest;
  private readonly dispatcher: Dispatcher | undefined;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly credential: string,
    requestOrOptions: RelayRequest | HttpRelayControlPlaneOptions = {},
  ) {
    const options =
      typeof requestOrOptions === "function"
        ? { request: requestOrOptions }
        : requestOrOptions;
    resolveServiceApiTransport(apiBaseUrl, options.allowInsecureHttp ?? false);
    this.request = options.request ?? defaultRelayRequest;
    this.dispatcher = serviceApiRequiresPinnedDns(apiBaseUrl)
      ? new Agent({
          connect: {
            lookup: createPinnedPrivateDnsLookup(options.resolveDns),
          },
        })
      : undefined;
  }

  async exchangeCredential(): Promise<{
    accessToken: string;
    expiresAt: string;
  }> {
    const response = await this.send("maintenance-relay/credential-exchange", {
      method: "POST",
      redirect: "error",
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: this.credential }),
    });
    return maintenanceRelayCredentialExchangeResponseSchema.parse(
      await responseData(response),
    );
  }

  async fetchDesiredState(
    accessToken: string,
  ): Promise<MaintenanceRelayDesiredState> {
    const response = await this.send("maintenance-relay/desired-state", {
      redirect: "error",
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return maintenanceRelayDesiredStateSchema.parse(
      await responseData(response),
    );
  }

  async reportObservedState(
    accessToken: string,
    observed: MaintenanceRelayObservedState,
  ): Promise<void> {
    const response = await this.send("maintenance-relay/observed-state", {
      method: "POST",
      redirect: "error",
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(observed),
    });
    maintenanceRelayObservedStateSchema.parse(await responseData(response));
  }

  private url(path: string): string {
    return new URL(path, `${this.apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  }

  private async send(
    path: string,
    init: RelayRequestInit,
  ): Promise<RelayResponse> {
    try {
      return await this.request(this.url(path), init);
    } catch (error) {
      throw findDnsPolicyError(error) ?? error;
    }
  }
}

function findDnsPolicyError(error: unknown): Error | undefined {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (
      current instanceof Error &&
      "code" in current &&
      current.code === "EACCES" &&
      current.message.startsWith("insecure HTTP single-label DNS ")
    ) {
      return current;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

async function responseData(response: RelayResponse): Promise<unknown> {
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`control plane returned ${response.status}`);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("code" in payload) ||
    (payload as { code: unknown }).code !== 0 ||
    !("data" in payload)
  ) {
    throw new Error("control plane returned an invalid API envelope");
  }
  return (payload as { data: unknown }).data;
}
