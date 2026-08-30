# wechat-codex-bridge

<p align="center">
  <img src="assets/icon-512.png" width="128" height="128" alt="wechat-codex-bridge icon">
</p>

把**个人微信号**接到本机 Codex CLI：微信里发消息，交给 `codex exec` 执行，再把结果回发到微信。

本项目已从 Wechaty + `wechaty-puppet-wechat4u`（Web 协议）切换到腾讯官方个人微信 Bot 的 iLink 协议。原方案会在 `webwxinit` 时出现：

```text
Wechaty error: AssertionError [ERR_ASSERTION]: 1 == 0
    at Object.equal .../wechat4u/lib/util/global.js:69:24
```

这通常表示微信服务端拒绝了 Web 协议登录（常见 `ret 1203` / 登录环境异常），不是本项目代码问题，继续修补 `wechat4u` 意义不大。iLink 协议是腾讯官方面向个人号 Bot 的接口，当前支持 **私聊消息和媒体，不支持群聊**。

## 最近更新

- 支持配置 Codex 沙盒模式与网络访问能力。
- 支持按用户加载/继续历史 Codex 会话。
- 每条提问包含问题内容的确认消息，并按消息 ID 去重。
- 增加单实例锁，防止多个进程同时回复。
- 支持 Windows 前台运行与登录自动启动任务。

## 设计原则

- **工作目录可指定**：`config.json` 设默认值，微信会话内可用 `/cd <目录>` 切换。
- **模型继承当前配置**：桥接不传 `-m`，Codex 仍使用 `~/.codex/config.toml` 里的模型。
- **沙盒与网络可配置**：`config.json` 的 `sandboxMode` 和 `networkAccess` 决定 Codex 执行命令时的沙盒及网络策略。
- `--skip-git-repo-check` 只放宽「必须是 git 仓库」这一条，不改变模型。
- 默认 `autoApprove: false`，即不会自动给 Codex 加 `--full-auto`。
- 每条提问会先回一条包含问题内容的确认消息，并按微信消息 ID 去重，确保同一提问不会在 Codex 中重复运行。

## 依赖

- Node.js 22+（使用全局 `fetch`）
- 已安装 `codex` 命令且 `codex exec` 可用
- `~/.codex/config.toml` 已配置模型（本机当前为 `deepseek-v4-pro`）

安装项目依赖：

```bash
cd wechat-codex-bridge
npm install
```

## 配置

编辑 `config.json`：

| 键 | 含义 | 默认 |
|---|---|---|
| `workdir` | 默认工作目录 | `/home/jianing/data` |
| `allowedWorkdirs` | 工作目录白名单，空数组表示不限制 | `[]` |
| `autoApprove` | `true` 时给 codex 加 `--full-auto`。默认关闭，遵循当前配置 | `false` |
| `skipGitRepoCheck` | 允许在非 git 目录运行 | `true` |
| `sandboxMode` | Codex 沙盒模式：`read-only`、`workspace-write`、`danger-full-access` | `workspace-write` |
| `networkAccess` | `true` 时允许 workspace-write 沙盒访问网络 | `true` |
| `replyMaxLength` | 单条微信回复最大字符数，超出分段发送 | `4000` |
| `whitelist` | 允许使用机器人的 `from_user_id`，空数组表示不限制 | `[]` |

模型仍直接继承 `~/.codex/config.toml`；沙盒和网络策略由上方 `sandboxMode`、`networkAccess` 控制。

完整示例：

```json
{
  "workdir": "/home/jianing/data",
  "allowedWorkdirs": [
    "/home/jianing/data",
    "/home/jianing/projects"
  ],
  "autoApprove": false,
  "skipGitRepoCheck": true,
  "sandboxMode": "workspace-write",
  "networkAccess": true,
  "replyMaxLength": 4000,
  "whitelist": [
    "你的微信 userId"
  ]
}
```

`allowedWorkdirs` 为空时表示不限制工作目录；填写后 `/cd` 只能切换到列表内目录或其子目录。

## 运行

首次运行会通过终端二维码登录个人微信号：

```bash
npm start
```

流程：

1. 向 `https://ilinkai.weixin.qq.com` 获取机器人二维码。
2. 用手机微信扫码确认；如服务器要求配对数字，按提示输入。
3. 登录成功后，token 与接入节点保存在 `state/auth.json`，长轮询 cursor 保存在 `state/sync.json`。
4. 微信里给机器人发消息即可触发 Codex。

也可以通过环境变量跳过二维码登录：

```bash
ILINK_BOT_TOKEN=你的token \
ILINK_BASE_URL=你的baseUrl \
npm start
```

支持的环境变量：

| 变量 | 含义 | 必填 |
|---|---|---|
| `ILINK_BOT_TOKEN` | iLink bot token | 否，已有 `state/auth.json` 时可省略 |
| `ILINK_BASE_URL` | iLink API 地址 | 否，默认 `https://ilinkai.weixin.qq.com` |
| `ILINK_BOT_ID` | bot/account ID | 否 |
| `ILINK_USER_ID` | 扫码绑定用户的 userId | 否 |
| `CODEX_WECHAT_DEBUG` | 非空时打印 Codex 进度调试日志 | 否 |

运行状态文件：

