/**
 * Plugin configuration — modelled after openclaw-dev's Docker sandbox config:
 * only `image` is required (with a sensible default).
 * Credentials come from environment variables.
 * Network resources (VPC, subnet, security group, SSH key pair) are
 * auto-provisioned on first use by src/setup.ts.
 */

export const DEFAULT_SANDBOX_IMAGE = "cr.volces.com/openclaw/sandbox:latest";
export const DEFAULT_SANDBOX_REGION = "cn-beijing";
export const DEFAULT_SANDBOX_INSTANCE_TYPE = "ecs.c3i.large";
export const DEFAULT_SANDBOX_WORKDIR = "/workspace";
export const DEFAULT_SANDBOX_SSH_USER = "root";
export const DEFAULT_SANDBOX_CONTAINER_PREFIX = "openclaw-sbx-";
export const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 180;
export const DEFAULT_SANDBOX_IDLE_HOURS = 24;
export const DEFAULT_SANDBOX_MAX_AGE_DAYS = 7;

export type ByteplusSandboxPluginConfig = {
  /** Container image to run. Default: cr.volces.com/openclaw/sandbox:latest */
  image?: string;
  /** Volcengine region. Default: cn-beijing */
  region?: string;
  /** ECS instance type. Default: ecs.c3i.large */
  instanceType?: string;
  /** Remote workspace directory. Default: /workspace */
  remoteWorkspaceDir?: string;
  /** SSH login user. Default: root */
  sshUser?: string;
  /** Prefix for ECS instance names. Default: openclaw-sbx- */
  containerPrefix?: string;
  /** Startup timeout in seconds. Default: 180 */
  timeoutSeconds?: number;
  /** Delete instances idle for this many hours. Default: 24 (0 = off) */
  idleHours?: number;
  /** Delete instances older than this many days. Default: 7 (0 = off) */
  maxAgeDays?: number;

  // --- Optional overrides: skip auto-setup if pre-configured ---
  /** Pre-existing VPC ID. If omitted, auto-detected or created. */
  vpcId?: string;
  /** Pre-existing subnet ID. If omitted, auto-detected or created. */
  subnetId?: string;
  /** Pre-existing security group ID. If omitted, auto-created. */
  securityGroupId?: string;
  /** Pre-existing key pair name registered in Volcengine. If omitted, auto-generated. */
  keyPairName?: string;
  /** PEM private key for SSH. If omitted, auto-generated and stored locally. */
  sshPrivateKey?: string;
};

export type ResolvedByteplusSandboxConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  image: string;
  region: string;
  instanceType: string;
  remoteWorkspaceDir: string;
  sshUser: string;
  containerPrefix: string;
  timeoutSeconds: number;
  idleHours: number;
  maxAgeDays: number;
  // Network overrides (may be undefined → auto-setup fills them in)
  vpcId?: string;
  subnetId?: string;
  securityGroupId?: string;
  keyPairName?: string;
  sshPrivateKey?: string;
};

export function resolveConfig(raw: unknown): ResolvedByteplusSandboxConfig {
  const cfg: ByteplusSandboxPluginConfig =
    raw && typeof raw === "object" ? (raw as ByteplusSandboxPluginConfig) : {};

  return {
    accessKeyId: requireCredential(
      cfg,
      "accessKeyId",
      "BYTEPLUS_ACCESS_KEY_ID",
      "VOLCENGINE_ACCESS_KEY_ID",
    ),
    secretAccessKey: requireCredential(
      cfg,
      "secretAccessKey",
      "BYTEPLUS_SECRET_ACCESS_KEY",
      "VOLCENGINE_SECRET_ACCESS_KEY",
    ),
    image: cfg.image?.trim() || DEFAULT_SANDBOX_IMAGE,
    region: cfg.region?.trim() || DEFAULT_SANDBOX_REGION,
    instanceType: cfg.instanceType?.trim() || DEFAULT_SANDBOX_INSTANCE_TYPE,
    remoteWorkspaceDir: cfg.remoteWorkspaceDir?.trim() || DEFAULT_SANDBOX_WORKDIR,
    sshUser: cfg.sshUser?.trim() || DEFAULT_SANDBOX_SSH_USER,
    containerPrefix: cfg.containerPrefix?.trim() || DEFAULT_SANDBOX_CONTAINER_PREFIX,
    timeoutSeconds: cfg.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
    idleHours: cfg.idleHours ?? DEFAULT_SANDBOX_IDLE_HOURS,
    maxAgeDays: cfg.maxAgeDays ?? DEFAULT_SANDBOX_MAX_AGE_DAYS,
    // Network overrides — optional, auto-setup fills missing ones
    vpcId: cfg.vpcId?.trim() || undefined,
    subnetId: cfg.subnetId?.trim() || undefined,
    securityGroupId: cfg.securityGroupId?.trim() || undefined,
    keyPairName: cfg.keyPairName?.trim() || undefined,
    sshPrivateKey: cfg.sshPrivateKey?.trim() || undefined,
  };
}

/**
 * Resolve a required credential: plugin config → environment variables.
 * Unlike network resources, credentials cannot be auto-provisioned.
 */
function requireCredential(
  cfg: ByteplusSandboxPluginConfig,
  field: keyof ByteplusSandboxPluginConfig,
  ...envVars: string[]
): string {
  for (const envVar of envVars) {
    const val = process.env[envVar];
    if (val?.trim()) return val.trim();
  }
  const val = cfg[field];
  if (typeof val === "string" && val.trim()) return val.trim();
  throw new Error(
    `BytePlus Sandbox: missing required credential "${field}". ` +
      `Set ${envVars.join(" or ")} environment variable.`,
  );
}
