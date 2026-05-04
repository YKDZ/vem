import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { DrizzleDB } from "@vem/db";

import { AppConfigService } from "../config/app-config.service";
import { ConfigModule } from "../config/config.module";
import { DRIZZLE_CLIENT, DRIZZLE_DB } from "./database.constants";
import { DatabaseHealth } from "./database.health";

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DRIZZLE_DB,
      inject: [AppConfigService],
      useFactory: async (config: AppConfigService) => {
        const db = new DrizzleDB(config.databaseUrl);
        await db.connect();
        return db;
      },
    },
    {
      provide: DRIZZLE_CLIENT,
      inject: [DRIZZLE_DB],
      useFactory: (db: DrizzleDB) => db.client,
    },
    DatabaseHealth,
  ],
  exports: [DRIZZLE_DB, DRIZZLE_CLIENT, DatabaseHealth],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDB) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.disconnect();
  }
}
