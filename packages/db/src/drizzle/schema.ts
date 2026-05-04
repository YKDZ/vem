import { relations } from "./schema/relations";
import * as schema from "./schema/schema";

export type DrizzleSchema = typeof schema;
export type DrizzleRelations = typeof relations;

export const combinedSchema: DrizzleSchema = schema;
export const combinedRelations: DrizzleRelations = relations;

export * from "./schema/schema";
export * from "./schema/relations";
