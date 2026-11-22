import { spawn } from "node:child_process";
import {
  PI_BIN,
  PI_TIMEOUT_MS,
  PLUGIN_ID,
  TYPES,
  TOPIC_MAX_CHARS,
  TOPIC_MIN_HAN,
  TOPIC_MIN_LATIN,
  type TitleType,
} from "./config";

export type NamingDecision =
  | { decided: true; title: string; type?: TitleType; topic?: string }
  | { decided: false };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSystemPrompt(customPrompt: string | undefined, mmdd: string, forbidden: string[]): string {
  const forbiddenText = forbidden.length > 0 ? forbidden.join("、") : "（无）";
  const base =
    customPrompt?.trim() ||
    [
      "你是会话标题提炼器。根据多轮对话内容生成左侧栏标题。",
      "标题格式：MMDD｜类型｜主题；类型限定：功能、设计、修复、优化、发布、探索、文档、研究。",
      "信息不足时返回 {\"decided\": false}。",
      '只输出一行 JSON：{"decided": true, "title": "最终标题"} 或 {"decided": false}',
    ].join("\n");
  return `${base.replaceAll("{MMDD}", mmdd)}\n\n禁止在主题中重复的项目/目录名：${forbiddenText}`;
}

function parseDecision(raw: string, forbidden: string[], mmdd: string): NamingDecision {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { decided: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { decided: false };
  }
  if (!parsed || typeof parsed !== "object") return { decided: false };
  const obj = parsed as Record<string, unknown>;
  if (obj.decided !== true) return { decided: false };

  // 新版契约：模型直接给出最终标题（自定义提示词可自由定义格式）
  if (typeof obj.title === "string") {
    const title = obj.title
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    if (!title) return { decided: false };
    return { decided: true, title };
  }

  // 兼容旧契约：type + topic，由插件拼成默认格式
  if (typeof obj.type !== "string" || !TYPES.includes(obj.type as TitleType)) {
    return { decided: false };
  }
  if (typeof obj.topic !== "string") return { decided: false };

  let topic = obj.topic
    .replace(/[|｜\r\n"'“”‘’【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const name of forbidden) {
    if (name.length >= 2) topic = topic.split(name).join("");
  }
  topic = topic.replace(new RegExp(`^${escapeRegExp(obj.type)}`), "").replace(/^[\s:：]+/, "").trim();
  topic = topic.replace(/^[的]+/, "").trim();

  const visible = topic.replace(/\s/g, "");
  if (visible.length < 2 || visible.length > TOPIC_MAX_CHARS) return { decided: false };
  const hanCount = (visible.match(/[\u4e00-\u9fff]/g) ?? []).length;
  if (hanCount < TOPIC_MIN_HAN && visible.length < TOPIC_MIN_LATIN) return { decided: false };

  return {
    decided: true,
    type: obj.type as TitleType,
    topic: visible,
    title: `${mmdd}｜${obj.type}｜${visible}`,
  };
}

export async function summarizeTitle(input: {
  context: string;
  originalTitle: string | null | undefined;
  forbidden: string[];
  mmdd: string;
  customPrompt?: string;
  modelArgs?: string[];
}): Promise<NamingDecision> {
  const systemPrompt = buildSystemPrompt(input.customPrompt, input.mmdd, input.forbidden);

  const args = [
    "-p",
    ...(input.modelArgs ?? []),
    "--no-tools",
    "--no-extensions",
    "--no-session",
    "--no-mcp",
    "--no-skills",
    "--no-context-files",
    "--thinking",
    "off",
    "--system-prompt",
    systemPrompt,
    "--",
    input.context,
  ];

  return new Promise<NamingDecision>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (decision: NamingDecision): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(decision);
    };

    // execFile 在当前环境会让 pi 的子进程一直占用 stdio 导致假死；spawn 正常。
    const child = spawn(PI_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      console.error(`[${PLUGIN_ID}] pi 调用超时 ${PI_TIMEOUT_MS}ms，保留原名`);
      finish({ decided: false });
    }, PI_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) child.kill("SIGKILL");
    });
    child.on("error", (error) => {
      console.error(`[${PLUGIN_ID}] pi 启动失败: ${error.message}`);
      finish({ decided: false });
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        console.error(
          `[${PLUGIN_ID}] pi 退出 code=${code} signal=${signal}; stderr=${stderr.slice(0, 300)}`,
        );
        finish({ decided: false });
        return;
      }
      finish(parseDecision(stdout, input.forbidden, input.mmdd));
    });
  });
}

/** 供自测调用：单纯校验解析逻辑，不启动 pi */
export function __parseDecisionForTest(
  raw: string,
  forbidden: string[] = [],
  mmdd = "0101",
): NamingDecision {
  return parseDecision(raw, forbidden, mmdd);
}
