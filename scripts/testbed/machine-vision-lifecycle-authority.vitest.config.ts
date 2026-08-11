import { defineConfig, mergeConfig } from "vitest/config";

import machineConfig from "../../apps/machine/vite.config";

export default mergeConfig(
  machineConfig,
  defineConfig({
    test: {
      include: [
        "src/native/vision.spec.ts",
        "src/stores/try-on.spec.ts",
        "src/views/TryOnView.spec.ts",
        "src/try-on/eligibility.spec.ts",
        "../../scripts/testbed/fixtures/machine-vision-authority-*.fixture.ts",
      ],
    },
  }),
);
