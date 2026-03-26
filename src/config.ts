/**
 * Plugin configuration for the BytePlus VeFaaS cloud sandbox backend.
 *
 * Mirrors openclaw-dev's SandboxCloudSettings design:
 *   - Only `endpoint` + `sandboxId` needed to connect to an existing sandbox
 *   - Credentials + `functionId` enable auto-create/kill
 *   - Default workdir: /home/gem  (matches VeFaaS sandbox default)
 */

export const DEFAULT_CLOUD_WORKDIR = "/home/gem";
export const DEFAULT_CLOUD_REGION = "cn-beijing";
export const DEFAULT_CLOUD_TIMEOUT_MIN = 60;
export const REGISTRY_PATH_NAME = "byteplus-sandbox-registry.json";

export type ByteplusSandboxPluginConfig = {
  /**
   * API Gateway endpoint URL.
   * Example: "https://sd6jairhu8aldae0o8f0g.apigateway-cn-beijing.volceapi.com"
   */
  endpoint?: string;
  /**
   * VeFaaS sandbox instance identifier (faasInstanceName).
   * Omit to auto-create using functionId + credentials.
   */
  sandboxId?: string;
  /** Working directory inside the sandbox. Default: /home/gem */
  workdir?: string;
  /** Optional Bearer token for API Gateway authentication. */
  token?: string;
  /** Volcengine Access Key for VeFaaS API (auto-create/kill). */
  accessKey?: string;
  /** Volcengine Secret Key for VeFaaS API (auto-create/kill). */
  secretKey?: string;
  /** Volcengine region. Default: cn-beijing. */
  region?: string;
  /** VeFaaS function ID for sandbox creation. */
  functionId?: string;
  /** Sandbox timeout in minutes. Default: 60. */
  timeoutMin?: number;
};

export type ResolvedByteplusSandboxConfig = {
  endpoint: string | null;
  sandboxId: string | null;
  workdir: string;
  token: string | null;
  accessKey: string | null;
  secretKey: string | null;
  region: string;
  functionId: string | null;
  timeoutMin: number;
};

export function resolveConfig(raw: unknown): ResolvedByteplusSandboxConfig {
  const cfg: ByteplusSandboxPluginConfig =
    raw && typeof raw === "object" ? (raw as ByteplusSandboxPluginConfig) : {};

  const accessKey =
    cfg.accessKey?.trim() ||
    process.env.BYTEPLUS_ACCESS_KEY_ID?.trim() ||
    process.env.VOLCENGINE_ACCESS_KEY_ID?.trim() ||
    null;

  const secretKey =
    cfg.secretKey?.trim() ||
    process.env.BYTEPLUS_SECRET_ACCESS_KEY?.trim() ||
    process.env.VOLCENGINE_SECRET_ACCESS_KEY?.trim() ||
    null;

  return {
    endpoint: cfg.endpoint?.trim() || null,
    sandboxId: cfg.sandboxId?.trim() || null,
    workdir: cfg.workdir?.trim() || DEFAULT_CLOUD_WORKDIR,
    token: cfg.token?.trim() || null,
    accessKey,
    secretKey,
    region: cfg.region?.trim() || DEFAULT_CLOUD_REGION,
    functionId: cfg.functionId?.trim() || null,
    timeoutMin: cfg.timeoutMin ?? DEFAULT_CLOUD_TIMEOUT_MIN,
  };
}

/** Return credentials for VeFaaS lifecycle API, or null if not configured. */
export type VeFaaSCredentials = {
  accessKey: string;
  secretKey: string;
  region: string;
  functionId: string;
  timeoutMin: number;
};

export function resolveVeFaaSCredentials(
  cfg: ResolvedByteplusSandboxConfig,
): VeFaaSCredentials | null {
  if (!cfg.accessKey || !cfg.secretKey || !cfg.functionId) {
    return null;
  }
  return {
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    region: cfg.region,
    functionId: cfg.functionId,
    timeoutMin: cfg.timeoutMin,
  };
}
