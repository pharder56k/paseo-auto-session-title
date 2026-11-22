# Auto Session Title

Paseo 插件：在会话连续空闲后，根据多轮对话内容自动重新提炼标题，格式默认为 `MMDD｜类型｜主题`。

## 功能

- 会话完成一轮对话并空闲一段时间后，自动读取 timeline 中的多轮对话，重新总结标题。
- 日期取自会话的 `createdAt`，按 `Asia/Shanghai` 转换为 `MMDD`，不会随后续对话变化。
- 类型限定为 8 类：功能、设计、修复、优化、发布、探索、文档、研究。
- 主题根据对话内容提炼，避开项目/目录名；信息不足时保留原名。
- 用户手动改过标题后，该会话永久停止自动改名。
- 可同步修改所属 workspace 的显示标题，让手机/桌面端侧栏直接显示新标题。
- 设置项：空闲等待时间、模型来源（pi 默认 / 跟随本轮会话主模型 / 固定模型）、自定义提示词、是否同步工作区标题，以及历史会话立即扫描与一键解锁重命名。

## 安装

需要 Paseo >= 0.15.0，且 daemon 所在机器上已安装并登录 `pi` CLI（插件用它做标题提炼）。

插件默认从 daemon 的 `PATH` 查找 `pi` 和 `paseo`，macOS / Linux / Windows 都适用；找不到时会检查常见的用户目录与系统目录（例如 `~/.local/bin/pi`、`~/.pi/agent/bin/pi`、`~/.npm-global/bin/paseo`）。如果命令装在其它位置，可在 daemon 环境中设置 `PASEO_AUTO_TITLE_PI_BIN` / `PASEO_AUTO_TITLE_PASEO_BIN` 指向可执行文件；修改环境变量后需要重启 daemon。插件日志开头的 `外部命令 pi=... paseo=...` 会显示实际使用的路径。

从本仓库安装：

```bash
paseo plugin install github:pharder56k/paseo-auto-session-title
```

私有仓库需要在 daemon 所在机器上先登录 GitHub CLI，并配置 git credential helper：

```bash
gh auth login
gh auth setup-git
```

也可以先克隆仓库再本地安装：

```bash
git clone git@github.com:pharder56k/paseo-auto-session-title.git
paseo plugin install /absolute/path/to/paseo-auto-session-title
```

安装后在 **设置 → 插件 → Auto Session Title → 齿轮图标** 打开设置页。首次打开会自动扫描已有会话。

## 设置

| 选项 | 默认值 | 说明 |
|---|---|---|
| 空闲等待时间 | 45 秒 | 连续空闲多久后自动改名，范围 5–3600 秒 |
| 模型来源 | pi 默认模型 | 可选“跟随本轮会话主模型”或“固定模型” |
| 自定义提示词 | 内置默认规则 | 可整段改写；`{MMDD}` 会替换为会话创建日期 |
| 同步重命名工作区标题 | 开启 | 让侧栏会话名同步更新，只改显示标题 |
| 立即扫描 / 强制重命名 | 手动操作 | 扫描未锁定的历史会话，或清除手改锁定后按最新多轮对话重新命名 |

## 数据说明

- 对话文本会作为提示词发送给本机 `pi` CLI 调用的模型服务；具体后端取决于设备上 `pi` 的配置。
- 插件状态保存在 `~/.paseo/plugin-data/auto-session-title/state.json`，设置保存在 `~/.paseo/plugin-settings/auto-session-title/`。
- 插件不会修改会话内容、项目名、项目归属、排序、置顶或归档状态。
- 插件代码在 daemon 上以非沙箱方式运行，只应安装你信任的来源。

## 开发

```bash
npm install
npm run typecheck
node --experimental-strip-types tests/self-check.ts
```

修改源码后执行：

```bash
paseo plugin reload auto-session-title
```
