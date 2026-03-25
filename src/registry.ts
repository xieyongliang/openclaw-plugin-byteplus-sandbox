/**
 * Lightweight instance registry using a local JSON file.
 * Persists scopeKey → instanceId mappings so instances are reused across agent
 * sessions and survive process restarts.
 *
 * Inspired by openclaw-dev/src/agents/sandbox/registry.ts, simplified to avoid
 * core-internal dependencies (no writeJsonAtomic, no acquireSessionWriteLock).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---- Types -------------------------------------------------------------------

export type RegistryEntry = {
  /** Unique key identifying the sandbox scope (hash of workspaceDir + configHash + scopeKey). */
  scopeKey: string;
  /** Volcengine ECS instance ID. */
  instanceId: string;
  /** Image ID or name used to create the instance. */
  image: string;
  /** Config hash at creation time; used to detect stale instances. */
  configHash: string;
  createdAtMs: number;
  lastUsedAtMs: number;
};

type RegistryFile = {
  entries: RegistryEntry[];
};

// ---- Registry path -----------------------------------------------------------

const REGISTRY_FILE = path.join(
  os.homedir(),
  ".openclaw",
  "byteplus-sandbox-registry.json",
);

// In-memory write lock (single-process only; sufficient for agent use)
let writeLock: Promise<void> = Promise.resolve();

// ---- Internal helpers --------------------------------------------------------

function isRegistryEntry(v: unknown): v is RegistryEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.scopeKey === "string" && typeof r.instanceId === "string";
}

function isRegistryFile(v: unknown): v is RegistryFile {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.entries) && r.entries.every(isRegistryEntry);
}

async function readRegistryFile(): Promise<RegistryFile> {
  try {
    const raw = await fs.readFile(REGISTRY_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isRegistryFile(parsed)) return parsed;
    return { entries: [] };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") return { entries: [] };
    return { entries: [] };
  }
}

/** Atomic write: write to a temp file then rename. */
async function writeRegistryFile(registry: RegistryFile): Promise<void> {
  const dir = path.dirname(REGISTRY_FILE);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${REGISTRY_FILE}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(registry, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, REGISTRY_FILE);
}

/** Serialize mutations through the in-process lock. */
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  let resolve!: () => void;
  const next = new Promise<void>((r) => {
    resolve = r;
  });
  const prev = writeLock;
  writeLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    resolve();
  }
}

// ---- Public API --------------------------------------------------------------

export async function readRegistry(): Promise<RegistryEntry[]> {
  const file = await readRegistryFile();
  return file.entries;
}

export async function upsertRegistryEntry(entry: RegistryEntry): Promise<void> {
  await withLock(async () => {
    const file = await readRegistryFile();
    const existing = file.entries.findIndex((e) => e.scopeKey === entry.scopeKey);
    if (existing >= 0) {
      file.entries[existing] = {
        ...file.entries[existing],
        ...entry,
        createdAtMs: file.entries[existing].createdAtMs,
      };
    } else {
      file.entries.push(entry);
    }
    await writeRegistryFile(file);
  });
}

export async function touchRegistryEntry(scopeKey: string): Promise<void> {
  await withLock(async () => {
    const file = await readRegistryFile();
    const entry = file.entries.find((e) => e.scopeKey === scopeKey);
    if (entry) {
      entry.lastUsedAtMs = Date.now();
      await writeRegistryFile(file);
    }
  });
}

export async function removeRegistryEntry(scopeKey: string): Promise<void> {
  await withLock(async () => {
    const file = await readRegistryFile();
    const before = file.entries.length;
    file.entries = file.entries.filter((e) => e.scopeKey !== scopeKey);
    if (file.entries.length !== before) {
      await writeRegistryFile(file);
    }
  });
}

export async function getRegistryEntry(scopeKey: string): Promise<RegistryEntry | null> {
  const file = await readRegistryFile();
  return file.entries.find((e) => e.scopeKey === scopeKey) ?? null;
}
