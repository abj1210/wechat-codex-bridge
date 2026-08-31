# 完整实施方案

## 1. 目标

将桥接器从“Node 直接处理微信消息和命令”迁移为：

```text
微信消息
  -> Node 仅负责微信收发、去重、队列、分段
  -> Python handler.py 负责命令路由和 Codex 调用
  -> 命令由任务包管理器分发给任务包
  -> 普通消息直接交给 Codex
  -> Codex / 任务包输出统一为 JSON
  -> Node 读取最终 JSON 并回复微信
```

## 2. 目录结构

```text
wechat-codex-bridge/
├── index.mjs
├── handler.py
├── manager.py
├── config.json
├── package_manager/
│   ├── __init__.py
│   ├── registry.json
│   ├── base_package.py
│   └── manager.py
├── shared/
│   ├── codex_client.py
│   ├── json_io.py
│   ├── lock.py
│   └── protocol.py
├── packages/
│   ├── settings/
│   │   ├── package.py
│   │   └── state.json
│   ├── sessions/
│   │   ├── package.py
│   │   └── state.json
│   └── workdir/
│       ├── package.py
│       └── state.json
├── runtime/
│   └── <run_id>/
│       ├── input.json
│       ├── codex_output.json
│       ├── package_output.json
│       └── final_reply.json
├── state/
│   ├── auth.json
│   ├── sync.json
│   ├── context-tokens.json
│   ├── seen-messages.json
│   └── bridge.lock
└── tests/
```

## 3. Node 与 Python 的边界

### Node 继续负责

- iLink 登录和微信长轮询
- 消息去重和单用户队列
- 单实例锁
- 确认消息
- 最终回复的分段发送
- context_token 的缓存

### Node 不再负责

- `/cd`、`/workdir`、`/session`、`/resume`、`/new`、`/help` 等命令逻辑
- Codex 子进程调用
- 会话和工作目录状态

普通消息和 `/` 命令都会交给 Python `handler.py`。

## 4. Node 调用 handler.py 的协议

Node 使用 `cross-spawn` 启动：

```bash
python3 handler.py
```

输入：

- stdin：UTF-8 文本，内容是原始消息或命令。

环境变量：

```text
CODEX_BRIDGE_PROJECT_ROOT
CODEX_BRIDGE_WORKDIR
CODEX_BRIDGE_USER_ID
CODEX_BRIDGE_MODE=wechat
```

输出：

- stdout：一个最终 JSON 对象。
- stderr：调试或错误日志。

最终 JSON：

```json
{
  "status": "ok",
  "text": "最终回复内容",
  "attachments": []
}
```

Node 只读取 `text` 和 `attachments`，分段逻辑仍由 Node 负责。

## 5. handler.py 处理流程

```text
读取 stdin
  -> 写入 runtime/<run_id>/input.json
  -> 判断是否以 / 开头
  -> 是：调用包管理器查找命令
        - 找到：执行任务包输入处理函数
        - 未找到：返回“未知命令”
  -> 否：直接调用 Codex
  -> Codex 输出写入 codex_output.json
  -> 任务包输出处理函数处理
  -> 写入 final_reply.json
  -> stdout 输出最终 JSON
```

`handler.py` 本身保持单进程、无内部并发。

## 6. 任务包接口

每个任务包目录下必须有 `package.py`，并提供：

```python
PACKAGE_INFO = {
    "name": "settings",
    "commands": ["/config", "/model", "/sandbox"],
    "help": {
        "/config": "查看或修改桥接配置",
        "/model": "查看当前模型",
        "/sandbox": "查看或修改沙盒模式"
    }
}

def process_input(command: str, context: dict) -> dict:
    ...

def process_output(payload: dict, context: dict) -> dict:
    ...
```

`process_input` 返回：

```json
{
  "action": "codex",
  "input": "处理后的 prompt",
  "error": ""
}
```

`action` 可选值：

```text
codex   调用 Codex
output  不调用 Codex，直接进入输出处理
error   返回错误
```

`process_output` 接收：

```json
{
  "source": "codex",
  "input_result": {},
  "codex_output": {},
  "package_output": {}
}
```

返回最终回复：

```json
{
  "text": "...",
  "attachments": []
}
```

## 7. 任务包管理器

### 注册表

路径：

```text
package_manager/registry.json
```

结构：

```json
{
  "version": 1,
  "packages": [
    {
      "id": "uuid",
      "name": "settings",
      "module_name": "settings",
      "path": "packages/settings",
      "enabled": true,
      "commands": ["/config", "/model", "/sandbox"],
      "order": 1,
      "help": {}
    }
  ]
}
```

### 功能

- `add(package_path)`：注册新任务包，自动生成 UUID。
- `remove(package_id)`：从注册表删除条目。
- `enable(package_id)` / `disable(package_id)`。
- `set_order(package_id, target_order)`：调整排序，其他包相对顺序不变。
- `find_package(command)`：按 `order` 从小到大扫描已启用包，返回第一个能处理该命令的包。
- `list_packages()`：列出所有包。

排序规则实现：

