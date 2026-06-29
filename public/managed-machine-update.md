# 托管机器更新运行手册

托管机器更新是首台试点机器替换 Windows 机器 daemon 和顾客侧机器 UI 的常规路径。受控 SSH 仅用于紧急访问：可用于复制产物、收集证据或恢复故障主机，不得作为常规安装机制。

## 范围

- daemon 产物：`C:\VEM\bringup\vending-daemon.exe`
- 机器 UI 产物：`C:\VEM\bringup\machine.exe`
- daemon 服务：`VemVendingDaemon`
- 机器 UI 任务：`VEMMachineUI`
- 证据 JSON：由 `scripts/windows/apply-managed-update.ps1` 写入

两个组件独立更新。UI 更新只停止 `VEMMachineUI` 和 `machine.exe`，不得停止 daemon 服务。daemon 更新只重启 `VemVendingDaemon`，不得结束机器 UI。

更新器会把每个组件绑定到生产目标路径。`daemon` 只能替换 `C:\VEM\bringup\vending-daemon.exe`；`ui` 只能替换 `C:\VEM\bringup\machine.exe`。清单或直接调用如果提供了不同的 `targetPath`，会在替换前失败。省略 `targetPath` 时，使用所选组件允许的默认路径。

## 清单

将产物放到 Windows 主机上，计算 SHA256 值，并写入本地清单：

```json
{
  "updateId": "2026-06-27-local",
  "components": [
    {
      "component": "daemon",
      "artifactPath": "C:\\VEM\\updates\\vending-daemon.exe",
      "sha256": "replace-with-64-hex-sha256",
      "targetPath": "C:\\VEM\\bringup\\vending-daemon.exe"
    },
    {
      "component": "ui",
      "artifactPath": "C:\\VEM\\updates\\machine.exe",
      "sha256": "replace-with-64-hex-sha256",
      "targetPath": "C:\\VEM\\bringup\\machine.exe"
    }
  ]
}
```

`updateId` 为必填，并会复制到证据 JSON。`components` 至少必须包含一个组件；空数组会被拒绝。

在 Windows 主机上使用管理员 PowerShell 运行：

```powershell
.\scripts\windows\apply-managed-update.ps1 `
  -ManifestPath C:\VEM\updates\managed-update.json `
  -EvidencePath C:\VEM\updates\evidence-managed-update.json
```

不使用清单更新单个组件时：

```powershell
.\scripts\windows\apply-managed-update.ps1 `
  -Component ui `
  -ArtifactPath C:\VEM\updates\machine.exe `
  -Sha256 replace-with-64-hex-sha256 `
  -EvidencePath C:\VEM\updates\evidence-ui-update.json
```

如果直接输入时提供 `-TargetPath`，它必须匹配该组件的固定目标路径。

## UI 启动模式

默认的 `-UiLaunchMode auto` 支持两种顾客侧启动模式：

- 如果存在 `VEMMachineUI` 计划任务，更新器会停止并启动该任务。
- 如果计划任务不存在，更新器会将主机视为 Shell Launcher 或直接进程安装模式，并直接启动 `C:\VEM\bringup\machine.exe`。

只有在计划任务必须存在时才使用 `-UiLaunchMode scheduledTask`。在明确的 Shell Launcher 或直接进程维护窗口中使用 `-UiLaunchMode directProcess`。证据会记录解析后的 `launchMode`。

## 验收证据

将证据 JSON 与发布记录一起保存。它会记录：

- 请求的组件、产物路径、目标路径和预期 sha256
- 清单 `updateId`
- 旧可执行文件的备份路径
- 已安装哈希
- 更新后健康检查结果
- 适用时的 rollbackAttempted、rollbackOk 和回滚健康详情

daemon 健康通过 daemon ready 文件检查。`healthzUrl` 和 `readyzUrl` 都必须携带 ready 文件令牌并返回 HTTP 成功。证据会记录 `healthzOk`、`readyzOk`、daemon `status`、ready `mode`、ready `status` 和 `blockingCodes`。更新验收不要要求 `canSell=true`，因为真实机器可能正处于维护窗口或硬件未接入状态。

机器 UI 健康检查会确认已部署目标哈希仍匹配请求的 SHA256，并且存在从 `C:\VEM\bringup\machine.exe` 精确路径运行的 `machine.exe` 进程。`Path` 为空或不同的机器进程不视为健康。

## 回滚

脚本会在替换前备份当前可执行文件。若替换、重启或健康检查失败，它会恢复备份，只重启受影响组件，并记录回滚证据。

UI 回滚使用与正常 UI 重启相同的启动模式解析。任务存在时可通过 `VEMMachineUI` 恢复；主机基于 Shell Launcher 或直接进程时，可通过直接启动 `machine.exe` 恢复。

如果回滚证据显示 `rollbackOk=false`，使用紧急受控 SSH 或现场维护访问检查主机。在机器为 daemon 和 UI 生成干净证据 JSON 之前，不要继续常规更新。

## Linux 静态检查

将产物交给现场运维前运行：

```bash
node scripts/check-managed-machine-update.mjs
```

该检查会验证脚本契约，包括固定组件目标路径、拒绝空组件、daemon `healthz` 和 `readyz` 证据、UI 目标哈希校验、任务或直接启动回退，以及组件隔离的停止和重启行为。它不能证明 Windows 主机可以重启服务或任务。Windows 实际运行及其证据 JSON 仍是生产验收记录。
