import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Resolve an external CLI without assuming a particular user's home directory.
 *
 * Order matters:
 * 1. explicit environment override (already expanded by the caller)
 * 2. the daemon's command path
 * 3. common per-user and system install locations
 * 4. the bare command name, so spawn can still report a useful ENOENT
 *
 * Keeping this pure makes the lookup testable on any host, including hosts with
 * a different OS from the one running the tests.
 */
export interface ResolveExecutableOptions {
  name: string;
  envValue?: string | null;
  pathValue?: string | null;
  home?: string | null;
  platform?: NodeJS.Platform;
  isFile?: (candidate: string) => boolean;
}

function defaultIsFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function executableNames(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [name];
  const base = path.win32.basename(name).replace(/\.exe$/i, "");
  return [`${base}.exe`, base];
}

export function resolveExecutable(options: ResolveExecutableOptions): string {
  const platform = options.platform ?? process.platform;
  const isFile = options.isFile ?? defaultIsFile;
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const names = executableNames(options.name, platform);

  const override = (options.envValue ?? "").trim();
  if (override) return override;

  const delimiter = platform === "win32" ? ";" : ":";
  const directories = (options.pathValue ?? process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }

  const home = (options.home ?? process.env.HOME ?? process.env.USERPROFILE ?? "").trim();
  const fallbackDirectories: string[] = [];
  if (home) {
    fallbackDirectories.push(
      join(home, ".local", "bin"),
      join(home, "bin"),
      join(home, ".npm-global", "bin"),
      join(home, ".pi", "agent", "bin"),
      join(home, ".pi", "bin"),
    );
    if (platform === "win32") {
      fallbackDirectories.push(join(home, "AppData", "Roaming", "npm"));
    }
  }
  if (platform !== "win32") {
    fallbackDirectories.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
  }

  for (const directory of fallbackDirectories) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isFile(candidate)) return candidate;
    }
  }

  return options.name;
}

/** Spawn without a shell: arguments are passed verbatim as an array. */
export function startCommand(bin: string, args: string[]) {
  return spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
}
