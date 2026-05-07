ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payment_webhook_invalid';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payment_reconciliation_failed';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payment_refund_failed';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payment_certificate_expiring';
ALTER TYPE notification_type ADD VALUE IF NOT EXISTS 'payment_provider_unready';
