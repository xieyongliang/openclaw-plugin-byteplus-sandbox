/**
 * SandboxBackendManager for the BytePlus VeFaaS sandbox.
 *
 * Core passes a SandboxRegistryEntry where:
 *   entry.containerName = our runtimeId ("byteplus-<sandboxId>")
 *   entry.image         = our configLabel (endpoint / sandboxId)
 *
 * SandboxRegistryEntry is an internal core type not exported by plugin-sdk,
 * so we let TypeScript infer it from the SandboxBackendManager interface.
 */

import type {
  OpenClawConfig,
  SandboxBackendManager,
  SandboxBackendRuntimeInfo,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedByteplusSandboxConfig } from "./config.js";
import { resolveVeFaaSCredentials } from "./config.js";
import { ensureCloudSandboxReady, type CloudSandboxConfig } from "./cloud.js";
import { killVeFaaSSandbox } from "./vefaas-lifecycle.js";

/** Extract sandboxId from runtimeId "byteplus-<sandboxId>" */
function extractSandboxId(containerName: string): string | null {
  const prefix = "byteplus-";
  return containerName.startsWith(prefix) ? containerName.slice(prefix.length) : null;
}

export function createByteplusSandboxManager(
  cfg: ResolvedByteplusSandboxConfig,
): SandboxBackendManager {
  return {
    async describeRuntime(params): Promise<SandboxBackendRuntimeInfo> {
      const { entry } = params as { entry: { containerName: string; image: string }; config: OpenClawConfig };
      const sandboxId = extractSandboxId(entry.containerName);

      if (!sandboxId || !cfg.endpoint) {
        return { running: false, actualConfigLabel: entry.image, configLabelMatch: false };
      }

      const cloudCfg: CloudSandboxConfig = {
        endpoint: cfg.endpoint,
        sandboxId,
        workdir: cfg.workdir,
        token: cfg.token,
      };

      const expectedLabel = `${cfg.endpoint} / ${sandboxId}`;

      try {
        await ensureCloudSandboxReady(cloudCfg, AbortSignal.timeout(10_000));
        return {
          running: true,
          actualConfigLabel: expectedLabel,
          configLabelMatch: entry.image === expectedLabel,
        };
      } catch {
        return { running: false, actualConfigLabel: expectedLabel, configLabelMatch: false };
      }
    },

    async removeRuntime(params): Promise<void> {
      const { entry } = params as { entry: { containerName: string }; config: OpenClawConfig };
      const sandboxId = extractSandboxId(entry.containerName);
      if (!sandboxId) return;

      const creds = resolveVeFaaSCredentials(cfg);
      if (creds) {
        await killVeFaaSSandbox(creds, sandboxId);
      }
    },
  };
}
