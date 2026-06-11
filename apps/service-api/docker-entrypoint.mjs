import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const { DrizzleDB } = require("@vem/db");

async function migrate() {
  const dbEntry = require.resolve("@vem/db");
  const migrationsFolder = join(dirname(dbEntry), "..", "drizzle");
  const db = new DrizzleDB(process.env.DATABASE_URL);
  try {
    await db.connect();
    await db.migrate(migrationsFolder);
  } finally {
    await db.disconnect();
  }
}

await migrate();
await import("./dist/main.js");
