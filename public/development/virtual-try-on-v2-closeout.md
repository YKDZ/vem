# 虚拟试衣 V2 收尾记录

状态：已交付。虚拟试衣 V2 的 Fast/AI 双模式、采集倒计时、锁定中心缩放、观察者
自愈、竖屏回归与老业务回归均已通过 VM 验收。

## 最终验收证据

- VEM：main `4a12ced3`（含试衣入口文案中文化与两个 testbed 驱动修复）。
- vending-vision：main `c01ec94`（恢复 3 秒稳定倒计时并保持失稳重置语义）。
- 最终 full：`RUN-1787043113707-4A12CED35EF9-FULL` 两轮重建全部
  `passed`，包含 commissioning、startup、sale、scannerPayment、
  visionExperience、aiVirtualTryOn、pickupProtocol、presenceAndAudio、
  ipcRecovery、fulfillmentRecovery、paymentRecovery、stockMaintenance、
  hardwareLifecycle、localOperations、environmentControl。
- 产物：`acceptance-release-manifest.json` 与
  `full-workflow-stability-gate.json` 已生成。

## 交付行为

- 单人且对齐后进入 3 秒倒计时，任一未对齐帧清零重来；手动采集绕过稳定性但
  仍受人数保护。
- Fast 结果支持 80%–160%、5% 步进的锁定中心缩放，不重新识别。
- 采集观察者与 Fast 渲染 broker 子进程死亡后可自愈；结果页、取消、降级购买
  和试衣后普通下单均保留。
- 商品详情页 Fast 入口文案为“快速虚拟试衣”；倒计时期间同时展示视频预览。

## 过程中沉淀的 testbed 教训

这些教训是后续 testbed 重构的直接输入，而不是业务缺陷：

1. 固定超时（30 秒 CDP、500 毫秒子进程、2 秒音频等）在串行 full 后期逐
   个变脆，后来靠“轨间运行时屏障”缓解，但根因是观测点没有下沉到权威状态。
2. 失败在宿主侧经常只显示 `ssh exited with 1` 和 ANSI 截断字符串，真正的
   结构化报告留在 VM 上，需要手动拉取才能定位。
3. WebView 零时长 touchStart/touchEnd 会被合并丢弃，点击恢复为带 40 毫秒
   按下的真实 tap 输入；UI 断言应以进入路由/DOM 条件为准，而不是点击后
   重试。
4. 按进程创建时间猜测 observer/broker 身份会因进程快速重生误报，回归应以
   产品拥有的、可声明的边界为主。
5. PowerShell 字符串拼接曾引入注释吞语句与 UTF-8 BOM 两类各耗一整轮 VM
   的陷阱，本地静态扫描只是事后补丁。
6. 截图需要等待 `<img>` 首帧解码完成再拍，固定 sleep 会拍到空白预览。

## 遗留项

- pickupProtocol 的默认音频释放偶发时序曾出现一次，后续多轮通过，未放宽
  验收边界。
- 官方 AI 验收的签名/权威输入流水线按用户授权暂缓，不影响功能验收。
