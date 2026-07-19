import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildSystemTouchKeyboardPowerShellScript,
  parseInstalledSystemTouchKeyboardArgs,
} from "./installed-system-touch-keyboard.mjs";

describe("installed system touch keyboard acceptance", () => {
  it("accepts the installed guest input, handoff, and output paths", () => {
    assert.deepEqual(
      parseInstalledSystemTouchKeyboardArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\VEM\\guest-input.json",
        "--handoff",
        "C:\\VEM\\installed-handoff.json",
        "--out",
        "C:\\VEM\\keyboard-report.json",
      ]),
      {
        mode: "full",
        guestInputPath: "C:\\VEM\\guest-input.json",
        handoffPath: "C:\\VEM\\installed-handoff.json",
        outPath: "C:\\VEM\\keyboard-report.json",
      },
    );
  });

  it("queries the visible Windows input pane by its real window class", () => {
    const script = buildSystemTouchKeyboardPowerShellScript();
    assert.match(script, /IPTip_Main_Window/);
    assert.match(script, /IsWindowVisible/);
    assert.match(script, /GetWindowThreadProcessId/);
    assert.match(script, /ConvertTo-Json -Compress/);
  });

  it("allows only its explicit maintenance probe through the customer route policy", () => {
    const source = readFileSync(
      new URL("./installed-system-touch-keyboard.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /forbiddenRoutes: route\.startsWith\("#\/maintenance"\) \? \[\] : undefined/,
    );
  });
});
