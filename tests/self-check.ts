// Self-check for auto-session-title server helpers.
// Node refuses extensionless imports inside server/*.ts, so register a
// resolver before dynamically importing the real modules. Run:
//   node --experimental-strip-types tests/self-check.ts
// @ts-nocheck

import { registerHooks } from "node:module";

function needsTypeScriptExtension(specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  const base = specifier.split("/").pop() ?? specifier;
  return !base.includes(".");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (needsTypeScriptExtension(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const serverDir = new URL("../server/", import.meta.url);
const dateMod = await import(new URL("date-mmdd.ts", serverDir).href);
const contextMod = await import(new URL("context-extract.ts", serverDir).href);
const summarizerMod = await import(new URL("summarizer.ts", serverDir).href);
const settingsMod = await import(new URL("../shared/settings.ts", import.meta.url).href);

const { createdAtToMMDD, deriveInitialAgentTitle } = dateMod;
const { extractFirstUserText, extractContext, forbiddenNames } = contextMod;
const { __parseDecisionForTest } = summarizerMod;
const { DEFAULT_PROMPT, namingSettings } = settingsMod;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
    return;
  }
  failed += 1;
  const message = detail ? `${name} — ${detail}` : name;
  failures.push(message);
  console.error(`FAIL ${message}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const same = Object.is(actual, expected);
  check(name, same, same ? "" : `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

// --- createdAtToMMDD: fixed ISO only, no clock ---

eq(
  "createdAt 2026-09-03T00:30:00.000Z is 0903",
  createdAtToMMDD("2026-09-03T00:30:00.000Z"),
  "0903",
);
eq(
  "createdAt 2026-09-02T16:30:00.000Z is 0903",
  createdAtToMMDD("2026-09-02T16:30:00.000Z"),
  "0903",
);
eq(
  "createdAt 2026-11-09T16:00:00.000Z is 1110",
  createdAtToMMDD("2026-11-09T16:00:00.000Z"),
  "1110",
);
eq("createdAt empty string is null", createdAtToMMDD(""), null);
eq("createdAt null is null", createdAtToMMDD(null), null);
eq("createdAt undefined is null", createdAtToMMDD(undefined), null);
eq("createdAt invalid is null", createdAtToMMDD("not-a-date"), null);
eq("createdAt whitespace is null", createdAtToMMDD("   "), null);

// --- deriveInitialAgentTitle ---

eq(
  "derive skips blank lines and collapses whitespace",
  deriveInitialAgentTitle("\n\n  \n\thello \t  world  \nsecond line"),
  "hello world",
);
eq("derive empty string is null", deriveInitialAgentTitle(""), null);
eq("derive blank lines only is null", deriveInitialAgentTitle("  \n\t\n   "), null);
eq("derive null is null", deriveInitialAgentTitle(null), null);
eq("derive undefined is null", deriveInitialAgentTitle(undefined), null);

const sixty = "字".repeat(60);
eq(
  "derive clamps to 60 chars",
  deriveInitialAgentTitle(`${"字".repeat(80)}\nignored`),
  sixty,
);
eq(
  "derive keeps a short first line",
  deriveInitialAgentTitle("  only-this  \nnot-this"),
  "only-this",
);

// --- context-extract ---

const earlyA = "早期用户甲独特标记ALPHA";
const earlyB = "早期用户乙独特标记BETA";
const recentUser = "最近用户消息标记RECENTUSER";
const recentAssistant = "最近助手消息标记RECENTASSIST";
const dropped = "中间被窗口丢掉的标记DROPPED";
const fencedCode = "const secretToken = 42;";

const entries = [
  { item: { type: "assistant_message", text: "助手先开口不应算第一条用户" } },
  { item: { type: "user_message", text: `请看代码\n\`\`\`js\n${fencedCode}\n\`\`\`\n${earlyA}` } },
  { item: { type: "assistant_message", text: dropped } },
  { item: { type: "user_message", text: earlyB } },
  { item: { type: "assistant_message", text: "填充一" } },
  { item: { type: "assistant_message", text: "填充二" } },
  { item: { type: "assistant_message", text: "填充三" } },
  { item: { type: "assistant_message", text: "填充四" } },
  { item: { type: "assistant_message", text: "填充五" } },
  { item: { type: "assistant_message", text: "填充六" } },
  { item: { type: "user_message", text: recentUser } },
  { item: { type: "assistant_message", text: recentAssistant } },
];

const firstUser = extractFirstUserText(entries);
check("extractFirstUserText returns first user text", typeof firstUser === "string" && firstUser.includes(earlyA));
check(
  "extractFirstUserText skips earlier assistant",
  typeof firstUser === "string" && !firstUser.includes("助手先开口"),
);
check(
  "code fences become [代码片段]",
  typeof firstUser === "string" && firstUser.includes("[代码片段]") && !firstUser.includes(fencedCode) && !firstUser.includes("```"),
);

const originalTitle = "旧标题-批次文字";
const context = extractContext(entries, originalTitle);
check("extractContext includes original title", context.includes(originalTitle));
check("extractContext includes early user text", context.includes(earlyA) && context.includes(earlyB));
check(
  "extractContext includes recent messages",
  context.includes(recentUser) && context.includes(recentAssistant),
);
check(
  "extractContext code fences become [代码片段]",
  context.includes("[代码片段]") && !context.includes(fencedCode),
);

const names = forbiddenNames("/home/harder/paseo-auto-title");
check(
  "forbiddenNames includes paseo-auto-title",
  Array.isArray(names) && names.includes("paseo-auto-title"),
  JSON.stringify(names),
);
check(
  "forbiddenNames does not include hidden dot parts",
  Array.isArray(names) && names.every((part) => !part.startsWith(".")),
  JSON.stringify(names),
);
const hiddenPathNames = forbiddenNames("/home/harder/.paseo/paseo-auto-title");
check(
  "forbiddenNames drops dot segments",
  hiddenPathNames.includes("paseo-auto-title") && !hiddenPathNames.some((part) => part.startsWith(".")),
  JSON.stringify(hiddenPathNames),
);

// CLI / 其它 agent 发来的用户消息以 tool_call.agentMessage 形式出现
const agentMessageEntries = [
  {
    item: {
      type: "tool_call",
      name: "paseo-agent-message",
      agentMessage: { event: "message", text: "再来一轮新主题PLAYWRIGHT" },
      detail: { type: "plain_text", text: "再来一轮新主题PLAYWRIGHT" },
    },
  },
  { item: { type: "assistant_message", text: "助手回复XYZ" } },
];
eq(
  "extractFirstUserText reads tool_call.agentMessage.text",
  extractFirstUserText(agentMessageEntries),
  "再来一轮新主题PLAYWRIGHT",
);
check(
  "extractContext includes agent-message user text",
  extractContext(agentMessageEntries, "旧标题").includes("再来一轮新主题PLAYWRIGHT"),
);

// --- __parseDecisionForTest ---

function parse(raw: string, forbidden: string[] = []) {
  return __parseDecisionForTest(raw, forbidden);
}

const valid = parse('{"decided": true, "type": "优化", "topic": "批次文字显示"}');
check("valid 优化/批次文字显示 decided true", valid.decided === true);
check(
  "valid decision keeps type and topic",
  valid.decided === true && valid.type === "优化" && valid.topic === "批次文字显示",
  JSON.stringify(valid),
);

eq(
  "type outside the 8 enum is undecided",
  parse('{"decided": true, "type": "重构", "topic": "批次文字显示"}').decided,
  false,
);
eq(
  "decided false object is undecided",
  parse('{"decided": false, "type": "优化", "topic": "批次文字显示"}').decided,
  false,
);

const fenced = parse(
  '```json\n{"decided": true, "type": "优化", "topic": "批次文字显示"}\n```',
);
check(
  "markdown fenced JSON still parses",
  fenced.decided === true && fenced.type === "优化" && fenced.topic === "批次文字显示",
  JSON.stringify(fenced),
);

eq(
  "topic only 优化 after stripping type prefix is undecided",
  parse('{"decided": true, "type": "优化", "topic": "优化优化"}').decided,
  false,
);
eq(
  "topic that is exactly the type word is undecided",
  parse('{"decided": true, "type": "优化", "topic": "优化"}').decided,
  false,
);

const github = parse('{"decided": true, "type": "发布", "topic": "提交代码到GitHub"}', ["GitHub"]);
check(
  "GitHub forbidden name removed and remainder still decided",
  github.decided === true && github.topic === "提交代码到" && !github.topic.includes("GitHub"),
  JSON.stringify(github),
);

const piped = parse('{"decided": true, "type": "优化", "topic": "批次|文字｜显示"}');
check(
  "pipes stripped from topic",
  piped.decided === true &&
    piped.topic === "批次文字显示" &&
    !piped.topic.includes("|") &&
    !piped.topic.includes("｜"),
  JSON.stringify(piped),
);

eq(
  "too-short topic 修复 is undecided",
  parse('{"decided": true, "type": "优化", "topic": "修复"}').decided,
  false,
);

const english = parse('{"decided": true, "type": "探索", "topic": "PlaywrightSpecs"}');
check(
  "English topic of 8+ chars without enough Han is allowed",
  english.decided === true && english.topic === "PlaywrightSpecs",
  JSON.stringify(english),
);

eq(
  "3 Han chars is undecided",
  parse('{"decided": true, "type": "优化", "topic": "三个字"}').decided,
  false,
);

// --- settings & 新版 title 契约 ---

const titled = parse('{"decided": true, "title": "1122｜研究｜Playwright数据隔离"}');
check(
  "title contract returns final title verbatim",
  titled.decided === true && titled.title === "1122｜研究｜Playwright数据隔离",
  JSON.stringify(titled),
);
const multilineTitle = parse('{"decided": true, "title": "1110｜设计｜界面\\n对齐检查"}');
check(
  "title contract collapses newlines",
  multilineTitle.decided === true && !multilineTitle.title.includes("\n"),
  JSON.stringify(multilineTitle),
);
const mmddContext = extractContext(entries, "旧标题", "1110");
check("extractContext includes created MMDD", mmddContext.includes("会话创建日期（MMDD，Asia/Shanghai）：1110"));
check(
  "default prompt has {MMDD} placeholder and all 8 types",
  DEFAULT_PROMPT.includes("{MMDD}") &&
    ["功能", "设计", "修复", "优化", "发布", "探索", "文档", "研究"].every((t) => DEFAULT_PROMPT.includes(t)),
);
const defaults = namingSettings.schema.parse({});
check(
  "settings defaults are idle=45 / default model / prefilled prompt",
  defaults.idleSeconds === 45 &&
    defaults.modelMode === "default" &&
    defaults.fixedModel === "" &&
    defaults.customPrompt === DEFAULT_PROMPT,
  JSON.stringify({ ...defaults, customPrompt: defaults.customPrompt.slice(0, 30) }),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
