import type {
  PluginHookContext,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import { IDLE_MS, PLUGIN_ID } from "./server/config";
import {
  extractContext,
  fetchConversationEntries,
  forbiddenNames,
  type AgentSnapshotLike,
  type TimelineHandleLike,
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
  const explicitInitialTitles = new Set<string>();

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
    force = false,
  ): Promise<void> {
    timers.delete(agentId);
    if (running.has(agentId)) return;
    running.add(agentId);

    try {
      let state = getAgentState(agentId);
      if (state.locked) return;

      const handle = paseo.agents.ref(agentId);
      const { entries, firstUserText, agent: pageAgent } = await fetchConversationEntries(
        handle.timeline as unknown as TimelineHandleLike,
      );

      let snapshot = pageAgent;
      if (!snapshot) {
        const refreshed = await handle.refresh();
        snapshot = (refreshed?.agent ?? null) as unknown as AgentSnapshotLike | null;
      }
      if (!snapshot) return;
      if (snapshot.archivedAt || snapshot.background) return;
      if (!force && snapshot.activeTurn) return;

      const currentTitle = snapshot.title ?? fallbackTitle ?? null;
      const derived = deriveInitialAgentTitle(firstUserText);

      // 用户手改检测：
      // 1) 插件已经写入过 lastPluginTitle，之后标题被改成了别的值 -> 用户手改，锁定
      // 2) 插件已记录过 provisionalTitle（刚开第一轮时的标题），在插件首次改名前被改成了别的值 -> 用户手改，锁定
      // 注意：不再在“首次观察到某老会话”时仅仅因为 currentTitle !== derived 就锁死！
      // 因为长会话翻页、或其它首轮改名插件（如 better-paseo）都会让初始标题不等于 derived，那属于误锁。
      if (!force) {
        if (state.lastPluginTitle) {
          if (currentTitle !== state.lastPluginTitle) {
            updateAgentState(agentId, { locked: true, lockReason: "user_renamed" });
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
        }
      }

      const values = await readSettings(settings);

      if (state.lastSummarizedTurnId === turnId) {
        if (state.lastPluginTitle && values?.syncWorkspaceTitle !== false) {
          await syncWorkspaceTitle(paseo, snapshot.workspaceId, state.lastPluginTitle);
        }
        return;
      }

      const provisional = state.provisionalTitle ?? currentTitle ?? derived;
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

  server.handle(scanRpc, async (input, context) => {
    const listed = await context.paseo.agents.list();
    const allEntries = listed.entries ?? [];
    const ids = input.agentIds?.length ? new Set(input.agentIds) : null;
    const entries = ids ? allEntries.filter((entry) => ids.has(entry.agent.id)) : allEntries;
    const force = input.force === true || ids !== null;
    let scheduled = 0;
    for (const entry of entries) {
      const agent = entry.agent;
      if (agent.archivedAt || agent.background) continue;
      const state = getAgentState(agent.id);
      if (state.locked && !force) continue;
      if (force) {
        updateAgentState(agent.id, {
          locked: false,
          lockReason: null,
          provisionalTitle: null,
          lastPluginTitle: null,
          lastSummarizedTurnId: null,
        });
      }
      const id = agent.id;
      const title = agent.title ?? null;
      const cwd = agent.cwd ?? null;
      const timer = setTimeout(() => {
        void runIdle(id, `forced:${id}`, context.paseo, title, cwd, force);
      }, 800 + scheduled * 300);
      timers.set(id, timer);
      scheduled += 1;
    }
    console.log(`[${PLUGIN_ID}] 扫描已有会话：共 ${allEntries.length}，选中 ${entries.length}，安排 ${scheduled}`);
    return { scanned: allEntries.length, scheduled };
  });

  const offCreate = server.addHook("agent.create.before", async ({ request }) => {
    // 只有用户/调用方在创建会话时显式传入了 config.title，才标记为自定义初始标题。
    // 这里还拿不到 agentId，所以通过临时集合记录该显式标题，在 create.after 中绑定到 agentId。
    const explicit =
      typeof request.config.title === "string" && request.config.title.trim().length > 0
        ? request.config.title.trim()
        : null;
    if (explicit) {
      explicitInitialTitles.add(explicit);
    }
    return undefined;
  });

  const offCreated = server.addHook("agent.create.after", async ({ agent }) => {
    if (agent.background) return;
    const title = typeof agent.title === "string" ? agent.title.trim() : "";
    if (title && explicitInitialTitles.has(title)) {
      explicitInitialTitles.delete(title);
      updateAgentState(agent.id, {
        locked: true,
        lockReason: "explicit_create_title",
        provisionalTitle: title,
      });
      console.log(`[${PLUGIN_ID}] 创建时显式指定了标题，永久锁定 agent=${agent.id}`);
    }
  });

  const offBefore = server.addHook("agent.turn.before", async ({ agent }) => {
    cancel(agent.id);
    if (agent.background) return;
    const state = getAgentState(agent.id);
    if (state.locked) return;
    const currentTitle = agent.title ?? null;
    // 在新一轮开始时就校验：如果之前插件写过标题（或记录过初始标题），而现在变了，说明用户在两轮之间手动改了名
    if (state.lastPluginTitle && currentTitle && currentTitle !== state.lastPluginTitle) {
      updateAgentState(agent.id, { locked: true, lockReason: "user_renamed" });
      console.log(`[${PLUGIN_ID}] 新一轮开始前检测到用户手改，永久锁定 agent=${agent.id}`);
      return;
    }
    if (
      !state.lastPluginTitle &&
      state.provisionalTitle !== null &&
      currentTitle &&
      currentTitle !== state.provisionalTitle
    ) {
      updateAgentState(agent.id, {
        locked: true,
        lockReason: "user_renamed_before_first_summary",
      });
      console.log(`[${PLUGIN_ID}] 首次定稿前检测到用户手改，永久锁定 agent=${agent.id}`);
      return;
    }
    if (state.provisionalTitle === null && currentTitle) {
      updateAgentState(agent.id, { provisionalTitle: currentTitle });
    }
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
    offCreate();
    offCreated();
    offBefore();
    offAfter();
    offArchive();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
