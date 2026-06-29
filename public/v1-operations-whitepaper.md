# VEM V1 运维白皮书

本文面向 V1 试点现场与后台运营人员，说明常见异常状态的含义、真实操作入口和恢复动作。V1 的目标是让机器在异常时进入可解释、可恢复、可追踪的状态；覆盖本文的恢复状态时，操作员必须使用已发布的 UI 或 API 动作完成恢复，并留下备注与审计记录。

## V1 运维原则

1. 先确认资金，再处理出货。支付结果以支付平台异步通知、支付事件或支付结果对账为准，不以顾客手机页面或机器前台状态为准。
2. 未确认物理出货结果时，不自动重试出货。出货结果未知统一进入人工确认和补偿路径。
3. 同一个售货命令不得重复执行；需要补偿出货时使用新的 `compensation_dispense` 恢复动作。
4. 任何异常恢复动作都应在管理运维控制台或机器运行控制台完成，并记录操作人、原因和备注。
5. 生产机器必须使用生产出货路径，不允许 mock 下位机或 TCP 模拟器进入可售状态。
6. V1 订单为单商品机器订单，不支持购物车或同一订单多件出货。

## 真实操作入口

| 入口           | 路由或动作              | 用途                                                                                   |
| -------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| 管理运维控制台 | `/orders`               | 订单列表；打开订单调查抽屉查看支付、退款、出货命令、库存流水和恢复动作。               |
| 管理运维控制台 | `/payments`             | 支付管理；查看支付运维就绪、支付通道配置、支付事件轨迹、退款和付款码尝试。             |
| 管理运维控制台 | `/machines`             | 机器列表；查看平台机器在线状态和最后心跳。                                             |
| 管理运维控制台 | `/machines/:id`         | 机器运维视图；查看机器心跳、货道销售状态、库存异常复核案例、整机维护锁和远程运维操作。 |
| 机器运行控制台 | 机器 UI `#/maintenance` | 现场维护页；查看 daemon 就绪、销售关键阻断项、扫码器状态、自检结果，并清除整机维护锁。 |

实现动作映射：

- 订单恢复：`POST /api/orders/:id/recovery-actions`，action 为 `confirm_dispensed`、`confirm_not_dispensed`、`request_refund` 或 `compensation_dispense`。
- 支付对账：`POST /api/payments/:id/reconcile`。
- 退款查询：`POST /api/payments/refunds/:id/query`。
- 付款码查询：`POST /api/payments/payment-code-attempts/:id/query`。
- 付款码撤销：`POST /api/payments/payment-code-attempts/:id/reverse`。
- 库存异常复核：管理后台 `/machines/:id` 的库存异常复核动作，action 为 `accept_machine_stock`、`reject_machine_stock` 或 `manual_correct`，可通过 `clearBlocker` 清除对应货道冻结。
- 整机维护锁清除：机器 UI `#/maintenance` 调用 `POST /v1/maintenance/whole-machine-lock/clear`。

## 状态速查

| 状态             | VEM 域概念                                                                | 首要动作                                                           |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 支付等待中       | 支付状态 `awaiting_payment`                                               | 等待支付平台通知或执行支付结果对账。                               |
| 支付确认中       | 支付结果对账未完成                                                        | 在 `/payments` 查询支付对账，不引导顾客重复付款。                  |
| 付款码尝试不确定 | 付款码尝试 `unknown` / `user_confirming` / `querying` / `manual_handling` | 在 `/payments` 查询或撤销该尝试。                                  |
| 退款处理中       | 退款决策已发起，退款状态 `processing` / `created`                         | 在 `/payments` 查询退款结果，不重复发起退款。                      |
| 已支付未出货     | 支付状态 `paid`，履约状态未完成                                           | 在 `/orders` 打开订单调查抽屉，使用恢复动作触发退款或补偿出货。    |
| 出货失败         | 履约状态 `dispense_failed`                                                | 现场确认后申请退款或补偿出货；必要时保持货道冻结。                 |
| 出货结果未知     | 出货结果未知                                                              | 人工确认 `confirm_dispensed` 或 `confirm_not_dispensed` 后再补偿。 |
| 货道冻结         | 货道销售状态 `frozen` 或销售安全阻断项                                    | 在 `/machines/:id` 复核库存或维护后解除。                          |
| 库存异常         | 库存异常复核案例                                                          | 在 `/machines/:id` 接受、拒绝或修正库存上报。                      |
| 整机维护锁       | 整机维护锁                                                                | 在机器 UI `#/maintenance` 排障并清除。                             |
| 机器离线         | 机器心跳超时或销售就绪被阻断                                              | 在 `/machines` / `/machines/:id` 查看最后心跳、MQTT 和阻断项。     |

