import fs from "node:fs";
import path from "node:path";
import { STATE_PATH } from "./config";

export interface AgentState {
  /** 首次观察到该会话时，系统按首行生成的标题（或当时的当前标题） */
  provisionalTitle: string | null;
  /** 插件最近一次成功写入的标题 */
  lastPluginTitle: string | null;
  /** 最近一次已总结过的 turnId，防止同一轮重复总结 */
  lastSummarizedTurnId: string | null;
  /** 用户已手动改过名 → 永久停止自动改名 */
  locked: boolean;
  lockReason: string | null;
}

interface StateFile {
  agents: Record<string, AgentState>;
}

let cached: StateFile | null = null;

function emptyState(): StateFile {
  return { agents: {} };
}

function load(): StateFile {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
      cached = parsed;
    } else {
      cached = emptyState();
    }
  } catch {
    cached = emptyState();
  }
  return cached;
}

function persist(): void {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2), "utf8");
  fs.renameSync(tmp, STATE_PATH);
}

export function getAgentState(agentId: string): AgentState {
  const state = load();
  return (
    state.agents[agentId] ?? {
      provisionalTitle: null,
      lastPluginTitle: null,
      lastSummarizedTurnId: null,
      locked: false,
      lockReason: null,
    }
  );
}

export function updateAgentState(agentId: string, patch: Partial<AgentState>): AgentState {
  const state = load();
  const next: AgentState = { ...getAgentState(agentId), ...patch };
  state.agents[agentId] = next;
  persist();
  return next;
}

/** 供自测使用：清空内存缓存与磁盘状态 */
export function __resetStateForTest(): void {
  cached = emptyState();
  try {
    fs.rmSync(STATE_PATH, { force: true });
  } catch {
    // ignore
  }
}
