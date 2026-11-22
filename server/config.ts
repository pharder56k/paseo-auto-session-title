import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = "auto-session-title";

/** 连续无新 turn 多久后定稿（毫秒） */
export const IDLE_MS = 45_000;
/** 本机 pi 调用超时（毫秒） */
export const PI_TIMEOUT_MS = 25_000;
/** paseo agent update 调用超时（毫秒） */
export const RENAME_TIMEOUT_MS = 10_000;

export const TIME_ZONE = "Asia/Shanghai";

export const TYPES = [
  "功能",
  "设计",
  "修复",
  "优化",
  "发布",
  "探索",
  "文档",
  "研究",
] as const;

export type TitleType = (typeof TYPES)[number];

export const STATE_PATH = path.join(
  os.homedir(),
  ".paseo",
  "plugin-data",
  PLUGIN_ID,
  "state.json",
);

/** 绝对路径，避免 plugin 子进程继承不到 daemon 的 PATH */
export const PASEO_BIN =
  process.env.PASEO_AUTO_TITLE_PASEO_BIN ?? "/home/harder/.npm-global/bin/paseo";
export const PI_BIN =
  process.env.PASEO_AUTO_TITLE_PI_BIN ?? "/home/harder/.local/bin/pi";

/** 主题长度限制 */
export const TOPIC_MIN_HAN = 4;
export const TOPIC_MIN_LATIN = 8;
export const TOPIC_MAX_CHARS = 28;
