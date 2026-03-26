/**
 * Lightweight registry mapping scopeKey → sandboxId.
 *
 * Stored at ~/.openclaw/byteplus-sandbox-registry.json.
 * Allows the backend to reuse an existing VeFaaS sandbox across agent restarts.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REGISTRY_PATH_NAME } from "./config.js";

const REGISTRY_PATH = path.join(os.homedir(), ".openclaw", REGISTRY_PATH_NAME);

export type RegistryEntry = {
  scopeKey: string;
  sandboxId: string;
  createdAtMs: number;
  lastUsedAtMs: number;
};

type RegistryFile = {
  entries: RegistryEntry[];
};

async function readRegistry(): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, "utf8");
    return JSON.parse(raw) as RegistryFile;
  } catch {
    return { entries: [] };
  }
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf8");
}

export async function getRegistryEntry(scopeKey: string): Promise<RegistryEntry | null> {
  const registry = await readRegistry();
  return registry.entries.find((e) => e.scopeKey === scopeKey) ?? null;
}

export async function upsertRegistryEntry(entry: RegistryEntry): Promise<void> {
  const registry = await readRegistry();
  const idx = registry.entries.findIndex((e) => e.scopeKey === entry.scopeKey);
  if (idx >= 0) {
    registry.entries[idx] = entry;
  } else {
    registry.entries.push(entry);
  }
  await writeRegistry(registry);
}

export async function deleteRegistryEntry(scopeKey: string): Promise<void> {
  const registry = await readRegistry();
  registry.entries = registry.entries.filter((e) => e.scopeKey !== scopeKey);
  await writeRegistry(registry);
}

export async function listRegistryEntries(): Promise<RegistryEntry[]> {
  const registry = await readRegistry();
  return registry.entries;
}

export async function touchRegistryEntry(scopeKey: string): Promise<void> {
  const registry = await readRegistry();
  const entry = registry.entries.find((e) => e.scopeKey === scopeKey);
  if (entry) {
    entry.lastUsedAtMs = Date.now();
    await writeRegistry(registry);
  }
}
