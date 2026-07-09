UPDATE "payments" p
SET "provider_config_snapshot_json" = jsonb_strip_nulls(
  jsonb_build_object(
    'version', 1,
    'id', pc."id",
    'providerId', pp."id",
    'providerCode', pp."code",
    'machineId', pc."machine_id",
    'merchantNo', pc."merchant_no",
    'appId', pc."app_id",
    'publicConfigJson',
      coalesce(pc."public_config_json", '{}'::jsonb)
        || jsonb_build_object(
          'notifyUrl',
          concat('/api/payments/webhooks/', pp."code")
        ),
    'sensitiveConfigEncryptedJson', pc."config_encrypted_json",
    'boundAt', to_jsonb(coalesce(p."created_at", now()))
  )
)
FROM "payment_provider_configs" pc
INNER JOIN "payment_providers" pp ON pp."id" = pc."provider_id"
WHERE p."payment_provider_config_id" = pc."id"
  AND p."provider_id" = pp."id"
  AND (
    p."provider_config_snapshot_json" IS NULL
    OR NOT (p."provider_config_snapshot_json" ? 'sensitiveConfigEncryptedJson')
  );
