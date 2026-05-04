"use strict";

/**
 * Custom NestJS webpack configuration.
 *
 * Root cause of the ESM import-extension problem: tsc (used by `nest build`)
 * preserves import paths verbatim; Node ESM requires explicit `.js` suffixes.
 * Solution: bundle the output with webpack so all intra-app relative imports
 * are inlined — there are no relative paths left in the final bundle.
 *
 * @vem/* workspace packages ship dual CJS + ESM builds; webpack externalizes
 * them normally and at runtime `require('@vem/...')` resolves via the
 * `"require"` export condition to the CJS build.
 */
module.exports = function (options) {
  // Use NestJS default externals — all node_modules (including @vem/*) are
  // externalized as CommonJS require() calls at runtime.
  return options;
};
