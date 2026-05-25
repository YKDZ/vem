import { defineConfig } from "oxlint";

import rootConfig from "../../oxlint.config.ts";

export default defineConfig({
  extends: [rootConfig],
  rules: {
    "typescript/explicit-module-boundary-types": "off",
  },
  overrides: [
    {
      files: ["**/*.spec.ts"],
      rules: {
        "typescript/explicit-module-boundary-types": "off",
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-argument": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
      },
    },
  ],
});
