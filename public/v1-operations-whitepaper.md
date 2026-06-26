# VEM V1 运维白皮书

本文面向 V1 试点现场与后台运营人员，说明常见异常状态的含义、真实操作入口和恢复动作。V1 的目标是让机器在异常时进入可解释、可恢复、可追踪的状态；覆盖本文的恢复状态时，操作员必须使用已发布的 UI 或 API 动作完成恢复，并留下备注与审计记录。

## V1 运维原则

1. 先确认资金，再处理出货。支付结果以支付平台异步通知、Payment Event 或 Payment Result Reconciliation 为准，不以顾客手机页面或机器前台状态为准。
2. 未确认物理出货结果时，不自动重试出货。Unknown Dispense Result 统一进入人工确认和补偿路径。
3. 同一个 Vending Command 不得重复执行；需要补偿出货时使用新的 `compensation_dispense` 恢复动作。
4. 任何 Exception Recovery Action 都应在 Admin Operations Console 或 Machine Runtime Console 完成，并记录操作人、原因和备注。
5. 生产机器必须使用 Production Dispense Path，不允许 mock lower-controller 或 TCP simulator 进入可售状态。
6. V1 订单为 Single-Item Machine Order，不支持购物车或同一订单多件出货。

## 真实操作入口

| Surface                  | 路由或动作                 | 用途                                                                                                                        |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Admin Operations Console | `/orders`                  | 订单列表；打开 Order Investigation Drawer 查看支付、退款、出货命令、库存流水和恢复动作。                                    |
| Admin Operations Console | `/payments`                | 支付管理；查看 Payment Ops Readiness、Payment Provider Configuration、Payment Incident Trail、退款和 Payment Code Attempt。 |
| Admin Operations Console | `/machines`                | 机器列表；查看 Platform Machine 在线状态和最后心跳。                                                                        |
| Admin Operations Console | `/machines/:id`            | Machine Operations View；查看 Machine Heartbeat、Slot Sales State、Stock Reconciliation Case、整机维护锁和远程运维操作。    |
| Machine Runtime Console  | machine UI `#/maintenance` | 现场维护页；查看 daemon readiness、sale-critical blockers、scanner 状态、自检结果，并清除 Whole Machine Maintenance Lock。  |

实现动作映射：

- 订单恢复：`POST /api/orders/:id/recovery-actions`，action 为 `confirm_dispensed`、`confirm_not_dispensed`、`request_refund` 或 `compensation_dispense`。
- 支付对账：`POST /api/payments/:id/reconcile`。
- 退款查询：`POST /api/payments/refunds/:id/query`。
- 付款码查询：`POST /api/payments/payment-code-attempts/:id/query`。
- 付款码撤销：`POST /api/payments/payment-code-attempts/:id/reverse`。
- 库存异常复核：Admin `/machines/:id` 的 Stock Reconciliation Case 复核动作，action 为 `accept_machine_stock`、`reject_machine_stock` 或 `manual_correct`，可通过 `clearBlocker` 清除对应货道冻结。
- 整机维护锁清除：machine UI `#/maintenance` 调用 `POST /v1/maintenance/whole-machine-lock/clear`。

## 状态速查

| 状态             | VEM 域名                                                                            | 首要动作                                                           |
| ---------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 支付等待中       | Payment State `awaiting_payment`                                                    | 等待支付平台通知或执行 Payment Result Reconciliation。             |
| 支付确认中       | Payment Result Reconciliation 未完成                                                | 在 `/payments` 查询支付对账，不引导顾客重复付款。                  |
| 付款码尝试不确定 | Payment Code Attempt `unknown` / `user_confirming` / `querying` / `manual_handling` | 在 `/payments` 查询或撤销该 attempt。                              |
| 退款处理中       | Refund Decision 已发起，Refund 状态 `processing` / `created`                        | 在 `/payments` 查询退款结果，不重复发起退款。                      |
| 已支付未出货     | Payment State `paid`，Fulfillment State 未完成                                      | 在 `/orders` 打开订单调查抽屉，使用恢复动作触发退款或补偿出货。    |
| 出货失败         | Fulfillment State `dispense_failed`                                                 | 现场确认后申请退款或补偿出货；必要时保持货道冻结。                 |
| 出货结果未知     | Unknown Dispense Result                                                             | 人工确认 `confirm_dispensed` 或 `confirm_not_dispensed` 后再补偿。 |
| 货道冻结         | Slot Sales State `frozen` 或 sale safety blocker                                    | 在 `/machines/:id` 复核库存或维护后解除。                          |
| 库存异常         | Stock Reconciliation Case                                                           | 在 `/machines/:id` 接受、拒绝或修正库存上报。                      |
| 整机维护锁       | Whole Machine Maintenance Lock                                                      | 在 machine UI `#/maintenance` 排障并清除。                         |
| 机器离线         | Machine Heartbeat 超时或 sale readiness blocked                                     | 在 `/machines` / `/machines/:id` 查看最后心跳、MQTT 和 blocker。   |

