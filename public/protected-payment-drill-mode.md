# 受保护支付演练模式运行手册

## 范围

受保护支付演练模式用于机器面向顾客前的操作员演练。该模式只创建平台演练订单，不得使用真实顾客凭据、真实付款码，或真实支付通道的扣款和退款调用。

## 保护规则

- 只有具备 `payments.configure` 权限的已认证管理员可以创建或恢复演练。
- 每个请求都必须包含非空 `reason`。
- API 会创建新的演练订单，不接受 `targetOrderId`，也不能用于恢复已有顾客订单。
- 演练产物会在订单、支付、退款和管理列表响应中标记 `isDrill=true`、`isTest=true` 和场景。订单画像还会存储操作者、原因和时间戳审计证据。
- 恢复动作只更新模拟平台状态，不调用支付宝或微信支付的扣款、撤销、查询或退款 API。
- 正常的定时或手动支付对账、机器状态读取时对账、退款查询或对账，以及支付就绪和积压指标都会跳过演练产物。
- 演练恢复是受保护的模拟证据。它不能证明真实生产支付通道流程可用，也不得作为生产支付验收依据。

## 创建演练

```bash
curl -fsS -X POST "$API_URL/api/payments/drills" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "machineId": "MACHINE_UUID",
    "scenario": "payment_code_unknown",
    "reason": "pre-launch payment-code unknown recovery rehearsal"
  }'
```

支持的场景：

- `payment_code_unknown`
- `user_confirming_timeout`
- `query_failed_then_reversed`
- `qr_reconcile_failed`
- `refund_required`
- `manual_handling`

## 恢复动作

```bash
curl -fsS -X POST "$API_URL/api/payments/drills/$DRILL_ORDER_ID/recovery-actions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "reverse_payment_code",
    "reason": "operator rehearsed payment-code reversal after unknown result"
  }'
```

动作映射：

- 付款码未知或顾客确认中：`query_payment_code`、`reverse_payment_code` 或 `mark_manual_handling`。
- 查询失败后撤销：`reverse_payment_code` 或 `mark_manual_handling`。
- 二维码对账失败：`reconcile_qr` 或 `mark_manual_handling`。
- 需要退款：`request_refund` 或 `mark_manual_handling`。
- 人工处理：`mark_manual_handling`。

## 真实事件恢复

对于非演练的生产事件，不要使用受保护支付演练模式。应使用事件运行手册中的正常订单、退款和支付恢复端点，例如用于确认实际出货结果的订单恢复端点、用于不确定真实支付的支付手动对账端点，以及用于真实通道退款验证的退款查询端点。这些端点有意保持独立，因为它们可能查询已配置的支付通道，或修改真实顾客订单状态。

## 审计检查

每次演练后，检查审计日志中是否包含：

- `payments.drill.create`
- `payments.drill.recovery.<action>`
- 操作管理员 ID
- 原因
- 场景
- 演练订单 ID

演练订单号、支付号和退款号以 `DRILL-` 开头；管理列表响应包含 `isDrill=true`、`isTest=true` 和 `scenario`；已存储的订单画像包含 `kind=protected_payment_drill`、`isDrill=true` 和 `isTest=true`。
