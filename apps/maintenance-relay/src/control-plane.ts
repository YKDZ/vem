import {
  maintenanceRelayCredentialExchangeResponseSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceRelayObservedStateSchema,
  type MaintenanceRelayDesiredState,
  type MaintenanceRelayObservedState,
} from "@vem/shared/schemas/maintenance-access";

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
  constructor(
    private readonly apiBaseUrl: string,
    private readonly credential: string,
    private readonly request: typeof fetch = fetch,
  ) {}

  async exchangeCredential(): Promise<{
    accessToken: string;
    expiresAt: string;
  }> {
    const response = await this.request(
      this.url("maintenance-relay/credential-exchange"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: this.credential }),
      },
    );
    return maintenanceRelayCredentialExchangeResponseSchema.parse(
      await responseData(response),
    );
  }

  async fetchDesiredState(
    accessToken: string,
  ): Promise<MaintenanceRelayDesiredState> {
    const response = await this.request(
      this.url("maintenance-relay/desired-state"),
      {
        headers: { authorization: `Bearer ${accessToken}` },
      },
    );
    return maintenanceRelayDesiredStateSchema.parse(
      await responseData(response),
    );
  }

  async reportObservedState(
    accessToken: string,
    observed: MaintenanceRelayObservedState,
  ): Promise<void> {
    const response = await this.request(
      this.url("maintenance-relay/observed-state"),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(observed),
      },
    );
    maintenanceRelayObservedStateSchema.parse(await responseData(response));
  }

  private url(path: string): string {
    return new URL(path, `${this.apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  }
}

async function responseData(response: Response): Promise<unknown> {
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