```text
state/auth.json             登录 token、账号和接入节点
state/sync.json             微信长轮询游标
state/context-tokens.json   每个用户的 context_token
state/codex-sessions.json   每个用户当前绑定的 Codex 会话
state/seen-messages.json    已处理消息 ID（用于去重）
state/bridge.lock           单实例锁
```

机器人命令：

```text
/cd <目录>   设置当前用户的工作目录（绝对路径，或相对默认 workdir）
/workdir     查看当前工作目录
/history [n] 列出最近的 Codex 会话
/resume <会话ID|last> 加载指定历史会话
/session     查看当前会话
/new         开始新会话
/help        帮助
```

普通消息会沿用当前用户上一次的 Codex 会话；首次消息会创建新会话。用 `/history` 找到会话 ID 后，可用 `/resume <会话ID>` 明确加载某个历史会话。

## 协议说明

实现依据腾讯官方个人微信 Bot 插件 `@tencent-weixin/openclaw-weixin`：

- npm：`@tencent-weixin/openclaw-weixin`
- 文档：`https://docs2.openclaw.ai/zh-CN/channels/wechat`
- 源码：`https://github.com/Tencent/openclaw-weixin`

关键点：

- 固定登录域名：`https://ilinkai.weixin.qq.com`
- 登录：`POST ilink/bot/get_bot_qrcode?bot_type=3`，再长轮询 `GET ilink/bot/get_qrcode_status`
- 消息：`POST ilink/bot/getupdates` 长轮询，`POST ilink/bot/sendmessage` 回复
- 回复时必须带当前来消息里的 `context_token`
- token 有效期约 24 小时；失效后需重新扫码，每次扫码 Bot ID 可能变化
- 当前官方能力为私聊和媒体，不支持群聊

## 安全注意事项

- 保持 `autoApprove: false`，避免自动绕过审批。
- 在 `config.json` 中根据需求设置 `sandboxMode` 和 `networkAccess`；不要把工作目录设为敏感目录。
- 用 `whitelist` 限制谁能触发机器人。iLink 场景中填入登录后日志里的 `userId`。
- `state/` 已加入 `.gitignore`，不要把 token 或 `~/.codex/config.toml` 的 API key 提交到仓库。
- 个人号扫码登录存在风控/封号风险，请使用小号或测试号。

## 测试

```bash
npm test
```

测试覆盖 Codex 调用封装与 iLink 纯函数（二维码、文本解析、消息过滤）。

## 后台运行与开机自启

项目已包含 systemd 服务文件 [wechat-codex-bridge.service](/home/jianing/data/wechat-codex-bridge/deploy/wechat-codex-bridge.service) 和安装脚本。

首次仍建议先在终端前台登录一次，完成扫码并让 token 写入 `state/auth.json`：

```bash
cd /home/jianing/data/wechat-codex-bridge
npm start
```

看到“登录成功”后按 `Ctrl-C` 退出，然后安装服务：

```bash
sudo bash deploy/install-service.sh
```

之后服务会随系统启动，并在异常退出后自动重启。常用命令：

```bash
systemctl status wechat-codex-bridge
sudo systemctl restart wechat-codex-bridge
sudo systemctl stop wechat-codex-bridge
tail -f logs/bridge.log
```

服务文件里的用户名、项目路径、Node 路径如与实际环境不同，请先修改 `deploy/wechat-codex-bridge.service`。

## Windows 运行方式

Windows 上没有 systemd，推荐用 Windows 任务计划程序实现登录后自动启动，并配合脚本运行。

前置条件：

- 安装 Node.js 22+ 和 Codex CLI。
- 确保 `codex`、`node` 命令在 PowerShell / CMD 中可用。

首次前台登录：

```powershell
cd C:\path\to\wechat-codex-bridge
npm install
npm start
```

手机微信扫码成功并看到“登录成功”后，按 `Ctrl-C` 退出。

前台运行脚本：

```bat
start-windows.bat
```

安装登录自动启动任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows-service.ps1
```

移除任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-windows-service.ps1
```

手动启动任务：

```powershell
Start-ScheduledTask -TaskName wechat-codex-bridge
```

查看状态：

```powershell
Get-ScheduledTask -TaskName wechat-codex-bridge
Get-ScheduledTaskInfo -TaskName wechat-codex-bridge
```

代码已使用 `cross-spawn` 兼容 Windows 下的 `codex.cmd` 启动；路径处理使用 Node 的 `path` 模块，工作目录、状态文件在 Windows 下同样可用。

## 常见问题

### 扫码后提示 AssertionError: 1 == 0

这是旧 Wechaty Web 协议被微信拒绝登录导致的。本项目已切换到 iLink 协议，请勿再使用 `WECHATY_PUPPET=wechaty-puppet-wechat4u` 启动。

### 日志中出现 already has an active writer

说明同一个 Codex 会话正在被另一个 Codex 进程写入。桥接会自动改用新会话并回复提示；如果必须继续该历史会话，请先关闭占用它的 Codex 进程。

### 看起来有多个机器人回复

通常是因为同时运行了多个 `node index.mjs` 实例。项目已加入单实例锁；先关闭旧进程，再只启动一个实例。

### token 失效 / 重新登录

iLink token 约 24 小时有效。服务检测到 `errcode -14` 会自动重新发起二维码登录。若后台服务无法直接扫码，可先 `sudo systemctl stop wechat-codex-bridge`，在终端执行 `npm start` 完成登录，再重新启动服务。
