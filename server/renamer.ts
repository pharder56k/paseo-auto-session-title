import { PASEO_BIN, PLUGIN_ID, RENAME_TIMEOUT_MS } from "./config";
import { startCommand } from "./binaries";

/**
 * 只改对话标题：paseo agent update <id> --name <title>
 * 不传 --label、不改项目名/内容/归属/排序/置顶/归档状态。
 */
export async function renameAgent(agentId: string, title: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (ok: boolean, reason?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (ok) {
        console.log(`[${PLUGIN_ID}] 已改名 agent=${agentId} -> ${title}`);
      } else {
        console.error(
          `[${PLUGIN_ID}] 改名失败 agent=${agentId}: ${reason ?? ""} ${stderr.slice(0, 300)}`.trim(),
        );
      }
      resolve(ok);
    };

    // spawn instead of execFile: a child that keeps stdio open must not hang the
    // rename step, and the 10s timeout must always settle the promise.
    const child = startCommand(PASEO_BIN, ["agent", "update", agentId, "--name", title]);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, `timeout ${RENAME_TIMEOUT_MS}ms`);
    }, RENAME_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish(false, error.message));
    child.on("close", (code, signal) => {
      if (code !== 0) {
        finish(false, `exit code=${code} signal=${signal}`);
        return;
      }
      void stdout;
      finish(true);
    });
  });
}
