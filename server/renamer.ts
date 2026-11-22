import { execFile } from "node:child_process";
import { PASEO_BIN, PLUGIN_ID, RENAME_TIMEOUT_MS } from "./config";

/**
 * 只改对话标题：paseo agent update <id> --name <title>
 * 不传 --label、不改项目名/内容/归属/排序/置顶/归档状态。
 */
export async function renameAgent(agentId: string, title: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile(
      PASEO_BIN,
      ["agent", "update", agentId, "--name", title],
      { timeout: RENAME_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          console.error(
            `[${PLUGIN_ID}] 改名失败 agent=${agentId}: ${error.message}; stderr=${String(stderr ?? "").slice(0, 300)}`,
          );
          resolve(false);
          return;
        }
        console.log(`[${PLUGIN_ID}] 已改名 agent=${agentId} -> ${title}`);
        void stdout;
        resolve(true);
      },
    );
  });
}
