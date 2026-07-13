import type { MaintenanceRelayObservedState } from "@vem/shared/schemas/maintenance-access";

import type { RelayControlPlane } from "./control-plane.js";

import { MaintenanceRelayReconciler } from "./reconciler.js";

export class MaintenanceRelayRuntime {
  private token: { accessToken: string; expiresAt: string } | undefined;

  constructor(
    private readonly controlPlane: RelayControlPlane,
    private readonly reconciler: MaintenanceRelayReconciler,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async poll(): Promise<MaintenanceRelayObservedState | undefined> {
    try {
      const token = await this.getToken();
      const desired = await this.controlPlane.fetchDesiredState(token);
      const observed = await this.reconciler.reconcile(desired);
      await this.controlPlane.reportObservedState(token, observed);
      return observed;
    } catch (error) {
      let observed = this.reconciler.currentObserved();
      try {
        observed = (await this.reconciler.enforceLocalExpiry()) ?? observed;
      } catch {
        observed = this.reconciler.currentObserved() ?? observed;
      }
      if (observed && this.token && this.tokenIsValid(this.token)) {
        try {
          await this.controlPlane.reportObservedState(
            this.token.accessToken,
            observed,
          );
        } catch {
          // The local firewall deadline is authoritative during an outage.
        }
      }
      throw error;
    }
  }

  private async getToken(): Promise<string> {
    if (!this.token || !this.tokenIsValid(this.token)) {
      this.token = await this.controlPlane.exchangeCredential();
    }
    return this.token.accessToken;
  }

  private tokenIsValid(token: { expiresAt: string }): boolean {
    return Date.parse(token.expiresAt) > this.now().getTime() + 5_000;
  }
}