## 支付异常恢复

### 二维码到期但顾客可能已付款

常见原因：

- 支付宝或微信异步通知延迟或丢失。
- 机器运行控制台未及时刷新交易快照。
- 支付平台查询短时不稳定，支付结果对账尚未完成。

恢复步骤：

1. 机器屏幕保持支付确认或结果页，展示顾客订单凭证。
2. 后台进入 `/payments`，按 paymentNo、orderNo 或 providerCode 查找支付记录。
3. 对不确定支付执行 `POST /api/payments/:id/reconcile`。
4. 若查询为支付成功，平台记录支付事件，订单投影转为已支付并继续履约状态。
5. 若查询为未支付或可关闭，平台关闭订单或释放库存预留。
6. 若查询仍不确定，订单保持人工处理或待对账；不要让顾客对同一机器订单重复付款。

禁止动作：

- 不要仅凭顾客截图标记支付成功。
- 不要绕过支付结果对账直接推进出货。

### 付款码扫码失败或结果不确定

常见原因：

- 扫码器运行状态离线，或串口配置不符合现场。
- 支付平台返回 `USER_PAYING`、系统异常、查询超时。
- 顾客付款码过期、重复读取，或同一订单已有活动付款码尝试。

恢复步骤：

1. 机器的付款码扫码视图提示重新出示付款码或等待确认，不清空当前订单。
2. 后台进入 `/payments` 的“付款码尝试”，查看脱敏授权码、attemptNo、providerStatus 和 failureCode。
3. 对 `unknown`、`user_confirming`、`querying` 或 `manual_handling` 状态执行 `POST /api/payments/payment-code-attempts/:id/query`。
4. 若查询成功，平台推进支付状态并触发后续出货。
5. 若确认未支付且需要释放该尝试，填写原因并执行 `POST /api/payments/payment-code-attempts/:id/reverse`。
6. 撤销成功或尝试进入失败终态后，机器才允许顾客重新提交付款码。

禁止动作：

- 不要在付款码尝试结果未知时创建新订单。
- 不要保存完整付款码；后台只展示脱敏值。

### 退款请求超时或返回 5xx

常见原因：

- 支付平台已受理退款，但 HTTP 响应丢失。
- 网关超时或沙箱环境不稳定。
- 退款决策已创建，但 providerRefundStatus 尚未回写。

恢复步骤：

1. 后台进入 `/payments` 的“退款管理”，筛选 `created` 或 `processing` 退款。
2. 查看 refundNo、paymentNo、orderNo 和 latestReconciliationStatus。
3. 对处理中退款执行 `POST /api/payments/refunds/:id/query`。
4. 查询成功后，平台更新退款、支付状态和订单状态投影。
5. 查询失败或仍不确定时，保留退款处理中或人工处理状态，并在支付事件轨迹中保留错误原因。

禁止动作：

- 不要把超时类错误立即标记为退款失败。
- 不要在结果未知时再次发起同金额退款。

## 出货异常恢复

### 出货失败

常见原因：

