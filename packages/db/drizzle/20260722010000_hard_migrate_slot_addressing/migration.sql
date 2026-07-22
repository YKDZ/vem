ALTER TABLE "machine_slots" RENAME COLUMN "layer_no" TO "row_no";--> statement-breakpoint
ALTER TABLE "machine_planogram_slots" RENAME COLUMN "layer_no" TO "row_no";--> statement-breakpoint
ALTER TABLE "machine_slots" RENAME CONSTRAINT "machine_slots_layer_no_positive" TO "machine_slots_row_no_positive";--> statement-breakpoint
ALTER TABLE "machine_slots" DROP COLUMN "slot_code";--> statement-breakpoint
ALTER TABLE "machine_planogram_slots" DROP COLUMN "slot_code";
