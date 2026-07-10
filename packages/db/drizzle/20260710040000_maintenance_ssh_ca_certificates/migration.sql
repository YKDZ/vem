CREATE SEQUENCE "maintenance_ssh_certificate_serial_seq" AS bigint START WITH 1 INCREMENT BY 1;--> statement-breakpoint
CREATE TABLE "maintenance_ssh_certificates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "public_key_fingerprint" varchar(64) NOT NULL,
  "certificate" text NOT NULL,
  "certificate_fingerprint" varchar(64) NOT NULL,
  "serial" bigint NOT NULL,
  "key_id" varchar(256) NOT NULL,
  "principal" varchar(64) NOT NULL,
  "source_address" varchar(15) NOT NULL,
  "valid_after" timestamp with time zone NOT NULL,
  "valid_before" timestamp with time zone NOT NULL,
  "ca_fingerprint" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "maintenance_ssh_certificates_serial_positive_check" CHECK ("serial" > 0),
  CONSTRAINT "maintenance_ssh_certificates_validity_check" CHECK ("valid_before" > "valid_after"),
  CONSTRAINT "maintenance_ssh_certificates_public_key_fingerprint_check" CHECK ("public_key_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "maintenance_ssh_certificates_certificate_fingerprint_check" CHECK ("certificate_fingerprint" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "maintenance_ssh_certificates"
  ADD CONSTRAINT "maintenance_ssh_certificates_session_id_maintenance_sessions_id_fk"
  FOREIGN KEY ("session_id") REFERENCES "maintenance_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_ssh_certificates_session_request_unique"
  ON "maintenance_ssh_certificates" USING btree ("session_id", "request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_ssh_certificates_serial_unique"
  ON "maintenance_ssh_certificates" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "maintenance_ssh_certificates_session_idx"
  ON "maintenance_ssh_certificates" USING btree ("session_id");
