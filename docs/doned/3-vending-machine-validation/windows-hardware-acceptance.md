# Windows/真机验收记录

## 调试阶段边界

当前进入 Windows 工控机阶段的门槛是受控硬件 bring-up，不是完整生产验收。

本阶段必须覆盖：daemon 作为 Windows service 启动、machine UI kiosk 启动并连上 daemon、固定数据目录和 ready file、COM 下位机单件出货 smoke、扫码器串口状态和脱敏事件、mock 或隔离测试支付。

本阶段暂不把真实收款、完整支付 readiness、多件出货、断电恢复和生产发布包作为进入门槛；这些项目仍保留在真机业务 smoke 中逐项验收。

## 调试拓扑

Windows 工控机 bring-up 阶段不在工控机本机运行后端 API、PostgreSQL 或 MQTT broker。

工控机只运行：`vending-daemon` Windows service、machine UI kiosk、下位机串口、扫码器串口，以及本阶段需要的视觉进程或视觉 mock。

后端 API、PostgreSQL 和 MQTT broker 必须运行在固定的局域网调试服务器或开发机上，并在验收记录中填写：

- 后端 API Base URL：
- MQTT broker URL：
- MQTT 用户名：
- PostgreSQL 连接位置：
- 调试服务器 IP/主机名：
- 工控机到后端 API/MQTT 的防火墙放行记录：

machine-config.json 中 `apiBaseUrl` 和 `mqttUrl` 必须指向该调试服务器，不使用 `localhost`，除非后端确实运行在工控机本机。

## 硬件适配器范围

当前 Windows 工控机 bring-up 只承认 `mock` 和 `serial` 硬件适配器。

`bluetooth` 和 `vendor_sdk` 没有任何已确认规划，也没有 daemon 实现；它们不得出现在维护页可选项、预置配置或现场验收记录中。daemon 对旧配置或手写配置中的这两个值必须明确拒绝，避免服务下次启动失败后才暴露问题。

该限制不是测试专用逻辑，而是当前真实支持范围。未来如果要引入新的硬件适配方式，必须先有协议/驱动方案、daemon 实现和独立验收记录，再进入可配置项。

## 出货范围

首轮 Windows bring-up 严格限定单订单单件出货，出货命令 `quantity=1`。

本阶段不验证单订单多件、同货道多数量或跨货道多商品出货；这些场景依赖多商品 CRC-16 帧和下位机固件能力确认，应作为后续硬件协议联调项目。

该限制是验收边界，不应进入主代码逻辑链路；不得为 bring-up 新增测试专用的出货拦截或数量改写分支。

## 支付范围

首轮 Windows bring-up 只允许 mock 支付或隔离测试支付，不做真实扣款。

本阶段可以验证扫码器读取、付款码脱敏事件、UI 状态展示、SQLite/日志不落付款码明文，以及订单进入出货链路；不得把真实支付宝/微信收款、真实 webhook、真实退款或撤销作为进入 Windows 工控机调试的门槛。

真实支付应另行进入小额联调阶段，前置条件包括商户配置启用、公网 HTTPS webhook、支付 readiness 通过、查单/撤销/退款验收齐备。

该限制是验收边界，不应进入主代码逻辑链路；不得为 bring-up 新增测试专用支付 provider 分支或绕过生产 readiness 的代码路径。

## 视觉范围

首轮 Windows bring-up 不把真实视觉进程作为必需项。

本阶段可以设置 `visionEnabled=false`，或使用 `vision-mock` 验证 daemon 和 machine UI 对视觉 ready/status/profile/error 状态的消费。真实摄像头、真实模型、视觉进程自启动和推荐质量验收进入后续视觉联调阶段。

该限制是验收边界，不应进入主代码逻辑链路；不得为 bring-up 新增测试专用视觉分支、模型旁路或仅供验收使用的推荐逻辑。

## 首次配置方式

首轮 Windows bring-up 使用外部预置的 `machine-config.json`，并在配置写入后重启 `VemVendingDaemon` service。

预置配置至少包含：

- `machineCode`：
- `apiBaseUrl`：
- `mqttUrl`：
- `mqttUsername`：
- `hardwareAdapter=serial`（本阶段唯一真实硬件适配器；`mock` 仅用于无下位机场景）：
- `serialPortPath` 或 `lowerControllerUsbIdentity`：
- `scannerAdapter=serial_text` 或 `disabled`：
- `scannerSerialPortPath`：
- `visionEnabled` / `visionWsUrl` / `visionAutoStart`：
- `kioskMode`：

配置预置是现场 bring-up 操作，不应进入 daemon 或 machine UI 的主代码逻辑链路；不得为该阶段新增测试专用 runtime 分支、自动 mock 切换或仅供验收使用的配置旁路。

UI 维护页可以用于查看或修正配置，但保存后必须重启 service 才能确认硬件、扫码器和 MQTT runtime 已按新配置重新装配。

## 连接文件约定

Windows 默认数据目录为 `%ProgramData%\VEM\vending-daemon`，默认连接文件为 `%ProgramData%\VEM\vending-daemon\daemon-ready.json`。