1. 从列表中移除目标包。
2. 将目标包插入到 `target_order - 1` 的位置。
3. 插入后重新计算连续序号。

默认信任所有已注册任务包，不进行签名校验。

## 8. Codex 客户端

`shared/codex_client.py` 负责：

- 根据 `config.json` 生成 `codex exec` 参数。
- 普通消息调用 `codex exec`。
- 历史会话调用 `codex exec resume`。
- 通过 `cross-spawn` 类似的子进程方式执行。
- 解析 `--json` 输出。
- 最终文本优先读取 `-o` 指定的 last-message 文件。
- 提取 `thread.started` 中的 `thread_id`。

Codex 输出统一写入：

```json
{
  "status": "ok",
  "text": "最终文本",
  "session_id": "01a...",
  "exit_code": 0
}
```

配置来源：

- 模型、provider 继续继承 `~/.codex/config.toml`。
- `sandboxMode`、`networkAccess`、`autoApprove`、`skipGitRepoCheck` 从项目 `config.json` 读取。

## 9. 状态迁移

| 旧状态 | 新位置 | 说明 |
|---|---|---|
| `state/codex-sessions.json` | `packages/sessions/state.json` | 会话管理包维护 |
| Node 内存 `workdirByUser` | `packages/workdir/state.json` | 工作目录包维护 |
| `state/context-tokens.json` | 保持不变 | 微信传输层需要 |
| `state/seen-messages.json` | 保持不变 | 微信去重需要 |
| `state/auth.json` | 保持不变 | iLink 登录需要 |
| `state/sync.json` | 保持不变 | 微信长轮询游标 |

提供迁移函数：

```text
manager.py migrate-state
```

或在 Python 首次启动时自动完成惰性迁移。

## 10. 首批任务包

### settings

命令示例：

```text
/config
/model
/sandbox
```

状态：

```text
packages/settings/state.json
```

负责读写项目 `config.json` 中的桥接参数。

### sessions

命令示例：

```text
/session
/resume <id|last>
/new
/history
```

状态：

```text
packages/sessions/state.json
```

结构：

```json
{
  "user_sessions": {
    "user_id": "session_id"
  }
}
```

### workdir

命令示例：

```text
/cd <dir>
/workdir
```

状态：

```text
packages/workdir/state.json
```

结构：

```json
{
  "user_workdirs": {
    "user_id": "/abs/path"
  }
}
```

## 11. manager.py

本地管理器提供：

```text
manager.py deploy
manager.py migrate-state
manager.py run
manager.py run-once "<文本>"
manager.py package list
manager.py package add <路径>
manager.py package remove <id>
manager.py package enable <id>
manager.py package disable <id>
manager.py package order <id> <序号>
```

### 服务离线检测

`manager.py` 运行前检查：

1. 读取 `state/bridge.lock` 中的 PID，判断进程是否存活。
2. 在 Linux 下额外检查 systemd 服务状态。
3. 在 Windows 下检查计划任务状态。

如果服务在线，`manager.py` 拒绝执行，并提示停止服务的命令。

`manager.py` 自身使用跨平台锁，防止同时启动多个本地管理器。

## 12. Node 改造

`index.mjs` 修改为：

- 移除命令判断分支。
- 普通消息和 `/` 命令都调用 `handler.py`。
- 读取 Python stdout 的最终 JSON。
- 由 Node 执行分段发送。
- 保留确认消息、消息去重、单实例锁和 iLink 轮询。

过渡期可在 `config.json` 中保留：

```json
{
  "backend": "python"
}
```

如果 Python 实现尚未完成，可切回：

```json
{
  "backend": "node"
}
```

## 13. 运行目录和 JSON 文件

每次 handler 运行创建：

```text
runtime/<run_id>/input.json
runtime/<run_id>/codex_output.json
runtime/<run_id>/package_output.json
runtime/<run_id>/final_reply.json
```

`runtime/` 可加入 `.gitignore`，并设置保留策略，例如只保留最近 100 次运行。

## 14. 安全策略

- 默认信任所有任务包，仅允许本地添加。
- `/cd` 仍受 `allowedWorkdirs` 白名单限制。
- Python handler 不使用 shell 拼接命令，使用参数数组调用 Codex。
- `autoApprove` 默认保持 `false`。
- 不在运行时目录中保存 iLink token。

## 15. 测试计划

- 包管理器：注册、删除、启停、排序、查找。
- handler：普通消息、命令、未知命令。
- Codex 客户端：新会话、恢复会话、JSON 解析。
- 状态迁移：Node JSON 到包目录 JSON。
- Node 集成：stdout JSON 解析和分段发送。
- Windows/Linux：路径和锁检测。

## 16. 实施顺序

1. 搭建 Python 目录、共享 JSON 协议和锁。
2. 实现 `package_manager` 和首批三个任务包。
3. 实现 `handler.py` 与 Codex 客户端。
4. 实现 `manager.py` 和服务离线检测。
5. 修改 `index.mjs`，将消息和命令转发到 Python。
6. 状态迁移。
7. 测试与文档更新。
