# Windows/真机验收记录

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
- 视觉硬件/模型版本：

## 自动 smoke

运行命令：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows/vending-daemon-smoke.ps1 ...
```

通过条件：

- `windows-hardware-acceptance.json` 存在。
- 所有 `checks[].passed` 均为 `true`。
- SCM 中 `VemVendingDaemon` 状态为 `Running`。
- `daemon-ready.json` 存在且 `healthzUrl` 返回 `{"status":"ok"}`。

## 真机业务 smoke

| 项目 | 操作 | 通过标准 | 结果 |
| --- | --- | --- | --- |
| Service install/start/stop | SCM 启停服务 | 启停均成功，日志路径在数据目录 | |
| Service failure recovery | kill daemon 进程 | SCM 在 5 秒内拉起服务 | |
| UI kiosk | 普通用户启动 UI | 全屏、置顶、无边框、触控可操作 | |
| Session 通信 | UI 连接 daemon IPC | UI 能显示 daemon health/ready | |
| COM 下位机 | 测试 broker 下发出货命令 | 下位机完成一次出货，result 上报 | |
| 重复 command | 重发同一 commandNo | 不重复出货，result 可重发 | |
| 扫码器 | 扫入测试付款码 | UI 显示 masked code，SQLite/日志无明文 | |
| 断电恢复 | 断电后重启 | daemon 自启、UI 重连、outbox 补发 | |
| 权限 | 服务账号访问数据目录/证书/COM | 无 access denied | |
| TLS/broker | 测试 broker TLS 连接 | 认证成功；错误证书时状态可诊断 | |
