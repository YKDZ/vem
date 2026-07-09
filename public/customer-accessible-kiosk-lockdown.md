# 顾客可接触自助机锁定

本运行手册记录顾客可接触 VEM 售货机的 Windows 启动配置要求。它有意采用现场检查清单形式，因为 CI 无法证明真实触摸屏边缘手势行为。

## 账号

- 自助机账号：`VEMKiosk`，受限本地用户，只用于面向顾客的机器运行界面。
- 维护账号：`Admin` 或另一个具名维护用户，保留本地管理员权限，用于主机级恢复、部署和显式调试启动。
- 自助机锁定验收通过后，不要把维护账号作为正常顾客侧启动账号。

使用管理员 PowerShell 创建或修复账号：

```powershell
$env:VEM_KIOSK_PASSWORD = "<unique kiosk password>"
$env:VEM_MAINTENANCE_PASSWORD = "<maintenance password if rotating or creating>"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\setup-scheduled-tasks.ps1 `
  -ConfigureKioskAccounts
```

不带自助机开关运行 `setup-scheduled-tasks.ps1` 时，仍与现有基于 Admin 的生产安装保持兼容。它不会静默地把顾客侧启动任务绑定到 `VEMKiosk`。

## Controlled Maintenance Ingress 受控维护入口

生产自助机锁定不得让主机变得不可访问。维护通道的稳定概念是 transport-neutral Controlled Maintenance Ingress：只允许显式授权来源通过 SSH 登录维护账号，底层传输可以是维护 relay、专用隧道或现场临时网络。该通道仅用于主机级恢复、证据收集，以及托管更新不可用时的紧急部署；不要把它作为正常发布路径。

只有在维护账号凭据已知且可恢复，并且维护来源地址已明确后，才配置该通道。`-MaintenanceIngressSourceAllowlist` 没有默认值，必须传入显式 host 来源 allowlist；IPv4 可使用单个 host 地址或 `/32`，IPv6 可使用单个 host 地址或 `/128`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\setup-scheduled-tasks.ps1 `
  -ConfigureControlledMaintenanceIngress `
  -MaintenanceIngressSourceAllowlist "10.77.20.2/32"
```

该脚本会：

- 启用 Windows OpenSSH Server `sshd`，并设置为自动启动；
- 拒绝空 allowlist、`Any`、`0.0.0.0/0`、`::/0`、`100.64.0.0/10`、`10.0.0.0/8`、`192.168.0.0/16` 等过宽 SSH 暴露；
- 禁用范围过宽的默认 OpenSSH 入站防火墙规则，并创建由 VEM 管理的 `VEM Controlled Maintenance SSH` 规则，允许来自显式来源 allowlist 的 TCP `22`；
- 将维护账号加入 `OpenSSH Users`；
- 将自助机账号从 `OpenSSH Users` 和 `Remote Desktop Users` 中移除；
- 向 `C:\ProgramData\ssh\sshd_config` 写入由系统管理的小写 `DenyUsers <kioskuser>` 块。

自助机账号不得用于远程维护。即使顾客侧 shell 已锁定，顾客访问和维护访问也必须保持分离。

## 顾客侧启动路径

在启用操作系统级 shell 锁定前，显式自助机账号启动路径为：

- `VEMKiosk` 登录。
- Windows 为该用户启动 `VEMMachineUI`。
- `C:\VEM\bringup\launch-machine-ui.vbs` 启动 `machine.exe`。
- 不启用 WebView CDP；正常启动器不得设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`。

仅在有意测试自助机账号时配置该任务模式：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\setup-scheduled-tasks.ps1 `
  -UseKioskAccount
```

显式维护和调试路径保持独立：

- `VEMMaintenanceUI` 在维护账号下运行。
- `C:\VEM\bringup\launch-machine-ui-debug.vbs` 在端口 `9222` 启用 WebView CDP。
- 操作员只有在退出或绕过顾客自助机会话后，才启动该路径。

调试 UI 任务默认禁用。只在活动维护会话中注册自动启动任务，之后不带该开关重新运行设置脚本，以再次移除该任务：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\setup-scheduled-tasks.ps1 `
  -EnableMaintenanceDebugTask
