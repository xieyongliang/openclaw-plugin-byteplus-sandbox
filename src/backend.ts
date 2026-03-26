/**
 * BytePlus Volcengine Sandbox backend implementation.
 *
 * Lifecycle pattern inspired by openclaw-dev/src/agents/sandbox/docker.ts:
 * - Idempotent ensureInstance() with configHash comparison
 * - Cached promise to coalesce concurrent ensure calls
 *
 * SSH execution pattern follows extensions/openshell/src/backend.ts.
 */

import crypto from "node:crypto";
import type {
  CreateSandboxBackendParams,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendHandle,
  SshSandboxSession,
} from "openclaw/plugin-sdk/sandbox";
import {
  buildExecRemoteCommand,
  buildRemoteCommand,
  createRemoteShellSandboxFsBridge,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  runSshSandboxCommand,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedByteplusSandboxConfig } from "./config.js";
import { maybePruneSandboxes } from "./prune.js";
import {
  getRegistryEntry,
  touchRegistryEntry,
  upsertRegistryEntry,
} from "./registry.js";
import { autoSetup } from "./setup.js";
import type { SandboxNetworkSetup } from "./setup.js";
import type { SshEndpoint } from "./volcengine-client.js";
import { VolcengineClient } from "./volcengine-client.js";

// ---- Helpers -----------------------------------------------------------------

type PendingExec = { sshSession: SshSandboxSession };

/**
 * Derive a deterministic, short instance name from a scopeKey.
 * Volcengine ECS instance names: max 128 chars, alphanumeric + hyphens.
 */
export function buildInstanceName(prefix: string, scopeKey: string): string {
  const hash = crypto.createHash("sha1").update(scopeKey).digest("hex").slice(0, 10);
  return `${prefix}-${hash}`;
}

/** Stable config hash used to detect stale instances (image change). */
function buildConfigHash(cfg: ResolvedByteplusSandboxConfig): string {
  return crypto
    .createHash("sha1")
    .update(`${cfg.image}|${cfg.instanceType}|${cfg.region}`)
    .digest("hex")
    .slice(0, 12);
}

// ---- Factory -----------------------------------------------------------------

export function createByteplusSandboxFactory(
  cfg: ResolvedByteplusSandboxConfig,
): SandboxBackendFactory {
  return async (params: CreateSandboxBackendParams) =>
    createByteplusSandboxHandle(cfg, params);
}

// ---- Handle implementation ---------------------------------------------------

async function createByteplusSandboxHandle(
  cfg: ResolvedByteplusSandboxConfig,
  createParams: CreateSandboxBackendParams,
): Promise<SandboxBackendHandle> {
  const impl = new BPSandboxImpl(cfg, createParams);
  await impl.ensureInstance(); // Provision instance early so SSH is ready by first tool call

  return {
    id: "byteplus",
    runtimeId: impl.instanceName,
    runtimeLabel: impl.instanceName,
    workdir: cfg.remoteWorkspaceDir,
    configLabel: cfg.image,
    configLabelKind: "Image",

    buildExecSpec: async ({ command, workdir, env, usePty }) => {
      const pending = await impl.prepareExec({ command, workdir, env, usePty });
      return {
        argv: pending.argv,
        env: process.env as NodeJS.ProcessEnv,
        stdinMode: "pipe-open" as const,
        finalizeToken: pending.token,
      };
    },

    finalizeExec: async ({ token }) => {
      await impl.finalizeExec(token as PendingExec | undefined);
    },

    runShellCommand: async (params) => impl.runShellCommand(params),

    createFsBridge: ({ sandbox }) =>
      createRemoteShellSandboxFsBridge({
        sandbox,
        runtime: {
          remoteWorkspaceDir: cfg.remoteWorkspaceDir,
          remoteAgentWorkspaceDir: `${cfg.remoteWorkspaceDir}/.agent`,
          runRemoteShellScript: async (p) => impl.runShellCommand(p),
        },
      }),
  };
}

// ---- Implementation class ----------------------------------------------------

class BPSandboxImpl {
  readonly instanceName: string;
  private readonly configHash: string;
  private readonly client: VolcengineClient;
  private ensurePromise: Promise<SshEndpoint> | null = null;
  private sshEndpoint: SshEndpoint | null = null;
  /** Resolved after first ensureInstance() call — contains VPC/subnet/SG/key data. */
  private networkSetup: SandboxNetworkSetup | null = null;

  constructor(
    private readonly cfg: ResolvedByteplusSandboxConfig,
    private readonly createParams: CreateSandboxBackendParams,
  ) {
    this.instanceName = buildInstanceName(cfg.containerPrefix, createParams.scopeKey);
    this.configHash = buildConfigHash(cfg);
    this.client = new VolcengineClient(cfg.accessKeyId, cfg.secretAccessKey, cfg.region);
  }

  async ensureInstance(): Promise<SshEndpoint> {
    if (this.ensurePromise) return this.ensurePromise;
    this.ensurePromise = this.ensureInstanceInner().catch((err) => {
      this.ensurePromise = null;
      throw err;
    });
    return this.ensurePromise;
  }

