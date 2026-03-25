/**
 * BytePlus Volcengine Sandbox backend manager.
 *
 * Implements SandboxBackendManager for the "byteplus" backend ID.
 * Called by OpenClaw core's `openclaw sandbox` CLI and status commands.
 */

import type {
  SandboxBackendManager,
  SandboxBackendRuntimeInfo,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedByteplusSandboxConfig } from "./config.js";
import { getRegistryEntry, removeRegistryEntry } from "./registry.js";
import { VolcengineClient } from "./volcengine-client.js";

/**
 * Create the SandboxBackendManager for the BytePlus sandbox.
 *
 * Note: `entry.containerName` is used as the `instanceName` key because
 * OpenClaw core's SandboxRegistryEntry stores `containerName` = our
 * `runtimeId` (which we set to the instance name in backend.ts).
 */
export function createByteplusSandboxManager(
  cfg: ResolvedByteplusSandboxConfig,
): SandboxBackendManager {
  const client = new VolcengineClient(cfg.accessKeyId, cfg.secretAccessKey, cfg.region);

  return {
    async describeRuntime({ entry }): Promise<SandboxBackendRuntimeInfo> {
      // entry.containerName = our instanceName (used as scopeKey in our registry)
      const registryEntry = await getRegistryEntry(entry.containerName);

      if (!registryEntry) {
        return {
          running: false,
          actualConfigLabel: undefined,
          configLabelMatch: false,
        };
      }

      const state = await client.describeInstanceState(registryEntry.instanceId).catch(() => "NotFound" as const);

      return {
        running: state === "Running",
        actualConfigLabel: registryEntry.image,
        configLabelMatch: registryEntry.image === cfg.image,
      };
    },

    async removeRuntime({ entry }): Promise<void> {
      const registryEntry = await getRegistryEntry(entry.containerName);
      if (!registryEntry) return;

      await client.deleteInstance(registryEntry.instanceId).catch(() => {
        // Best-effort deletion — log but don't throw
      });
      await removeRegistryEntry(entry.containerName);
    },
  };
}
