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
  seqStart?: number;
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

export interface TimelineCursorLike {
  epoch: string;
  seq: number;
}

export interface TimelinePayloadLike {
  entries: TimelineEntryLike[];
  agent?: AgentSnapshotLike | null;
  hasOlder?: boolean;
  hasNewer?: boolean;
  startCursor?: TimelineCursorLike | null;
  endCursor?: TimelineCursorLike | null;
  reset?: boolean;
  error?: string | null;
}

export interface TimelineHandleLike {
  refetch(options?: {
    direction?: "tail" | "before" | "after";
    cursor?: TimelineCursorLike;
    limit?: number;
    projection?: "projected" | "canonical";
    wholeTurns?: boolean;
  }): Promise<TimelinePayloadLike>;
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

/**
 * 分页读取对话：从开头（after）读前 firstUserLimit 条用户消息以锚定真实首条输入，
 * 再从末尾（tail/before）逆序回溯直到集齐 recentMessagesLimit 条有效问答消息。
 * 这样在长会话、或者一轮里有大量 tool_call 时，既不会把中间某条消息误当成第一条，
 * 也不会因为末尾一页全是 tool_call 而漏掉最近的用户诉求。
 */
export async function fetchConversationEntries(
  timeline: TimelineHandleLike,
  options?: {
    firstUserLimit?: number;
    recentMessagesLimit?: number;
    maxPages?: number;
    pageSize?: number;
  },
): Promise<{
  entries: TimelineEntryLike[];
  firstUserText: string | null;
  agent: AgentSnapshotLike | null;
}> {
  const firstUserLimit = options?.firstUserLimit ?? MAX_FIRST_USER_MESSAGES;
  const recentMessagesLimit = options?.recentMessagesLimit ?? MAX_RECENT_MESSAGES;
  const maxPages = options?.maxPages ?? 6;
  const pageSize = options?.pageSize ?? 24;

  let agent: AgentSnapshotLike | null = null;

  // 1) 从头向后翻页，拿真实的第 1~2 条用户消息
  const headEntries: TimelineEntryLike[] = [];
  let firstUserText: string | null = null;
  let headUserCount = 0;
  let afterCursor: TimelineCursorLike | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await timeline.refetch({
      direction: "after",
      limit: pageSize,
      ...(afterCursor ? { cursor: afterCursor } : {}),
    });
    if (page.agent && !agent) agent = page.agent;
    if (page.error || (page.reset && afterCursor)) break;
    const entries = page.entries ?? [];
    if (!afterCursor && entries.length === 0 && !page.startCursor && !page.endCursor) break;

    for (const entry of entries) {
      const msgs = collectMessages([entry]);
      if (msgs.length > 0) {
        headEntries.push(entry);
        for (const m of msgs) {
          if (m.role === "用户") {
            if (firstUserText === null) firstUserText = m.text;
            headUserCount += 1;
          }
        }
        if (headUserCount >= firstUserLimit) break;
      }
    }
    if (headUserCount >= firstUserLimit || !page.hasNewer || !page.endCursor) break;
    if (
      afterCursor &&
      (page.endCursor.epoch !== afterCursor.epoch || page.endCursor.seq <= afterCursor.seq)
    ) {
      break;
    }
    afterCursor = page.endCursor;
  }

  // 2) 从末尾向前翻页，保证拿到最近 recentMessagesLimit 条问答消息
  const tailPages: TimelineEntryLike[][] = [];
  let tailMessageCount = 0;
  let beforeCursor: TimelineCursorLike | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await timeline.refetch({
      direction: beforeCursor ? "before" : "tail",
      limit: pageSize,
      wholeTurns: true,
      ...(beforeCursor ? { cursor: beforeCursor } : {}),
    });
    if (page.agent) agent = page.agent;
    if (page.error || (page.reset && beforeCursor)) break;
    const entries = page.entries ?? [];
    if (!beforeCursor && entries.length === 0 && !page.startCursor && !page.endCursor) break;

    const msgEntries = entries.filter((e) => collectMessages([e]).length > 0);
    tailPages.push(msgEntries);
    tailMessageCount += msgEntries.length;

    if (tailMessageCount >= recentMessagesLimit || !page.hasOlder || !page.startCursor) break;
    if (
      beforeCursor &&
      (page.startCursor.epoch !== beforeCursor.epoch || page.startCursor.seq >= beforeCursor.seq)
    ) {
      break;
    }
    beforeCursor = page.startCursor;
  }

  const tailEntries = tailPages.reverse().flat();
  if (firstUserText === null) {
    firstUserText = extractFirstUserText(tailEntries);
  }

  // 3) 按 seqStart 去重合并（无 seqStart 时按引用顺序保留）
  const merged: TimelineEntryLike[] = [];
  const seenSeq = new Set<number>();
  for (const entry of [...headEntries, ...tailEntries]) {
    if (typeof entry.seqStart === "number") {
      if (seenSeq.has(entry.seqStart)) continue;
      seenSeq.add(entry.seqStart);
    }
    merged.push(entry);
  }
  return { entries: merged, firstUserText, agent };
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
