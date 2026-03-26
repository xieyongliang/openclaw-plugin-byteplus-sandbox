/**
 * Cloud sandbox file-system bridge.
 *
 * All file operations are performed via shell commands executed on the remote
 * sandbox through the HTTP exec endpoint.
 *
 * Direct port of openclaw-dev/src/agents/sandbox/cloud-fs-bridge.ts
 */

import type { CloudExecRawResult, CloudSandboxConfig } from "./cloud.js";
import { cloudExecRaw } from "./cloud.js";

export type SandboxFsStat = {
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs: number;
};

export type SandboxResolvedPath = {
  hostPath: string;
  relativePath: string;
  containerPath: string;
};

export type CloudSandboxFsBridge = {
  resolvePath(params: { filePath: string; cwd?: string }): SandboxResolvedPath;
  readFile(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<Buffer>;
  writeFile(params: {
    filePath: string;
    cwd?: string;
    data: Buffer | string;
    encoding?: BufferEncoding;
    mkdir?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  mkdirp(params: { filePath: string; cwd?: string; signal?: AbortSignal }): Promise<void>;
  remove(params: {
    filePath: string;
    cwd?: string;
    recursive?: boolean;
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<void>;
  rename(params: {
    from: string;
    to: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  stat(params: {
    filePath: string;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<SandboxFsStat | null>;
};

export function createCloudSandboxFsBridge(params: {
  cloud: CloudSandboxConfig;
  workspaceDir: string;
  containerWorkdir: string;
}): CloudSandboxFsBridge {
  const { cloud, workspaceDir, containerWorkdir } = params;

  function resolveContainerPath(filePath: string, cwd?: string): string {
    if (filePath.startsWith("/")) return filePath;
    const base = cwd ?? workspaceDir;
    return base.endsWith("/") ? `${base}${filePath}` : `${base}/${filePath}`;
  }

  async function runCommand(
    script: string,
    opts: {
      args?: string[];
      stdin?: Buffer | string;
      allowFailure?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<CloudExecRawResult> {
    return cloudExecRaw({
      config: cloud,
      script,
      args: opts.args,
      stdin: opts.stdin,
      allowFailure: opts.allowFailure,
      signal: opts.signal,
    });
  }

  return {
    resolvePath({ filePath, cwd }) {
      const containerPath = resolveContainerPath(filePath, cwd);
      const relative = containerPath.startsWith(containerWorkdir + "/")
        ? containerPath.slice(containerWorkdir.length + 1)
        : containerPath;
      return { hostPath: containerPath, relativePath: relative, containerPath };
    },

    async readFile({ filePath, cwd, signal }) {
      const containerPath = resolveContainerPath(filePath, cwd);
      const result = await runCommand('set -eu; cat -- "$1"', {
        args: [containerPath],
        signal,
      });
      return result.stdout;
    },

    async writeFile({ filePath, cwd, data, encoding, mkdir: mkdirOpt, signal }) {
      const containerPath = resolveContainerPath(filePath, cwd);
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, encoding ?? "utf8");
      const mkdirPrefix =
        mkdirOpt !== false
          ? 'dir=$(dirname -- "$1"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; '
          : "";
      await runCommand(`set -eu; ${mkdirPrefix}cat > "$1"`, {
        args: [containerPath],
        stdin: buffer,
        signal,
      });
    },

    async mkdirp({ filePath, cwd, signal }) {
      const containerPath = resolveContainerPath(filePath, cwd);
      await runCommand('set -eu; mkdir -p -- "$1"', { args: [containerPath], signal });
    },

    async remove({ filePath, cwd, recursive, force, signal }) {
      const containerPath = resolveContainerPath(filePath, cwd);
      const flags = [force === false ? "" : "-f", recursive ? "-r" : ""].filter(Boolean);
      const rmCmd = flags.length > 0 ? `rm ${flags.join(" ")}` : "rm";
      await runCommand(`set -eu; ${rmCmd} -- "$1"`, { args: [containerPath], signal });
    },

    async rename({ from, to, cwd, signal }) {
      const fromPath = resolveContainerPath(from, cwd);
      const toPath = resolveContainerPath(to, cwd);
      await runCommand(
        'set -eu; dir=$(dirname -- "$2"); if [ "$dir" != "." ]; then mkdir -p -- "$dir"; fi; mv -- "$1" "$2"',
        { args: [fromPath, toPath], signal },
      );
    },

    async stat({ filePath, cwd, signal }) {
      const containerPath = resolveContainerPath(filePath, cwd);
      const result = await runCommand('set -eu; stat -c "%F|%s|%Y" -- "$1"', {
        args: [containerPath],
        allowFailure: true,
        signal,
      });
      if (result.code !== 0) {
        const stderr = result.stderr.toString("utf8");
        if (stderr.includes("No such file or directory")) return null;
        const message = stderr.trim() || `stat failed with code ${result.code}`;
        throw new Error(`stat failed for ${containerPath}: ${message}`);
      }
      const text = result.stdout.toString("utf8").trim();
      const [typeRaw, sizeRaw, mtimeRaw] = text.split("|");
      const size = Number.parseInt(sizeRaw ?? "0", 10);
      const mtime = Number.parseInt(mtimeRaw ?? "0", 10) * 1000;
      return {
        type: coerceStatType(typeRaw),
        size: Number.isFinite(size) ? size : 0,
        mtimeMs: Number.isFinite(mtime) ? mtime : 0,
      };
    },
  };
}

function coerceStatType(typeRaw?: string): "file" | "directory" | "other" {
  if (!typeRaw) return "other";
  const n = typeRaw.trim().toLowerCase();
  if (n.includes("directory")) return "directory";
  if (n.includes("file")) return "file";
  return "other";
}
