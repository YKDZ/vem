import { defineConfig } from "vitest/config";

const serverConditions = [
  "vem-source",
  "module",
  "node",
  "development|production",
];

export default defineConfig({
  resolve: {
    conditions: serverConditions,
  },
  ssr: {
    noExternal: ["@vem/db", "@vem/shared"],
    resolve: {
      conditions: serverConditions,
    },
  },
  test: {
    env: {
      MAINTENANCE_RELAY_PEER_ID: "550e8400-e29b-41d4-a716-446655440010",
      MAINTENANCE_RELAY_ENDPOINT: "127.0.0.1:51820",
      MAINTENANCE_RELAY_PUBLIC_KEY:
        "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
      MAINTENANCE_RELAY_TUNNEL_ADDRESS: "10.91.0.1",
    },
  },
});
