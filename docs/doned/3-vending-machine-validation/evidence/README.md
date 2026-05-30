# Validation Evidence Bundle

每个进程级测试失败时保留以下文件，路径打印到测试输出：

- `environment.json`：测试名、随机种子、daemon 版本、data dir、IPC 地址、mock broker 地址、PTY 路径、vision-mock URL、开始/结束时间。
- `daemon.stdout.log` / `daemon.stderr.log`：daemon 输出。
- `state.db.copy`：SQLite 只读副本。
- `mqtt-transcript.jsonl`：命令、ack、result、heartbeat topic 与 payload 摘要。
- `pty-transcript.jsonl`：硬件/扫码模拟器收到和发送的帧摘要。
- `ipc-transcript.jsonl`：HTTP/WebSocket 请求响应摘要。
- `ui-console.log` 和 Playwright trace：UI smoke 失败时生成。
- `sensitive-scan.json`：扫描目标、敏感 token 名称、是否命中；不得包含敏感原文。

敏感信息规则：

- 不记录真实生产 broker、真实支付密钥或真实付款码。
- 测试固定明文只允许出现在测试输入常量和进程 env，不允许出现在 SQLite、日志、HTTP 错误、事件流、UI localStorage/sessionStorage。
- 扫描命中时输出命中类别、文件路径和字段名，不输出完整明文。
