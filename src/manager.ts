/**
 * SandboxBackendManager for the BytePlus VeFaaS sandbox.
 *
 * describeRuntime: returns sandbox ID and status info
 * removeRuntime: kills the VeFaaS sandbox and removes it from the registry
 */

import type {
  SandboxBackendManager,
  SandboxRuntimeDescriptor,
} from "openclaw/plugin-sdk/sandbox";
import type { ResolvedByteplusSandboxConfig } from "./config.js";
import { resolveVeFaaSCredentials } from "./config.js";
import { deleteRegistryEntry, listRegistryEntries } from "./registry.js";
import { killVeFaaSSandbox } from "./vefaas-lifecycle.js";

export function createByteplusSandboxManager(
  cfg: ResolvedByteplusSandboxConfig,
): SandboxBackendManager {
  return {
    async describeRuntime(runtimeId: string): Promise<SandboxRuntimeDescriptor | null> {
      const entries = await listRegistryEntries();
      const entry = entries.find(
        (e) => e.sandboxId === runtimeId || `byteplus-${e.sandboxId}` === runtimeId,
      );
      if (!entry) return null;
      return {
        id: `byteplus-${entry.sandboxId}`,
        label: `byteplus/${entry.sandboxId}`,
        backendId: "byteplus",
        createdAtMs: entry.createdAtMs,
        lastUsedAtMs: entry.lastUsedAtMs,
        configLabel: entry.sandboxId,
        configLabelKind: "Image" as const,
      };
    },

    async removeRuntime(runtimeId: string): Promise<void> {
      const entries = await listRegistryEntries();
      const entry = entries.find(
        (e) => e.sandboxId === runtimeId || `byteplus-${e.sandboxId}` === runtimeId,
      );
      if (!entry) return;

      const creds = resolveVeFaaSCredentials(cfg);
      if (creds) {
        await killVeFaaSSandbox(creds, entry.sandboxId);
      }
      await deleteRegistryEntry(entry.scopeKey);
    },
  };
}
