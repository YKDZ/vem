# 售货机端能力回归与 Windows 服务验证计划

## 目标

本计划验证 `docs/archive/0530-售货机端架构变化.md` 驱动的架构迁移没有降低售货机侧既有能力，并确认新拆分后的 `vending-daemon` 可以在 Windows 平台作为系统服务注册、启动和恢复，同时 `apps/machine` 仍能作为触控售货机 UI 展示层运行。

## 覆盖矩阵

| 风险 | 自动化验证 | Windows/真机验证 |
| --- | --- | --- |
| 串口出货协议退化 | `cargo test -p vending-core --all-targets`，含 PTY 下位机模拟 | 真实下位机 COM 口出货 smoke |
| 扫码器支付码读取退化 | `cargo test -p vending-daemon --test scanner_vision -- --nocapture` | 真实扫码器 COM 口读取 |
| daemon 脱离 UI 后无法处理交易命令 | `cargo test -p vending-daemon --test mqtt_fault_recovery -- --nocapture` | Windows 服务运行时下发 MQTT 出货命令 |
| 本地状态、outbox、command log 不能恢复 | `cargo test -p vending-daemon --test mqtt_fault_recovery -- --nocapture` | 重启服务后检查补发和幂等记录 |
| IPC 契约或 UI 路由退化 | `cargo test -p vending-daemon --test ipc_contract`，`pnpm -F machine test:e2e -- machine-daemon-client.spec.ts machine-real-daemon.spec.ts` | 工控机启动 UI 并确认 kiosk 首屏可见 |
| 视觉 mock 协议退化 | `pnpm -F vision-mock test`，`cargo test -p vending-daemon --test scanner_vision -- --nocapture` | 真实视觉进程 ready/status smoke |
| Windows 服务包装不可编译 | GitHub Actions `Windows Service Compile`：`cargo check -p vending-daemon --target x86_64-pc-windows-msvc` | `scripts/windows/vending-daemon-smoke.ps1` 注册/启动/重启服务 |
| monorepo 统一命令漏测 Rust 新目录 | `pnpm turbo typecheck`、`pnpm turbo lint`、`pnpm turbo test` 现在覆盖 `vending-core` 与 `vending-daemon` | 不适用 |

## 本地提交前检查

```bash
pnpm fmt:check
pnpm turbo typecheck
pnpm turbo lint
pnpm turbo test
pnpm -F machine test:e2e -- machine-daemon-client.spec.ts machine-real-daemon.spec.ts
```

如果需要定位售货机侧回归，可以单独运行：

```bash
cargo test -p vending-core --all-targets
cargo test -p vending-daemon --test console_startup
cargo test -p vending-daemon --test ipc_contract
cargo test -p vending-daemon --test mqtt_fault_recovery -- --nocapture
cargo test -p vending-daemon --test scanner_vision -- --nocapture
pnpm -F machine test -- src/daemon/migration-guards.spec.ts
pnpm -F vision-mock test
```

## CI 必须通过

- `Static Checks`：统一格式、TypeScript 类型检查、Rust cargo check/clippy wrapper。
- `Unit Tests`：`pnpm turbo test`，覆盖前端/后端单测以及 Rust `vending-core`、`vending-daemon` 测试 wrapper。
- `Machine UI Daemon E2E`：启动 machine Vite UI，使用 mock daemon 和真实 `vending-daemon --console` 两组 Playwright 测试确认 UI 展示层仍可工作。
- `Rust Tests`：直接运行 `cargo fmt`、`cargo check`、`cargo test`，作为 Rust workspace 的独立保险。
- `Windows Service Compile`：在 `windows-latest` 上编译 `vending-daemon` Windows service wrapper。

## Windows/真机 smoke

在工控 Windows 10/11 主机上准备 daemon、machine UI 可执行文件和真实硬件后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/vending-daemon-smoke.ps1 `
  -DaemonExe "C:\VEM\vending-daemon.exe" `
  -MachineUiExe "C:\VEM\machine.exe" `
  -DataDir "C:\ProgramData\VEM\machine" `
  -ServiceName "VemVendingDaemon" `
  -ComPort "COM3" `
  -ScannerPort "COM4"
```

验收记录必须包含：

- Windows 版本、WebView2 版本、服务账号、数据目录 ACL。
- 服务 install/start/restart 后状态为 `Running`。
- `daemon-ready.json` 存在，`healthz` 返回可访问。
- 下位机和扫码器 COM 口存在。
- machine UI 进程启动后未退出，kiosk 首屏可见。
- 输出 `windows-hardware-acceptance.json` 并归档到验收证据目录。
