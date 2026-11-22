Auto Session Title 会在会话连续空闲后，根据多轮对话内容自动重新提炼标题，默认格式为 `MMDD｜类型｜主题`。日期取自会话创建时间并按 Asia/Shanghai 转换，因此后续对话不会改变日期前缀。

每轮对话结束后，插件会等待设置的空闲时间，然后从会话 timeline 中提取第一条用户消息以及最近的用户与助手消息，把这些文本、原始标题和自定义提示词交给本机 `pi` CLI。由本机 Pi 配置指定的模型返回标题，插件解析后再通过 `paseo agent update` 写回会话。如果对话只是打招呼或信息不足，插件会保留原标题。

需要 Paseo 0.15.0 或更新版本，并在 daemon 所在机器上安装且登录 `pi` CLI。插件默认从 daemon 的命令路径查找 `pi` 和 `paseo`，也会检查常见的用户级与系统安装目录；命令在其它位置时，可在 daemon 环境中设置 `PASEO_AUTO_TITLE_PI_BIN` 或 `PASEO_AUTO_TITLE_PASEO_BIN`。插件功能无需额外账号、云端权限或其它插件。

设置页可调整空闲等待时间、模型来源（Pi 默认 / 跟随当前会话模型 / 固定模型 ID）、自定义提示词以及是否同步 workspace 显示标题，让手机侧栏也显示新标题。`{MMDD}` 会替换为会话创建日期。设置页还提供历史会话立即扫描与一键解锁重命名操作。

配置的 Pi 模型会收到用户与助手消息文本、原始标题和命名提示词，用于生成标题；具体处理这些文本的服务端由本机 Pi 配置决定。插件只用 `paseo agent update --name` 修改会话标题，并可选择同步 workspace 显示名；不修改对话内容、项目名称、项目归属、排序、置顶或归档状态。状态文件保存在 daemon 本机的 `~/.paseo/plugin-data/auto-session-title/`，设置保存在 `~/.paseo/plugin-settings/auto-session-title/`。插件在 daemon 上以非沙箱方式运行，请只从信任的来源安装。
