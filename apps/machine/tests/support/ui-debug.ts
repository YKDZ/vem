import type { Page } from "@playwright/test";

import type { MachineRuntimeScenario } from "../../src/dev/runtime-scenarios";

const UI_DEBUG_ENABLED_STORAGE_KEY = "vem.machine.uiDebug.enabled";
const UI_DEBUG_SCENARIO_STORAGE_KEY = "vem.machine.uiDebug.scenario";

type UiDebugInitOptions = {
  scenario: string;
};

export async function seedUiDebugMode(
  page: Page,
  options: UiDebugInitOptions,
): Promise<void> {
  await page.addInitScript(
    ({ enabledKey, scenarioKey, scenario }) => {
      window.localStorage.setItem(enabledKey, "1");
      window.localStorage.setItem(scenarioKey, scenario);
    },
    {
      enabledKey: UI_DEBUG_ENABLED_STORAGE_KEY,
      scenarioKey: UI_DEBUG_SCENARIO_STORAGE_KEY,
      scenario: options.scenario,
    },
  );
}

export async function loadMachineRuntimeScenario(
  page: Page,
  scenario: MachineRuntimeScenario,
): Promise<void> {
  await seedUiDebugMode(page, { scenario: scenario.fixtureScenarioId });
  await page.goto(`/#${scenario.targetRoute}`);
}
