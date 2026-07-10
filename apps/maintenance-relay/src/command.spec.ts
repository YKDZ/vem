import { describe, expect, it } from "vitest";

import { runCommand } from "./command";

describe("relay system command environment", () => {
  it("passes only fixed locale and executable search values to system commands", async () => {
    const previous = process.env["MAINTENANCE_RELAY_CREDENTIAL"];
    process.env["MAINTENANCE_RELAY_CREDENTIAL"] =
      "parent-secret-must-not-reach-system-commands";
    try {
      const { stdout } = await runCommand("env", []);
      expect(stdout.trim().split("\n").sort()).toEqual(
        [
          "LANG=C.UTF-8",
          "LC_ALL=C.UTF-8",
          "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ].sort(),
      );
      expect(stdout).not.toContain("parent-secret-must-not-reach");
    } finally {
      if (previous === undefined) {
        delete process.env["MAINTENANCE_RELAY_CREDENTIAL"];
      } else {
        process.env["MAINTENANCE_RELAY_CREDENTIAL"] = previous;
      }
    }
  });
});
