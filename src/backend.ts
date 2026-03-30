/**
 * BytePlus VeFaaS cloud sandbox backend implementation.
 *
 * Uses HTTP REST through Volcengine API Gateway — no SSH needed.
 * Mirrors openclaw-dev/src/agents/sandbox/context.ts cloud path.
 *
 * Lifecycle:
 *   1. If config has endpoint + sandboxId → connect directly
 *   2. If config has functionId + credentials → auto-create VeFaaS sandbox
 *   3. Registry persists sandboxId across restarts so the same instance is reused
 */

import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SandboxFsBridge,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedByteplusSandboxConfig } from "./config.js";
import { resolveVeFaaSCredentials } from "./config.js";
import type { CloudSandboxConfig } from "./cloud.js";
import { cloudExec, cloudExecRaw, ensureCloudSandboxReady } from "./cloud.js";
import { createCloudSandboxFsBridge } from "./cloud-fs-bridge.js";
import {
  deleteRegistryEntry,
  getRegistryEntry,
  touchRegistryEntry,
  upsertRegistryEntry,
} from "./registry.js";
import { createVeFaaSSandbox, killVeFaaSSandbox } from "./vefaas-lifecycle.js";

// ── Factory ────────────────────────────────────────────────────────────

export function createByteplusSandboxFactory(
  cfg: ResolvedByteplusSandboxConfig,
): SandboxBackendFactory {
  return async (params: CreateSandboxBackendParams) => createByteplusSandboxHandle(cfg, params);
}

// ── Handle ─────────────────────────────────────────────────────────────

async function createByteplusSandboxHandle(
  cfg: ResolvedByteplusSandboxConfig,
  createParams: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const impl = new VeFaaSBackendImpl(cfg, createParams);
  await impl.ensureReady();

  const cloudCfg = impl.cloudConfig;

  return {
    id: "byteplus",
    runtimeId: `byteplus-${cloudCfg.sandboxId}`,
    runtimeLabel: `byteplus/${cloudCfg.sandboxId}`,
    workdir: cfg.workdir,
    configLabel: `${cfg.endpoint ?? "auto"} / ${cloudCfg.sandboxId}`,
    configLabelKind: "Image" as const,

    /**
     * buildExecSpec: returns a node --eval command that proxies the shell command
     * through the API Gateway HTTP endpoint. Not streaming, but functional.
     */
    buildExecSpec: async ({ command, workdir, env }) => {
      const execPayload = buildInlineExecScript(cloudCfg, command, workdir, env);
      // Pass only the minimal env vars needed to run a Node.js child process.
      // Deliberately avoids forwarding the full process.env to prevent leaking
      // credentials or other secrets into the sandboxed exec context.
      const minimalEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_PATH: process.env.NODE_PATH,
      };
      return {
        argv: ["node", "--input-type=module", "--eval", execPayload],
        env: minimalEnv,
        stdinMode: "pipe-open" as const,
        finalizeToken: undefined,
      };
    },

    finalizeExec: async (_params: {
      status: "completed" | "failed";
      exitCode: number | null;
      timedOut: boolean;
      token?: unknown;
    }) => {},

    runShellCommand: async (params) => impl.runShellCommand(params),

    createFsBridge: (): SandboxFsBridge =>
      createCloudSandboxFsBridge({
        cloud: cloudCfg,
        workspaceDir: cfg.workdir,
        containerWorkdir: cfg.workdir,
      }) as SandboxFsBridge,
  };
}

// ── Implementation class ───────────────────────────────────────────────

