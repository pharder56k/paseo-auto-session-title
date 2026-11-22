import { TIME_ZONE } from "./config";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  month: "2-digit",
  day: "2-digit",
});

/**
 * 会话创建时间（ISO 字符串）→ Asia/Shanghai 的 MMDD。
 * 只接受 createdAt；调用方必须保证不传 updatedAt / 当前时间。
 */
export function createdAtToMMDD(createdAt: string | null | undefined): string | null {
  if (typeof createdAt !== "string" || createdAt.length === 0) return null;
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  const parts = partsFormatter.formatToParts(new Date(ms));
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  if (!month || !day || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) return null;
  return `${month}${day}`;
}

/**
 * 与 Paseo 内核 create-agent-title.js 一致的首行截取算法。
 * 用于判断当前标题是否仍是“系统按首行生成的默认标题”，
 * 若不是，则认定为用户自定义/手改，进入永久锁定。
 */
export function deriveInitialAgentTitle(prompt: string | null | undefined): string | null {
  if (typeof prompt !== "string") return null;
  const firstContentLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstContentLine) return null;
  const normalized = firstContentLine.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const clamped = normalized.slice(0, 60).trim();
  return clamped.length > 0 ? clamped : null;
}
