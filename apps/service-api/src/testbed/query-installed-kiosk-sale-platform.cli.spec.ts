import { describe, expect, it } from "vitest";

import {
  buildInstalledKioskSalePlatformRawReport,
  parseInstalledKioskSalePlatformQueryArgs,
} from "./query-installed-kiosk-sale-platform.cli";

const args = [
  "--database-url",
  "postgresql://vem:runner-only@127.0.0.1:55433/vem_factory_acceptance",
  "--run-id",
  "RUN-204",
  "--machine-code",
  "VEM-TESTBED-FACTORY-RUN-204",
  "--order-id",
  "order-204",
  "--payment-id",
  "payment-204",
  "--order-no",
  "order-no-204",
  "--command-id",
  "command-204",
  "--movement-id",
  "movement-204",
];

describe("installed kiosk sale platform raw query", () => {
  it("requires a PostgreSQL runner-local connection URL", () => {
    expect(() =>
      parseInstalledKioskSalePlatformQueryArgs(
        args.map((value) =>
          value ===
          "postgresql://vem:runner-only@127.0.0.1:55433/vem_factory_acceptance"
            ? "https://platform.example.test"
            : value,
        ),
      ),
    ).toThrow("--database-url must be a PostgreSQL URL");
  });

  it("emits raw records and scopes without persisting the database URL", () => {
    const options = parseInstalledKioskSalePlatformQueryArgs(args);
    const report = buildInstalledKioskSalePlatformRawReport({
      options,
      machineId: "machine-204",
      raw: {
        orders: [],
        payments: [],
        reservations: [],
        commands: [],
        movements: [],
      },
    });

    expect(report).toEqual({
      schemaVersion: "installed-kiosk-sale-platform-raw-records/v1",
      source: "authoritative_ephemeral_platform_database",
      scope: {
        runId: "RUN-204",
        machineCode: "VEM-TESTBED-FACTORY-RUN-204",
        machineId: "machine-204",
      },
      raw: {
        orders: [],
        payments: [],
        reservations: [],
        commands: [],
        movements: [],
      },
    });
    expect(JSON.stringify(report)).not.toContain("runner-only@127.0.0.1");
  });
});