## 支付异常恢复

### 二维码到期但顾客可能已付款

常见原因：

- 支付宝或微信异步通知延迟或丢失。
- Machine Runtime Console 未及时刷新 Transaction Snapshot。
- 支付平台查询短时不稳定，Payment Result Reconciliation 尚未完成。

恢复步骤：

1. 机器屏幕保持支付确认或结果页，展示 Customer Order Credential。
2. 后台进入 `/payments`，按 paymentNo、orderNo 或 providerCode 查找支付记录。
3. 对不确定支付执行 `POST /api/payments/:id/reconcile`。
4. 若查询为支付成功，平台记录 Payment Event，订单投影转为已支付并继续 Fulfillment State。
5. 若查询为未支付或可关闭，平台关闭订单或释放 Inventory Reservation。
6. 若查询仍不确定，订单保持人工处理或待对账；不要让顾客对同一 Machine Order 重复付款。

禁止动作：

- 不要仅凭顾客截图标记支付成功。
- 不要绕过 Payment Result Reconciliation 直接推进出货。

### 付款码扫码失败或结果不确定

常见原因：

- Scanner Runtime Status 离线，或串口配置不符合现场。
- 支付平台返回 `USER_PAYING`、系统异常、查询超时。
- 顾客付款码过期、重复读取，或同一订单已有活动 Payment Code Attempt。

恢复步骤：

1. 机器的 Payment Code Scan View 提示重新出示付款码或等待确认，不清空当前订单。
2. 后台进入 `/payments` 的“付款码尝试”，查看 masked auth code、attemptNo、providerStatus 和 failureCode。
3. 对 `unknown`、`user_confirming`、`querying` 或 `manual_handling` 状态执行 `POST /api/payments/payment-code-attempts/:id/query`。
4. 若查询成功，平台推进 Payment State 并触发后续出货。
5. 若确认未支付且需要释放该 attempt，填写原因并执行 `POST /api/payments/payment-code-attempts/:id/reverse`。
6. 撤销成功或 attempt 终态失败后，机器才允许顾客重新提交付款码。

禁止动作：

- 不要在 Payment Code Attempt 结果未知时创建新订单。
- 不要保存完整付款码；后台只展示脱敏值。

### 退款请求超时或返回 5xx

常见原因：

- 支付平台已受理退款，但 HTTP 响应丢失。
- 网关超时或沙箱环境不稳定。
- Refund Decision 已创建，但 providerRefundStatus 尚未回写。

恢复步骤：

1. 后台进入 `/payments` 的“退款管理”，筛选 `created` 或 `processing` 退款。
2. 查看 refundNo、paymentNo、orderNo 和 latestReconciliationStatus。
3. 对处理中退款执行 `POST /api/payments/refunds/:id/query`。
4. 查询成功后，平台更新 Refund、Payment State 和 Order State Projection。
5. 查询失败或仍不确定时，保留退款处理中或人工处理状态，并在 Payment Incident Trail 中保留错误原因。

禁止动作：

- 不要把超时类错误立即标记为退款失败。
- 不要在结果未知时再次发起同金额退款。

## 出货异常恢复

### 出货失败

常见原因：

- Lower Controller 返回机械故障、卡货、取货口异常。
- Hardware Error Policy 要求冻结货道、发起退款或创建 Maintenance Work Order。
- daemon 在 Command Log 中记录 Vending Command 失败。

恢复步骤：