  private async ensureInstanceInner(): Promise<SshEndpoint> {
    // Auto-provision VPC/subnet/security group/SSH key pair on first use.
    // Mirrors how openclaw-dev's Docker sandbox requires only `image` and
    // handles environment setup automatically.
    this.networkSetup = await autoSetup(this.cfg);

    // Opportunistic prune of idle/old instances (debounced to every 5 min)
    await maybePruneSandboxes(this.client, {
      idleHours: this.cfg.idleHours,
      maxAgeDays: this.cfg.maxAgeDays,
    });

    const existing = await getRegistryEntry(this.instanceName);

    if (existing) {
      // Check if the image/config changed — if so, recreate
      if (existing.configHash !== this.configHash) {
        await this.deleteInstance(existing.instanceId);
        await upsertRegistryEntry({
          scopeKey: this.instanceName,
          instanceId: "",
          image: this.cfg.image,
          configHash: this.configHash,
          createdAtMs: Date.now(),
          lastUsedAtMs: Date.now(),
        });
      } else {
        // Try to reuse existing instance
        const state = await this.client.describeInstanceState(existing.instanceId);
        if (state === "Running") {
          await touchRegistryEntry(this.instanceName);
          const endpoint = await this.client.getSshEndpoint(existing.instanceId);
          this.sshEndpoint = endpoint;
          return endpoint;
        }
        if (state === "Stopped") {
          await this.client.startInstance(existing.instanceId);
          const endpoint = await this.client.waitForRunning(
            existing.instanceId,
            this.cfg.timeoutSeconds,
          );
          await touchRegistryEntry(this.instanceName);
          this.sshEndpoint = endpoint;
          return endpoint;
        }
        // Starting/Stopping — wait for it
        if (state === "Starting" || state === "Stopping") {
          const endpoint = await this.client.waitForRunning(
            existing.instanceId,
            this.cfg.timeoutSeconds,
          );
          await touchRegistryEntry(this.instanceName);
          this.sshEndpoint = endpoint;
          return endpoint;
        }
        // NotFound — fall through to create
      }
    }

    // Create a new instance using auto-resolved network config
    const net = this.networkSetup;
    const instanceId = await this.client.createInstance({
      instanceName: this.instanceName,
      image: this.cfg.image,
      instanceType: this.cfg.instanceType,
      vpcId: net.vpcId,
      subnetId: net.subnetId,
      securityGroupId: net.securityGroupId,
      keyPairName: net.keyPairName,
    });

    await upsertRegistryEntry({
      scopeKey: this.instanceName,
      instanceId,
      image: this.cfg.image,
      configHash: this.configHash,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
    });

    const endpoint = await this.client.waitForRunning(instanceId, this.cfg.timeoutSeconds);
    this.sshEndpoint = endpoint;
    return endpoint;
  }

  private async deleteInstance(instanceId: string): Promise<void> {
    try {
      await this.client.deleteInstance(instanceId);
    } catch {
      // Best-effort deletion; continue even if it fails
    }
  }

  private async createSshSession(): Promise<SshSandboxSession> {
    const endpoint = this.sshEndpoint ?? (await this.ensureInstance());
    // sshPrivateKey is always available after ensureInstance() has run (via networkSetup)
    const privateKey = this.networkSetup?.sshPrivateKey ?? this.cfg.sshPrivateKey ?? "";
    return createSshSandboxSessionFromSettings({
      command: "ssh",
      target: `${this.cfg.sshUser}@${endpoint.host}`,
      strictHostKeyChecking: false,
      updateHostKeys: false,
      identityData: privateKey,
    });
  }

  async prepareExec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<{ argv: string[]; token: PendingExec }> {
    await this.ensureInstance();
    const sshSession = await this.createSshSession();
    const remoteCommand = buildExecRemoteCommand({
      command: params.command,
      workdir: params.workdir ?? this.cfg.remoteWorkspaceDir,
      env: params.env,
    });
    return {
      argv: [
        "ssh",
        "-F",
        sshSession.configPath,
        ...(params.usePty
          ? ["-tt", "-o", "RequestTTY=force", "-o", "SetEnv=TERM=xterm-256color"]
          : ["-T", "-o", "RequestTTY=no"]),
        sshSession.host,
        remoteCommand,
      ],
      token: { sshSession },
    };
  }

  async finalizeExec(token?: PendingExec): Promise<void> {
    if (token?.sshSession) {
      await disposeSshSandboxSession(token.sshSession);
    }
  }

  async runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult> {
    await this.ensureInstance();
    const session = await this.createSshSession();
    try {
      return await runSshSandboxCommand({
        session,
        remoteCommand: buildRemoteCommand([
          "/bin/sh",
          "-c",
          params.script,
          "openclaw-byteplus-sandbox",
          ...(params.args ?? []),
        ]),
        stdin: params.stdin,
        allowFailure: params.allowFailure,
        signal: params.signal,
      });
    } finally {
      await disposeSshSandboxSession(session);
    }
  }
}