```

## 操作系统级锁定

确认维护账号可以登录并恢复主机后，启用操作系统级自助机 shell 锁定：

```powershell
$env:VEM_AUTOLOGON_PASSWORD = "<kiosk password>"
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\setup-scheduled-tasks.ps1 `
  -ConfigureKioskShell `
  -ConfigureAutoLogon
```

脚本优先为自助机账号使用 Windows Shell Launcher；当 Shell Launcher 不可用时，回退到按用户配置的 Winlogon shell。Shell Launcher 路径会直接启动 `machine.exe`，因此 Windows 监控的是真实机器运行界面进程，而不是短生命周期包装脚本。在 Shell Launcher 模式下，脚本会移除 `VEMMachineUI`，避免顾客会话通过登录任务启动第二个机器运行界面。这是操作系统级自助机和 shell 配置，不只是全屏应用窗口。

本切片有意不写入 `DisableCMD` 或 `NoWinKeys` 等全局 HKLM 限制策略。必须保持维护账号可用于恢复。

启用 shell 锁定前，保留可用的维护账号凭据和物理键盘访问路径。不要把主机锁到只有顾客自助机账号可访问的状态。

## 验证清单

冷启动进入自助机账号并确认物理触摸屏行为后，运行验证器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File C:\VEM\repo\scripts\windows\verify-kiosk-lockdown.ps1 `
  -TouchEdgeGesturesBlocked `
  -CloseMinimizeControlsUnavailable `
  -DesktopShellUnavailable `
  -DebugRoutesUnavailable `
  -MaintenanceRecoveryConfirmed `
  -MaintenanceIngressSourceAllowlist "10.77.20.2/32" `
  -MaintenanceIngressConfirmed `
  -NegativeKioskSshEvidence "ssh VEMKiosk@<machine-maintenance-ingress-ip> rejected with DenyUsers/auth failure at <time>"
```

验证器会写入 `C:\ProgramData\VEM\kiosk-lockdown-evidence.json`，并在以下情况失败：

- 自助机账号缺失，或是本地管理员；
- 维护账号缺失，或缺少管理员恢复权限；
- OpenSSH Server `sshd` 缺失、停止、不是自动启动，或本地端口 `22` 不可访问；
- `VEM Controlled Maintenance SSH` 防火墙规则缺失、未匹配显式来源 allowlist、未指向 TCP `22`，或任何范围过宽的默认 OpenSSH 入站规则仍处于启用状态；
- 维护账号不在 `OpenSSH Users` 中；
- 自助机账号在 `OpenSSH Users` 中；
- 自助机账号在 `Remote Desktop Users` 中；
- `sshd_config` 未显式拒绝小写自助机账号；
- 正常启动器启用了 WebView CDP；
- 显式调试启动器缺失；
- Shell Launcher 或按用户配置的自助机 shell 未配置为预期的 `machine.exe` shell；
- Shell Launcher 已接管顾客 UI 进程时，`VEMMachineUI` 仍指向自助机账号；
- 默认验证路径中注册了 `VEMMaintenanceUI`，或在提供 `-MaintenanceDebugTaskExpected` 时，它未指向维护账号；
- 正常自助机启动状态下端口 `9222` 可访问；
- 缺少 `-NegativeKioskSshEvidence`；
- 任一人工触摸屏或远程维护确认开关被省略。

将证据 JSON 与该机器的生产验收记录一起保存。人工确认必须包括尝试通过触摸边缘手势、Windows shell 入口、关闭或最小化控件，以及任何顾客可访问调试路由进入桌面。未完成物理触摸屏检查时，仅通过该脚本不足以作为生产验收。

对于 `-MaintenanceIngressConfirmed`，从一台位于显式 allowlist 内的维护来源确认：

```powershell
ssh <MaintenanceUser>@<machine-maintenance-ingress-ip> hostname
ssh <MaintenanceUser>@<machine-maintenance-ingress-ip> powershell -NoProfile -Command "whoami; Get-Service sshd | Select-Object Name,Status,StartType"
ssh VEMKiosk@<machine-maintenance-ingress-ip> hostname
```

成功的 SSH 登录必须使用维护账号。自助机账号 SSH 尝试必须失败，且该失败结果必须通过 `-NegativeKioskSshEvidence` 记录；不要把自助机账号 SSH 登录成功作为证据接受。
