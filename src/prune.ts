/**
 * Automatic cleanup of stale BytePlus sandbox instances.
 *
 * Pattern mirrors openclaw-dev/src/agents/sandbox/prune.ts but adapted for
 * cloud instances rather than Docker containers.
 *
 * Called opportunistically before each ensureInstance() via maybePruneSandboxes().
 */

import { readRegistry, removeRegistryEntry } from "./registry.js";
import type { VolcengineClient } from "./volcengine-client.js";

type PruneConfig = {
  /** Delete instances idle for more than this many hours. 0 = disabled. */
  idleHours: number;
  /** Delete instances older than this many days. 0 = disabled. */
  maxAgeDays: number;
};

let lastPruneAtMs = 0;
const PRUNE_DEBOUNCE_MS = 5 * 60 * 1000; // only prune at most every 5 minutes

function shouldPrune(config: PruneConfig, entry: { createdAtMs: number; lastUsedAtMs: number }, now: number): boolean {
  if (config.idleHours === 0 && config.maxAgeDays === 0) return false;
  const idleMs = now - entry.lastUsedAtMs;
  const ageMs = now - entry.createdAtMs;
  return (
    (config.idleHours > 0 && idleMs > config.idleHours * 60 * 60 * 1000) ||
    (config.maxAgeDays > 0 && ageMs > config.maxAgeDays * 24 * 60 * 60 * 1000)
  );
}

/**
 * Prune stale instances from the registry and Volcengine.
 * Debounced — only runs at most every PRUNE_DEBOUNCE_MS milliseconds.
 */
export async function maybePruneSandboxes(
  client: VolcengineClient,
  config: PruneConfig,
): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAtMs < PRUNE_DEBOUNCE_MS) return;
  lastPruneAtMs = now;

  try {
    await pruneSandboxes(client, config, now);
  } catch {
    // Prune failures must not disrupt the main sandbox flow
  }
}

async function pruneSandboxes(
  client: VolcengineClient,
  config: PruneConfig,
  now: number,
): Promise<void> {
  if (config.idleHours === 0 && config.maxAgeDays === 0) return;

  const entries = await readRegistry();
  for (const entry of entries) {
    if (!shouldPrune(config, entry, now)) continue;
    try {
      await client.deleteInstance(entry.instanceId);
    } catch {
      // Ignore deletion failures — instance may already be gone
    }
    await removeRegistryEntry(entry.scopeKey);
  }
}