1. 机器 Result View 展示出货失败和 Customer Order Credential。
2. 后台进入 `/orders`，打开 Order Investigation Drawer 查看 latestCommand、错误码、库存流水和可用恢复动作。
3. 现场确认商品是否已经物理出货。
4. 若确认未出，填写备注并执行 `request_refund` 或 `compensation_dispense`。
5. 若确认已出但平台未完成订单，执行 `confirm_dispensed`。
6. 若货道存在机械风险，在 `/machines/:id` 保持 Slot Sales State 不可售，并创建或更新 Maintenance Work Order。

禁止动作：

- 不要重放原 `commandNo`。
- 不要在未确认现场结果前补偿出货。

### 出货结果未知

常见原因：

- 平台发出 Vending Command 后没有收到最终 `dispense-result`。
- daemon 或工控机在出货过程中重启。
- 网络或 MQTT 中断导致结果丢失。

恢复步骤：

1. 后台在 `/orders` 打开 Order Investigation Drawer，确认 fulfillmentProjection.requiresPhysicalOutcomeConfirmation。
2. 现场检查取货口、货道和 Machine Local Stock Ledger。
3. 若确认已出货，填写备注并执行 `confirm_dispensed`。
4. 若确认未出货，先执行 `confirm_not_dispensed`。
5. 确认未出后，根据顾客处理方案执行 `request_refund` 或 `compensation_dispense`。
6. 关联货道在确认前保持不可售，避免同一 Slot Sales State 继续销售。

禁止动作：

- 不要自动重试出货。
- 不要对同一 `commandNo` 重发命令。

### 已支付但未触发出货

常见原因：

- 支付 webhook 到达失败，但 Payment Result Reconciliation 查到已支付。
- Machine Runtime Console 轮询 Transaction Snapshot 失败。
- MQTT Vending Command 发布失败或机器离线。

恢复步骤：

1. 在 `/payments` 对支付执行 `POST /api/payments/:id/reconcile`。
2. 在 `/orders` 查看订单的 Payment State、Fulfillment State 和 availableRecoveryActions。
3. 若支付成功但无可信出货结果，使用 `request_refund` 或 `compensation_dispense`，不要创建第二个同款订单代替恢复动作。
4. 若机器离线导致无法补偿出货，先按机器离线流程恢复，再执行补偿动作或退款。

## 库存与货道恢复

### 货道冻结

常见原因：

- 出货失败或 Unknown Dispense Result 后，daemon 将 Slot Sales State 置为 `frozen`。
- Stock Reconciliation Case 创建 sale safety blocker。
- 维护人员发现实际库存、货道或摆放异常。

恢复步骤：

1. 现场检查货道是否卡货、空货或摆放错误。
2. 后台进入 `/machines/:id`，查看货道与库存、冻结原因、linkedOrderNo 和 linkedCommandNo。
3. 若冻结来自 Stock Reconciliation Case，打开“库存异常复核”。
4. 根据现场结果选择 `accept_machine_stock`、`reject_machine_stock` 或 `manual_correct`，填写复核备注。
5. 只有库存和机械状态均确认可售时，勾选 `clearBlocker` 清除当前冻结。
6. 若机械异常未解决，保持冻结并处理 Maintenance Work Order。

禁止动作：

- 不要在未确认实际库存时恢复销售。
- 不要跳过 Stock Reconciliation Case 直接恢复 Slot Sales State。

### 库存异常复核

常见原因：

- Machine Stock Movement Ingestion 发现平台库存与 Machine Local Stock Ledger 不一致。
- 出货、补货或 Stock Count Correction 上传失败或归因不强。
- Planogram 变更后仍有库存需要现场盘点。

恢复步骤：

1. 后台进入 `/machines/:id` 的“库存异常复核”。
2. 查看 evidence.rawPayload、平台库存、机器上报、货道和关联订单。
3. 若机器上报可信，执行 `accept_machine_stock`。
4. 若机器上报不可信，执行 `reject_machine_stock`。
5. 若需要人工盘点数量，填写 correctedOnHandQty 并执行 `manual_correct`。
6. 复核完成后，按现场确认决定是否通过 `clearBlocker` 解除货道冻结。

## 机器恢复

### 机器离线

常见原因：

- Vending Daemon 停止运行。
- 工控机断电或网络中断。
- MQTT 连接失败，Machine Heartbeat 未按时上报。
- Payment Machine Preflight 或 sale readiness 有阻断项。

