export interface AgentSnapshotLike {
  createdAt?: string;
  title?: string | null;
  cwd?: string;
  workspaceId?: string | null;
  model?: string | null;
  runtimeInfo?: { model?: string | null };
  archivedAt?: string | null;
  activeTurn?: unknown;
  background?: boolean;
}

export interface TimelineEntryLike {
  item: {
    type: string;
    text?: string;
    name?: string;
    agentMessage?: { event?: string; text?: string };
    detail?: { type?: string; text?: string };
  };
  turnId?: string;
  timestamp?: string;
}

export interface TimelinePayloadLike {
  entries: TimelineEntryLike[];
  agent?: AgentSnapshotLike | null;
}

interface Message {
  role: "用户" | "助手";
  text: string;
  index: number;
}

const MAX_MESSAGE_CHARS = 400;
const MAX_CONTEXT_CHARS = 2500;
const MAX_RECENT_MESSAGES = 8;
const MAX_FIRST_USER_MESSAGES = 2;

function cleanText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, "[代码片段]")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function collectMessages(entries: TimelineEntryLike[]): Message[] {
  const messages: Message[] = [];
  entries.forEach((entry, index) => {
    const item = entry.item;
    const type = item?.type;

    if (type === "user_message" || type === "assistant_message") {
      if (typeof item.text === "string") {
        const cleaned = cleanText(item.text);
        if (cleaned) {
          messages.push({ role: type === "user_message" ? "用户" : "助手", text: cleaned, index });
        }
      }
      return;
    }

    // 经 CLI / 其它 agent 发进来的用户消息在 timeline 里是 tool_call，
    // 文本位于 agentMessage.text（或 plain_text detail）。
    if (type === "tool_call" && (item.name === "paseo-agent-message" || item.agentMessage)) {
      const raw =
        item.agentMessage?.event === "message"
          ? item.agentMessage?.text
          : item.detail?.type === "plain_text"
            ? item.detail?.text
            : undefined;
      if (typeof raw === "string" && raw.trim()) {
        const cleaned = cleanText(raw);
        if (cleaned) messages.push({ role: "用户", text: cleaned, index });
      }
    }
  });
  return messages;
}

export function extractFirstUserText(entries: TimelineEntryLike[]): string | null {
  const first = collectMessages(entries).find((m) => m.role === "用户");
  return first?.text ?? null;
}

export function extractContext(
  entries: TimelineEntryLike[],
  originalTitle: string | null | undefined,
  mmdd?: string,
): string {
  const messages = collectMessages(entries);
  const firstUsers = messages.filter((m) => m.role === "用户").slice(0, MAX_FIRST_USER_MESSAGES);
  const recent = messages.slice(-MAX_RECENT_MESSAGES);

  const seen = new Set<number>();
  const selected: Message[] = [];
  for (const m of [...firstUsers, ...recent]) {
    if (!seen.has(m.index)) {
      seen.add(m.index);
      selected.push(m);
    }
  }

  const lines = selected.map((m) => `${m.role}：${m.text}`);
  const dateLine = mmdd ? `会话创建日期（MMDD，Asia/Shanghai）：${mmdd}` : "";
  const header = [dateLine, `原始标题：${originalTitle || "(无)"}`].filter(Boolean).join("\n");
  const body = lines.join("\n");
  const combined = `${header}\n\n${body}`;
  return combined.length > MAX_CONTEXT_CHARS ? combined.slice(0, MAX_CONTEXT_CHARS) : combined;
}

/** 从 cwd 提取禁止在主题中重复出现的项目/目录名 */
export function forbiddenNames(cwd: string | null | undefined): string[] {
  if (typeof cwd !== "string" || !cwd.trim()) return [];
  return cwd
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !/^\./.test(part))
    .slice(-2);
}
