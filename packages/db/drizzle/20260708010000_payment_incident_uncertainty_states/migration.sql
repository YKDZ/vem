ALTER TYPE "order_payment_state" ADD VALUE IF NOT EXISTS 'payment_unknown';--> statement-breakpoint
ALTER TYPE "payment_status" ADD VALUE IF NOT EXISTS 'unknown';--> statement-breakpoint
ALTER TYPE "payment_code_attempt_status" ADD VALUE IF NOT EXISTS 'reversal_unknown';