恢复步骤：

1. 后台进入 `/machines` 查看 Platform Machine 状态、lastSeenAt 和最新心跳。
2. 进入 `/machines/:id` 查看 Machine Heartbeat、MQTT、hardwareStatus、saleReadiness.blockingCodes 和 localQueueSize。
3. 现场进入 machine UI `#/maintenance`，确认 daemon health、ready、sync、scanner 和 lower-controller 状态。
4. 恢复电源、网络、daemon 或 MQTT 后，等待新 Machine Heartbeat。
5. 心跳恢复且 sale readiness 无阻断后，机器回到可售；若仍有 blocker，按对应 blocker 处理。

### 整机维护锁

常见原因：

- Lower Controller 或取货口严重故障。
- 多次出货失败或硬件健康 watcher 记录 Whole Machine Maintenance Lock。
- Production Dispense Path 不满足生产要求。

恢复步骤：

1. 现场进入 machine UI `#/maintenance`，查看 Whole Machine Maintenance Lock、blockingCodes 和 operatorAction。
2. 按维护页提示检查 Lower Controller、串口、scanner、取货口和真实硬件路径。
3. 确认 `hardwareAdapter` 使用真实控制器，且 `serialPortPath` 不是 TCP simulator。
4. 运行自检，并处理所有未完成异常订单、Stock Reconciliation Case 和冻结货道。
5. 下位机健康后，在维护页填写备注并执行 `POST /v1/maintenance/whole-machine-lock/clear`。
6. 若维护页提示 lower controller 仍 faulted，不允许清除整机锁，继续现场排障。

禁止动作：

- 不要通过重启机器绕过维护锁。
- 不要在真实硬件未恢复前强行可售。

## 推荐系统闭环

V1 保留 Implicit Recommendation，但它不是销售关键依赖。

要求：

1. 推荐失败不影响购买。
2. 推荐只影响默认规格选择。
3. 用户手动选择尺码或颜色后，推荐不得覆盖用户选择。
4. 不展示年龄、性别、身高、体型等推断结果。
5. 不保存原始图像和完整敏感推断。
6. 推荐系统异常时自动降级为手动选择。

## 上线前人工检查清单

- [ ] 生产后端 `NODE_ENV=production`。
- [ ] 生产 Payment Provider Configuration 已配置真实 `wechat_pay` 或 `alipay` 商户号、appId、证书/密钥状态，Payment Secret Status 全部通过。
- [ ] `PAYMENT_MOCK_ENABLED=false`，且 Payment Ops Readiness 未允许 mock provider 作为生产支付通道。
- [ ] Payment Notify URL 使用公网 HTTPS，`/payments/provider-configs/notify-url-checks` 显示路径匹配 webhook route、非 localhost、可达。
- [ ] 生产机器 Payment Machine Preflight 无 `NO_PAYMENT_OPTIONS`，真实支付方式可用。
- [ ] 生产机器使用真实 Lower Controller，sale readiness 不存在 `PRODUCTION_DISPENSE_PATH_MOCK`。
- [ ] 生产机器不使用 TCP simulator，下位机路径不触发 `PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR`。
- [ ] Scanner Runtime Status 正常，付款码能力不触发 `SCANNER_UNAVAILABLE`，Payment Code Scan View 可读码。
- [ ] 退款 backlog 已检查，`created` / `processing` 退款可通过 `POST /api/payments/refunds/:id/query` 查询。
- [ ] `/orders` 的 Order Investigation Drawer 对出货失败、Unknown Dispense Result、退款请求提供 `confirm_dispensed`、`confirm_not_dispensed`、`request_refund`、`compensation_dispense` 中的适用动作。
- [ ] `/machines/:id` 可查看并复核 Stock Reconciliation Case，必要时通过 `clearBlocker` 解除货道冻结。
- [ ] machine UI `#/maintenance` 可查看 readiness blockers，并可在真实硬件健康后调用 `POST /v1/maintenance/whole-machine-lock/clear`。
- [ ] 异常页展示顾客可抄录的 Customer Order Credential。
- [ ] 本文覆盖的 V1 恢复状态均可通过 UI/API 动作完成；文档审查不得新增绕过恢复动作的运维指令。
