import type { MigratorInitFailResponse } from "drizzle-orm/migrator";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { combinedRelations, type DrizzleRelations } from "./schema";

export class DrizzleDB {
  public client: NodePgDatabase<DrizzleRelations> & { $client: Pool };

  constructor(connectionString = process.env.DATABASE_URL) {
    if (!connectionString) {
      throw new Error("DATABASE_URL is required to create DrizzleDB");
    }

    const pool = new Pool({
      connectionString,
    });

    this.client = drizzle({
      client: pool,
      relations: combinedRelations,
    });
  }

  async connect(): Promise<void> {
    // Pool manages connections lazily; execute a ping to verify connectivity
    await this.client.execute(sql`SELECT 1`);
  }

  async disconnect(): Promise<void> {
    await this.client.$client.end();
  }

  async ping(): Promise<void> {
    await this.client.execute(sql`SELECT 1`);
  }

  async migrate(
    migrationsFolder: string,
  ): Promise<void | MigratorInitFailResponse> {
    return await migrate(this.client, {
      migrationsFolder,
    });
  }
}

export type DrizzleClient = Omit<DrizzleDB["client"], "$client">;
export type DrizzleTransaction = Parameters<
  Parameters<DrizzleClient["transaction"]>[0]
>[0];
