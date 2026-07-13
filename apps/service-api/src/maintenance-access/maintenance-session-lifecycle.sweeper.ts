import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";

import { MaintenanceAccessService } from "./maintenance-access.service";

export const MAINTENANCE_LIFECYCLE_CLOCK = Symbol(
  "MAINTENANCE_LIFECYCLE_CLOCK",
);
export const MAINTENANCE_LIFECYCLE_INTERVAL = Symbol(
  "MAINTENANCE_LIFECYCLE_INTERVAL",
);

export type MaintenanceLifecycleClock = { now: () => Date };
export type MaintenanceLifecycleInterval = {
  set: (callback: () => void, intervalMs: number) => unknown;
  clear: (handle: unknown) => void;
};

export const systemMaintenanceLifecycleClock: MaintenanceLifecycleClock = {
  now: () => new Date(),
};

function isNodeIntervalHandle(handle: unknown): handle is NodeJS.Timeout {
  return (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof handle.unref === "function"
  );
}

export const systemMaintenanceLifecycleInterval: MaintenanceLifecycleInterval =
  {
    set: (callback, intervalMs) => {
      const handle = setInterval(callback, intervalMs);
      handle.unref();
      return handle;
    },
    clear: (handle) => {
      if (!isNodeIntervalHandle(handle)) {
        throw new TypeError("Invalid maintenance lifecycle interval handle");
      }
      clearInterval(handle);
    },
  };

@Injectable()
export class MaintenanceSessionLifecycleSweeper
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(MaintenanceSessionLifecycleSweeper.name);
  private intervalHandle: unknown;
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(MaintenanceAccessService)
    private readonly maintenanceAccess: Pick<
      MaintenanceAccessService,
      "sweepExpiredSessions"
    >,
    @Inject(MAINTENANCE_LIFECYCLE_CLOCK)
    private readonly clock: MaintenanceLifecycleClock,
    @Inject(MAINTENANCE_LIFECYCLE_INTERVAL)
    private readonly interval: MaintenanceLifecycleInterval,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sweep();
    this.intervalHandle = this.interval.set(() => {
      void this.sweep().catch(() => {
        this.logger.warn("Maintenance Session lifecycle sweep failed");
      });
    }, 5_000);
  }

  onApplicationShutdown(): void {
    if (this.intervalHandle === undefined) return;
    this.interval.clear(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  private async sweep(): Promise<void> {
    if (this.inFlight) {
      await this.inFlight;
      return;
    }
    const operation = Promise.resolve().then(async () => {
      await this.maintenanceAccess.sweepExpiredSessions(this.clock.now());
    });
    const tracked = operation.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    await tracked;
  }
}