class VeFaaSBackendImpl {
  private _cloudConfig: CloudSandboxConfig | null = null;
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly cfg: ResolvedByteplusSandboxConfig,
    private readonly createParams: CreateSandboxBackendParams,
  ) {}

  get cloudConfig(): CloudSandboxConfig {
    if (!this._cloudConfig) throw new Error("VeFaaS backend not initialized — call ensureReady()");
    return this._cloudConfig;
  }

  async ensureReady(): Promise<void> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureReadyInner().catch((err) => {
      this.ensurePromise = null;
      throw err;
    });
    return this.ensurePromise;
  }

  private async ensureReadyInner(): Promise<void> {
    const scopeKey = this.createParams.scopeKey;

    // -- Step 1: resolve endpoint + sandboxId --------------------------------

    let endpoint = this.cfg.endpoint;
    let sandboxId = this.cfg.sandboxId;

    if (!sandboxId) {
      // Check registry first (persist across restarts)
      const cached = await getRegistryEntry(scopeKey);
      if (cached) {
        sandboxId = cached.sandboxId;
      }
    }

    if (!sandboxId) {
      // Auto-create via VeFaaS API
      const creds = resolveVeFaaSCredentials(this.cfg);
      if (!creds) {
        throw new Error(
          "BytePlus Sandbox: no sandbox available. " +
            "Provide endpoint + sandboxId to connect to an existing sandbox, " +
            "or functionId + BYTEPLUS_ACCESS_KEY_ID + BYTEPLUS_SECRET_ACCESS_KEY to auto-create one.",
        );
      }
      sandboxId = await createVeFaaSSandbox(creds);

      // Register auto-created sandbox for cleanup on exit
      registerCleanup(this.cfg, sandboxId);
    }

    if (!endpoint) {
      throw new Error(
        "BytePlus Sandbox: config.endpoint is required. " +
          "Set it to the BytePlus API Gateway URL for your VeFaaS function, e.g. " +
          '"https://xxx.apigateway-ap-southeast-1.apigw-byteplus.com".',
      );
    }

    // Persist to registry
    await upsertRegistryEntry({
      scopeKey,
      sandboxId,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
    });

    // -- Step 2: build CloudSandboxConfig ------------------------------------

    this._cloudConfig = {
      endpoint,
      sandboxId,
      workdir: this.cfg.workdir,
      token: this.cfg.token ?? undefined,
    };

    // -- Step 3: verify sandbox is reachable --------------------------------

    await ensureCloudSandboxReady(this._cloudConfig);
    await touchRegistryEntry(scopeKey);
  }

  async runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult> {
    await this.ensureReady();
    const cfg = this.cloudConfig;

    try {
      const result = await cloudExecRaw({
        config: cfg,
        script: params.script,
        args: params.args,
        stdin: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      };
    } catch (err) {
      if (params.allowFailure) {
        return {
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(String(err)),
          exitCode: 1,
        };
      }
      throw err;
    }
  }
}

// ── buildExecSpec inline script ────────────────────────────────────────

/**
 * Build an inline Node.js module script that calls cloudExec over HTTP and
 * writes the output to process.stdout, then exits with the command exit code.
 *
 * This is used by `buildExecSpec` so the core can spawn it as a child process.
 * Output is batch (not streaming), but functional for non-PTY commands.
 */
function buildInlineExecScript(
  cloud: CloudSandboxConfig,
  command: string,
  workdir: string | undefined,
  env: Record<string, string>,
): string {
  const envStr = Object.entries(env ?? {})
    .map(([k, v]) => `export ${JSON.stringify(k)}=${JSON.stringify(v)}`)
    .join("; ");
  const fullCmd = envStr ? `${envStr}; ${command}` : command;

  const payload = JSON.stringify({
    endpoint: cloud.endpoint,
    sandboxId: cloud.sandboxId,
    token: cloud.token ?? null,
    command: fullCmd,
    workdir: workdir ?? cloud.workdir,
  });

  return `
const { endpoint, sandboxId, token, command, workdir } = ${payload};
const base = endpoint.replace(/\\/+$/, "");
const url = new URL(base + "/v1/shell/exec");
url.searchParams.set("faasInstanceName", sandboxId);
const headers = { "Content-Type": "application/json" };
if (token) headers["Authorization"] = "Bearer " + token;
const body = JSON.stringify({ command: "cd " + JSON.stringify(workdir) + " && " + command, timeout: 300 });
const r = await fetch(url.toString(), { method: "POST", headers, body });
if (!r.ok) {
  process.stderr.write("HTTP " + r.status + "\\n");
  process.exit(1);
}
const j = await r.json();
if (!j.success) {
  process.stderr.write(j.message || "exec failed");
  process.exit(1);
}
if (j.data?.output) process.stdout.write(j.data.output);
process.exit(j.data?.exit_code ?? 0);
`.trim();
}

// ── Process-exit cleanup ───────────────────────────────────────────────

type CleanupEntry = { cfg: ResolvedByteplusSandboxConfig; sandboxId: string };
const pendingCleanups: CleanupEntry[] = [];
let cleanupRegistered = false;

function registerCleanup(cfg: ResolvedByteplusSandboxConfig, sandboxId: string): void {
  pendingCleanups.push({ cfg, sandboxId });
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const runCleanup = () => {
    const creds = resolveVeFaaSCredentials(cfg);
    if (!creds) return;
    for (const item of pendingCleanups) {
      const itemCreds = resolveVeFaaSCredentials(item.cfg);
      if (itemCreds) {
        killVeFaaSSandbox(itemCreds, item.sandboxId).catch(() => {});
        deleteRegistryEntry(item.sandboxId).catch(() => {});
      }
    }
  };

  process.on("beforeExit", runCleanup);
  process.on("SIGINT", () => { runCleanup(); process.exit(130); });
  process.on("SIGTERM", () => { runCleanup(); process.exit(143); });
}
