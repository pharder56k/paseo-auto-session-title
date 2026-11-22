import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 默认提示词。用户可在设置页整段改写；
 * {MMDD} 会在运行时替换为会话 createdAt 按 Asia/Shanghai 得到的月日。
 */
export const DEFAULT_PROMPT = `你是会话标题提炼器。请根据会话的多轮对话内容，生成适合左侧栏显示的标题。

会话创建日期（Asia/Shanghai，MMDD）：{MMDD}

严格规则：
1. 标题格式统一为：MMDD｜类型｜主题（全角竖线，前后不加空格）
2. 类型必须且只能从以下 8 个词中选择一个：功能、设计、修复、优化、发布、探索、文档、研究
3. 主题必须根据对话实际内容提炼，简洁具体，长度 4~16 个汉字（或 8~28 个英文/数字字符），适合左侧栏显示。
4. 主题中禁止出现项目名/目录名（下方会列出）。
5. 主题不要重复“类型”中已经表达的动词（例如类型为“优化”时，写“批次文字显示”，不要写“优化批次文字显示”）。
6. 主题中禁止包含换行、引号或 Markdown 标记。
7. 如果对话内容只是打招呼、简单确认、或信息不足无法准确判断主题，不要猜测，返回 {"decided": false}。
8. “原始标题”只是弱参考；当它与实际对话内容不一致时，以实际对话内容为准。

参考示例（{MMDD} 表示会话创建日的月日）：
- 原始标题：优化批次文字显示 → {"decided": true, "title": "{MMDD}｜优化｜批次文字显示"}
- 原始标题：整合快捷键提示页面 → {"decided": true, "title": "{MMDD}｜功能｜整合快捷键提示页"}
- 原始标题：提交代码到 GitHub → {"decided": true, "title": "{MMDD}｜发布｜提交代码到GitHub"}
- 原始标题：新功能讨论（实际对话在讨论界面对齐） → {"decided": true, "title": "{MMDD}｜设计｜界面对齐检查"}

只输出一行合法 JSON，不要输出 Markdown 代码块或任何解释：
{"decided": true, "title": "最终标题"} 或 {"decided": false}`;

export const namingSettings = defineSettings({
  id: "naming",
  scope: "host",
  version: 1,
  schema: z.object({
    /** 连续空闲多少秒后自动改名 */
    idleSeconds: z.number().int().min(5).max(3600).default(45),
    /** default = 本机 pi 默认模型；follow-agent = 跟随本轮会话主模型；fixed = 固定模型 */
    modelMode: z.enum(["default", "follow-agent", "fixed"]).default("default"),
    /** modelMode=fixed 时使用的模型 ID，例如 deepseek/deepseek-flash */
    fixedModel: z.string().max(200).default(""),
    /** 整段自定义的命名提示词，{MMDD} 会替换为创建日期 */
    customPrompt: z.string().max(8000).default(DEFAULT_PROMPT),
    /** 同步重命名所属 workspace，让手机侧栏直接显示新标题 */
    syncWorkspaceTitle: z.boolean().default(true),
  }),
});

export type NamingSettingsValues = z.infer<typeof namingSettings.schema>;

/** 手动/自动触发：扫描已有会话并安排空闲改名 */
export const scanRpc = defineRpc({
  name: "naming.scan",
  input: z.object({}),
  output: z.object({ scanned: z.number(), scheduled: z.number() }),
});
