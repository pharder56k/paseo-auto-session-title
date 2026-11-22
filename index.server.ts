import type {
  PluginHookContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { IDLE_MS, PLUGIN_ID } from "./server/config";
import {
  extractContext,
  extractFirstUserText,
  forbiddenNames,
  type AgentSnapshotLike,
  type TimelinePayloadLike,
} from "./server/context-extract";
import { createdAtToMMDD, deriveInitialAgentTitle } from "./server/date-mmdd";
import { renameAgent } from "./server/renamer";
import { summarizeTitle } from "./server/summarizer";
import { getAgentState, updateAgentState } from "./server/state-store";
import {
  namingSettings,
  scanRpc,
  type NamingSettingsValues,
} from "./shared/settings";

type PaseoLike = PluginHookContext["paseo"];

async function readSettings(
  settings: ReturnType<PluginServerContext["registerSettings"]>,
): Promise<NamingSettingsValues | null> {
  const result = await settings.read();
  return result.status === "ready" ? (result.values as NamingSettingsValues) : null;
}

function modelArgsFor(values: NamingSettingsValues | null, snapshot: AgentSnapshotLike): string[] {
  if (!values) return [];
  if (values.modelMode === "follow-agent") {
    const model = snapshot.model ?? snapshot.runtimeInfo?.model;
    return model ? ["--model", model] : [];
  }
  if (values.modelMode === "fixed" && values.fixedModel.trim()) {
    return ["--model", values.fixedModel.trim()];
  }
  return [];
}

async function syncWorkspaceTitle(
  paseo: PaseoLike,
  workspaceId: string | null | undefined,
  title: string,
): Promise<void> {
  if (!workspaceId || !title) return;
  try {
    const handle = paseo.workspaces.ref(workspaceId);
    const snapshot = await handle.refresh();
    const current = snapshot?.name ?? handle.current()?.name ?? null;
    if (current === title) return;
    await handle.setTitle(title);
    console.log(`[${PLUGIN_ID}] 工作区标题已同步 workspace=${workspaceId} -> ${title}`);
  } catch (error) {
    console.error(`[${PLUGIN_ID}] 工作区标题同步失败 workspace=${workspaceId}`, error);
  }
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(namingSettings);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();

  function cancel(agentId: string): void {
    const timer = timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(agentId);
    }
  }

  async function runIdle(
    agentId: string,
    turnId: string,
    paseo: PaseoLike,
    fallbackTitle: string | null,
    fallbackCwd: string | null,
  ): Promise<void> {
    timers.delete(agentId);
    if (running.has(agentId)) return;
    running.add(agentId);

    try {
      let state = getAgentState(agentId);
      if (state.locked) return;

      const handle = paseo.agents.ref(agentId);
      const page = (await handle.timeline.refetch({
        direction: "tail",
        limit: 30,
        wholeTurns: true,
      })) as unknown as TimelinePayloadLike;

      let snapshot = page.agent as AgentSnapshotLike | null | undefined;
      if (!snapshot) {
        const refreshed = await handle.refresh();
        snapshot = (refreshed?.agent ?? null) as unknown as AgentSnapshotLike | null;
      }
      if (!snapshot) return;
      if (snapshot.archivedAt || snapshot.background || snapshot.activeTurn) return;

      const currentTitle = snapshot.title ?? fallbackTitle ?? null;
      const entries = page.entries ?? [];
      const firstUserText = extractFirstUserText(entries);
      const derived = deriveInitialAgentTitle(firstUserText);

      // 用户手改检测：优先级高于 turnId 去重
      if (state.lastPluginTitle) {
        if (currentTitle !== state.lastPluginTitle) {
          updateAgentState(agentId, {
            locked: true,
            lockReason: "user_renamed",
          });
          console.log(`[${PLUGIN_ID}] 检测到用户手改，永久锁定 agent=${agentId}`);
          return;
        }
      } else if (state.provisionalTitle !== null) {
        if (currentTitle !== state.provisionalTitle) {
          updateAgentState(agentId, {
            locked: true,
            lockReason: "user_renamed_before_first_summary",
          });
          console.log(`[${PLUGIN_ID}] 首次定稿前检测到用户手改，永久锁定 agent=${agentId}`);
          return;
        }
      } else if (currentTitle && derived && currentTitle !== derived) {
        // 首次观察：当前标题既不是首行推导值，说明是显式自定义标题
        updateAgentState(agentId, {
          locked: true,
          lockReason: "custom_initial_title",
          provisionalTitle: currentTitle,
        });
        console.log(`[${PLUGIN_ID}] 检测到自定义初始标题，永久锁定 agent=${agentId}`);
        return;
      }

      const values = await readSettings(settings);

      if (state.lastSummarizedTurnId === turnId) {
        if (state.lastPluginTitle && values?.syncWorkspaceTitle !== false) {
          await syncWorkspaceTitle(paseo, snapshot.workspaceId, state.lastPluginTitle);
        }
        return;
      }

      const provisional = state.provisionalTitle ?? derived ?? currentTitle;
      if (!state.provisionalTitle) {
        state = updateAgentState(agentId, { provisionalTitle: provisional });
      }

      const mmdd = createdAtToMMDD(snapshot.createdAt);
      if (!mmdd) {
        console.error(`[${PLUGIN_ID}] createdAt 无效，跳过 agent=${agentId}`);
        updateAgentState(agentId, { lastSummarizedTurnId: turnId });
        return;
      }

      const forbidden = forbiddenNames(snapshot.cwd ?? fallbackCwd);
      const context = extractContext(entries, currentTitle, mmdd);
      const decision = await summarizeTitle({
        context,
        originalTitle: currentTitle,
        forbidden,
        mmdd,
        customPrompt: values?.customPrompt,
        modelArgs: modelArgsFor(values, snapshot),
      });
      console.log(
        `[${PLUGIN_ID}] 总结结果 agent=${agentId} decision=${JSON.stringify(decision)} current=${JSON.stringify(currentTitle)}`,
      );

      if (!decision.decided) {
        console.log(`[${PLUGIN_ID}] 主题无法确定，保留原名 agent=${agentId}`);
        updateAgentState(agentId, { lastSummarizedTurnId: turnId });
        return;
      }

      const newTitle = decision.title;
      if (newTitle === currentTitle) {
        updateAgentState(agentId, { lastSummarizedTurnId: turnId });
        if (values?.syncWorkspaceTitle !== false) {
          await syncWorkspaceTitle(paseo, snapshot.workspaceId, newTitle);
        }
        return;
      }

      const ok = await renameAgent(agentId, newTitle);
      if (ok) {
        updateAgentState(agentId, {
          lastPluginTitle: newTitle,
          lastSummarizedTurnId: turnId,
        });
        if (values?.syncWorkspaceTitle !== false) {
          await syncWorkspaceTitle(paseo, snapshot.workspaceId, newTitle);
        }
      }
    } catch (error) {
      console.error(`[${PLUGIN_ID}] idle summarize failed agent=${agentId}`, error);
    } finally {
      running.delete(agentId);
    }
  }

  server.handle(scanRpc, async (_input, context) => {
    const listed = await context.paseo.agents.list();
    const entries = listed.entries ?? [];
    let scheduled = 0;
    for (const entry of entries) {
      const agent = entry.agent;
      if (agent.archivedAt || agent.background) continue;
      const state = getAgentState(agent.id);
      if (state.locked) continue;
      const id = agent.id;
      const title = agent.title ?? null;
      const cwd = agent.cwd ?? null;
      const timer = setTimeout(() => {
        void runIdle(id, `startup:${id}`, context.paseo, title, cwd);
      }, 800 + scheduled * 300);
      timers.set(id, timer);
      scheduled += 1;
    }
    console.log(`[${PLUGIN_ID}] 扫描已有会话：共 ${entries.length}，安排 ${scheduled}`);
    return { scanned: entries.length, scheduled };
  });

  const offBefore = server.addHook("agent.turn.before", async ({ agent }) => {
    cancel(agent.id);
  });

  const offAfter = server.addHook(
    "agent.turn.after",
    async ({ agent, turnId, outcome }, context) => {
      if (outcome.kind !== "completed" || agent.background) return;
      cancel(agent.id);
      const values = await readSettings(settings);
      const idleMs = (values?.idleSeconds ?? IDLE_MS / 1000) * 1000;
      const paseo = context.paseo;
      const title = agent.title ?? null;
      const cwd = agent.cwd ?? null;
      const id = agent.id;
      const turn = turnId ?? "";

      const timer = setTimeout(() => {
        void runIdle(id, turn, paseo, title, cwd);
      }, idleMs);
      timers.set(id, timer);
    },
  );

  const offArchive = server.addHook("agent.archive.after", async ({ agent }) => {
    cancel(agent.id);
  });

  return () => {
    offBefore();
    offAfter();
    offArchive();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
