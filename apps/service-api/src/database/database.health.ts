import { Inject, Injectable } from "@nestjs/common";
import { sql, type DrizzleClient } from "@vem/db";

import { DRIZZLE_CLIENT } from "./database.constants";

@Injectable()
export class DatabaseHealth {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient) {}

  async ping(): Promise<"ok"> {
    await this.db.execute(sql`SELECT 1`);
    return "ok";
  }
}