- 下位机返回机械故障、卡货、取货口异常。
- 硬件错误策略要求冻结货道、发起退款或创建维护工单。
- daemon 在命令日志中记录售货命令失败。

恢复步骤：

1. 机器结果页展示出货失败和顾客订单凭证。
2. 后台进入 `/orders`，打开订单调查抽屉查看 latestCommand、错误码、库存流水和可用恢复动作。
3. 现场确认商品是否已经物理出货。
4. 若确认未出，填写备注并执行 `request_refund` 或 `compensation_dispense`。
5. 若确认已出但平台未完成订单，执行 `confirm_dispensed`。
6. 若货道存在机械风险，在 `/machines/:id` 保持货道销售状态不可售，并创建或更新维护工单。

禁止动作：

- 不要重放原 `commandNo`。
- 不要在未确认现场结果前补偿出货。

### 出货结果未知

常见原因：

- 平台发出售货命令后没有收到最终 `dispense-result`。
- daemon 或工控机在出货过程中重启。
- 网络或 MQTT 中断导致结果丢失。

恢复步骤：

1. 后台在 `/orders` 打开订单调查抽屉，确认 fulfillmentProjection.requiresPhysicalOutcomeConfirmation。
2. 现场检查取货口、货道和机器本地库存账本。
3. 若确认已出货，填写备注并执行 `confirm_dispensed`。
4. 若确认未出货，先执行 `confirm_not_dispensed`。
5. 确认未出后，根据顾客处理方案执行 `request_refund` 或 `compensation_dispense`。
6. 关联货道在确认前保持不可售，避免同一货道销售状态继续销售。

禁止动作：

- 不要自动重试出货。
- 不要对同一 `commandNo` 重发命令。

### 已支付但未触发出货

常见原因：

- 支付 webhook 到达失败，但支付结果对账查到已支付。
- 机器运行控制台轮询交易快照失败。
- MQTT 售货命令发布失败或机器离线。

恢复步骤：

1. 在 `/payments` 对支付执行 `POST /api/payments/:id/reconcile`。
2. 在 `/orders` 查看订单的支付状态、履约状态和 availableRecoveryActions。
3. 若支付成功但无可信出货结果，使用 `request_refund` 或 `compensation_dispense`，不要创建第二个同款订单代替恢复动作。
4. 若机器离线导致无法补偿出货，先按机器离线流程恢复，再执行补偿动作或退款。

## 库存与货道恢复

### 货道冻结

常见原因：

- 出货失败或出货结果未知后，daemon 将货道销售状态置为 `frozen`。
- 库存异常复核案例创建销售安全阻断项。
- 维护人员发现实际库存、货道或摆放异常。

恢复步骤：

1. 现场检查货道是否卡货、空货或摆放错误。
2. 后台进入 `/machines/:id`，查看货道与库存、冻结原因、linkedOrderNo 和 linkedCommandNo。
3. 若冻结来自库存异常复核案例，打开“库存异常复核”。
4. 根据现场结果选择 `accept_machine_stock`、`reject_machine_stock` 或 `manual_correct`，填写复核备注。
5. 只有库存和机械状态均确认可售时，勾选 `clearBlocker` 清除当前冻结。
6. 若机械异常未解决，保持冻结并处理维护工单。

禁止动作：

- 不要在未确认实际库存时恢复销售。
- 不要跳过库存异常复核案例直接恢复货道销售状态。

### 库存异常复核

常见原因：

- 机器库存流水摄取发现平台库存与机器本地库存账本不一致。
- 出货、补货或库存盘点修正上传失败或归因不强。
- 货道规划变更后仍有库存需要现场盘点。

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

- 售货 daemon 停止运行。
- 工控机断电或网络中断。
- MQTT 连接失败，机器心跳未按时上报。
- 支付机器预检或销售就绪有阻断项。

恢复步骤：

