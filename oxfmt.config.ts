import { defineConfig } from "oxfmt";

export default defineConfig({
  $schema: "./node_modules/oxfmt/configuration_schema.json",
  printWidth: 80,
  ignorePatterns: [
    "**/dist",
    "packages/db/drizzle",
    "packages/shared/generated/vision-v2",
    // Generated source is byte-stable contract output; the generator owns it.
    "packages/shared/src/generated/vision-v2-bundle.ts",
  ],
  sortImports: {
    groups: [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown",
    ],
  },
  sortTailwindcss: {
    stylesheet: "apps/admin-ui/src/style.css",
    functions: ["clsx", "cn"],
    preserveWhitespace: true,
  },
  sortPackageJson: {
    sortScripts: true,
  },
});
