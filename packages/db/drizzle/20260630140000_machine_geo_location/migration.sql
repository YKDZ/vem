ALTER TABLE "machines" ADD COLUMN "geo_latitude" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "geo_longitude" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "geo_timezone" text;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_geo_location_all_or_nothing_check" CHECK (
  ("geo_latitude" IS NULL AND "geo_longitude" IS NULL AND "geo_timezone" IS NULL)
  OR
  ("geo_latitude" IS NOT NULL AND "geo_longitude" IS NOT NULL AND "geo_timezone" IS NOT NULL)
);--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_geo_location_coordinate_range_check" CHECK (
  "geo_latitude" IS NULL
  OR
  ("geo_latitude" >= -90 AND "geo_latitude" <= 90 AND "geo_longitude" >= -180 AND "geo_longitude" <= 180)
);