1. 后台进入 `/machines` 查看平台机器状态、lastSeenAt 和最新心跳。
2. 进入 `/machines/:id` 查看机器心跳、MQTT、hardwareStatus、saleReadiness.blockingCodes 和 localQueueSize。
3. 现场进入机器 UI `#/maintenance`，确认 daemon health、ready、sync、scanner 和 lower-controller 状态。
4. 恢复电源、网络、daemon 或 MQTT 后，等待新机器心跳。
5. 心跳恢复且销售就绪无阻断后，机器回到可售；若仍有阻断项，按对应阻断项处理。

### 整机维护锁

常见原因：

- 下位机或取货口严重故障。
- 多次出货失败或硬件健康监视器记录整机维护锁。
- 生产出货路径不满足生产要求。

恢复步骤：

1. 现场进入机器 UI `#/maintenance`，查看整机维护锁、blockingCodes 和 operatorAction。
2. 按维护页提示检查下位机、串口、扫码器、取货口和真实硬件路径。
3. 确认 `hardwareAdapter` 使用真实控制器，且 `serialPortPath` 不是 TCP simulator。
4. 运行自检，并处理所有未完成异常订单、库存异常复核案例和冻结货道。
5. 下位机健康后，在维护页填写备注并执行 `POST /v1/maintenance/whole-machine-lock/clear`。
6. 若维护页提示下位机仍为 faulted，不允许清除整机锁，继续现场排障。

禁止动作：

- 不要通过重启机器绕过维护锁。
- 不要在真实硬件未恢复前强行可售。

## 推荐系统闭环

V1 保留隐式推荐，但它不是销售关键依赖。

要求：

1. 推荐失败不影响购买。
2. 推荐只影响默认规格选择。
3. 用户手动选择尺码或颜色后，推荐不得覆盖用户选择。
4. 不展示年龄、性别、身高、体型等推断结果。
5. 不保存原始图像和完整敏感推断。
6. 推荐系统异常时自动降级为手动选择。

## 上线前人工检查清单

- [ ] 生产后端 `NODE_ENV=production`。
- [ ] 生产支付通道配置已配置真实 `wechat_pay` 或 `alipay` 商户号、appId、证书/密钥状态，支付密钥状态全部通过。
- [ ] `PAYMENT_MOCK_ENABLED=false`，且支付运维就绪未允许 mock provider 作为生产支付通道。
- [ ] 支付通知地址使用公网 HTTPS，`/payments/provider-configs/notify-url-checks` 显示路径匹配 webhook route、非 localhost、可达。
- [ ] 生产机器支付预检无 `NO_PAYMENT_OPTIONS`，真实支付方式可用。
- [ ] 生产机器使用真实下位机，销售就绪不存在 `PRODUCTION_DISPENSE_PATH_MOCK`。
- [ ] 生产机器不使用 TCP 模拟器，下位机路径不触发 `PRODUCTION_DISPENSE_PATH_TCP_SIMULATOR`。
- [ ] 扫码器运行状态正常，付款码能力不触发 `SCANNER_UNAVAILABLE`，付款码扫码视图可读码。
- [ ] 退款积压已检查，`created` / `processing` 退款可通过 `POST /api/payments/refunds/:id/query` 查询。
- [ ] `/orders` 的订单调查抽屉对出货失败、出货结果未知、退款请求提供 `confirm_dispensed`、`confirm_not_dispensed`、`request_refund`、`compensation_dispense` 中的适用动作。
- [ ] `/machines/:id` 可查看并复核库存异常复核案例，必要时通过 `clearBlocker` 解除货道冻结。
- [ ] 机器 UI `#/maintenance` 可查看就绪阻断项，并可在真实硬件健康后调用 `POST /v1/maintenance/whole-machine-lock/clear`。
- [ ] 异常页展示顾客可抄录的顾客订单凭证。
- [ ] 本文覆盖的 V1 恢复状态均可通过 UI/API 动作完成；文档审查不得新增绕过恢复动作的运维指令。