`VEM_DAEMON_READY_FILE` 优先级最高；未设置时使用 `VEM_DAEMON_DATA_DIR\daemon-ready.json`；两者都未设置时，daemon service 和 machine UI 都应使用上述 Windows 默认连接文件。

smoke/install 脚本传入 `-DataDir` 时，必须同时让 daemon service 与 machine UI 使用同一个目录，不依赖 Windows service 进程和桌面 UI 进程共享环境变量。

## 环境

- 主机型号：
- Windows 版本：
- WebView2 Runtime 版本：
- daemon 版本 / commit：
- machine-ui 版本 / commit：
- 服务账号：
- 安装路径：
- 数据目录：
- 下位机 COM 口：
- 扫码器 COM 口：
- USB 转串口驱动版本：
- 测试 broker/TLS 证书：
- 视觉硬件/模型版本（如本阶段禁用或使用 vision-mock，记录原因）：

## SSH bring-up 入口

首轮 Windows 工控机调试使用 SSH 上传 bring-up bundle 并执行 PowerShell runbook；正式 installer 不作为进入硬件 bring-up 的前置门槛。

installer 的职责是封装已经跑通的安装/升级流程，进入批量部署或交付准备阶段后再做；本阶段需要保留 service 注册、配置预置、ready file、COM 口、日志和 smoke 输出的可观察性。

GitHub Actions 的 `Windows Bring-up Bundle` workflow 用于手动生成 `vem-bringup-bundle-*` artifact，供 SSH 上传到工控机。

目标工控机前置条件：

- 已启用 OpenSSH Server，并允许调试账号通过 SSH 登录。
- 调试账号可启动 elevated PowerShell，或现场提供管理员窗口执行 runbook。
- 已安装 WebView2 Runtime、USB 转串口驱动，以及下位机/扫码器硬件。
- 工控机能访问固定局域网调试服务器上的后端 API 和 MQTT broker。

bring-up bundle 至少包含：

- `vending-daemon.exe`
- `machine.exe`
- `machine-config.bringup.example.json`，现场填写后复制为 `machine-config.json`
- `scripts/windows/vending-daemon-smoke.ps1`
- `VERSION.txt` 或等价文件，记录 commit、构建时间、构建机和 artifact hash

bring-up bundle 不得包含真实 `machineSecret`、`mqttSigningSecret` 或 `mqttPassword`。真实凭证必须通过受控现场流程写入维护页或 Windows secret store，不能进入 GitHub Actions artifact。

推荐目标目录：

```powershell
C:\VEM\bringup
C:\ProgramData\VEM\vending-daemon
```

远程执行示例：

```powershell
powershell -ExecutionPolicy Bypass -File C:\VEM\bringup\scripts\windows\vending-daemon-smoke.ps1 `
  -DaemonExe C:\VEM\bringup\vending-daemon.exe `
  -MachineUiExe C:\VEM\bringup\machine.exe `
  -DataDir C:\ProgramData\VEM\vending-daemon `
  -MachineConfig C:\VEM\bringup\machine-config.json `
  -ComPort COM3 `
  -ScannerPort COM4
```

SSH 只能验证 service、文件、网络、日志、HTTP IPC 和进程层行为；UI kiosk 的触屏、全屏、置顶、WebView2 渲染和开机自动登录后启动，必须通过物理屏幕、RDP 或现场观察补充确认。

## 自动 smoke

运行命令：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/vending-daemon-smoke.ps1 ... -MachineConfig C:\VEM\bringup\machine-config.json
```

通过条件：

- `windows-hardware-acceptance.json` 存在。
- 所有 `checks[].passed` 均为 `true`。
- SCM 中 `VemVendingDaemon` 状态为 `Running`。
- `daemon-ready.json` 存在且 `healthzUrl` 返回 `{"status":"ok"}`。

## 真机业务 smoke

| 项目                       | 操作                          | 通过标准                                               | 结果 |
| -------------------------- | ----------------------------- | ------------------------------------------------------ | ---- |
| Service install/start/stop | SCM 启停服务                  | 启停均成功，日志路径在数据目录                         |      |
| Service failure recovery   | kill daemon 进程              | SCM 在 5 秒内拉起服务                                  |      |
| UI kiosk                   | 普通用户启动 UI               | 全屏、置顶、无边框、触控可操作                         |      |
| Session 通信               | UI 连接 daemon IPC            | UI 能显示 daemon health/ready                          |      |
| COM 下位机                 | 测试 broker 下发单件出货命令  | 下位机完成一次 `quantity=1` 出货，result 上报          |      |
| 重复 command               | 重发同一 commandNo            | 不重复出货，result 可重发                              |      |
| 扫码器                     | 扫入测试付款码                | UI 显示 masked code，SQLite/日志无明文，不触发真实扣款 |      |
| 断电恢复                   | 断电后重启                    | daemon 自启、UI 重连、outbox 补发                      |      |
| 权限                       | 服务账号访问数据目录/证书/COM | 无 access denied                                       |      |
| TLS/broker                 | 测试 broker TLS 连接          | 认证成功；错误证书时状态可诊断                         |      |
