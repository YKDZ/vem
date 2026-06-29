# 受保护履约演练模式运行手册

## 范围

受保护履约演练模式用于机器面向顾客前的操作员演练。该模式只创建平台演练订单，并附带模拟已支付和模拟履约失败证据。

它不得使用真实顾客订单、真实下位机命令、真实库存流水或真实支付通道退款。

## 保护规则

- 只有具备 `orders.recover` 权限的已认证管理员可以创建或恢复演练。
- 每个请求都必须包含非空 `reason`。
- API 会创建新的演练订单，不接受 `targetOrderId`，也不能用于恢复已有顾客订单。
- 演练产物会在订单、支付、演练恢复创建的退款、售货命令证据和管理列表响应中标记 `isDrill=true`、`isTest=true` 和 `scenario`。
- 恢复动作只记录模拟证据。它们不会调用售货服务发送补偿命令，不会调用支付通道退款 API，也不会写入真实库存流水或库存预留。
- 正常订单恢复会拒绝演练订单，并引导操作员使用受保护演练端点。
- 演练恢复是受保护的模拟证据。它证明运行手册和操作员流程可以安全演练，但不能证明真实下位机、库存或支付通道退款路径可用。

## 创建演练

```bash
curl -fsS -X POST "$API_URL/api/orders/fulfillment-drills" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "machineId": "MACHINE_UUID",
    "scenario": "unknown_dispense_result",
    "reason": "pre-launch unknown dispense recovery rehearsal"
  }'
```

支持的场景：

- `dispense_failed`
- `unknown_dispense_result`
- `pickup_timeout`
- `maintenance_lock_required`

## 恢复动作

```bash
curl -fsS -X POST "$API_URL/api/orders/fulfillment-drills/$DRILL_ORDER_ID/recovery-actions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "confirm_not_dispensed",
    "reason": "operator confirmed no item left the machine during the drill"
  }'
```

动作映射：

- 出货失败：`confirm_not_dispensed` 或 `request_refund`。
- 出货结果未知：`confirm_dispensed` 或 `confirm_not_dispensed`。
- 取货超时：`confirm_dispensed` 或 `confirm_not_dispensed`。
- 需要维护锁：`confirm_not_dispensed`。
- 执行 `confirm_not_dispensed` 后，`request_refund` 和 `compensation_dispense` 可作为受保护模拟动作使用。

## 真实事件恢复

对于非演练的生产事件，不要使用受保护履约演练模式。应使用正常订单恢复端点：

```bash
POST /api/orders/:id/recovery-actions
```

该端点会按照事件运行手册调用真实售货、退款和库存路径。受保护演练端点有意保持独立，因为它绝不能影响顾客订单、硬件、库存或支付通道资金流。

## 审计检查

每次演练后，检查审计日志中是否包含：

- `orders.fulfillment_drill.create`
- `orders.fulfillment_drill.recovery.<action>`
- 操作管理员 ID
- 原因
- 场景
- 演练订单 ID

演练订单号、支付号和退款号以 `DRILL-` 开头；管理订单列表响应包含 `isDrill=true`、`isTest=true` 和 `scenario`；已存储的订单画像包含 `kind=protected_fulfillment_drill`、`isDrill=true`、`isTest=true` 和 `simulationOnly=true`。
