export type ByteplusSandboxPluginConfig = {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  image?: string;
  instanceType?: string;
  vpcId?: string;
  subnetId?: string;
  securityGroupId?: string;
  keyPairName?: string;
  sshPrivateKey?: string;
  sshUser?: string;
  remoteWorkspaceDir?: string;
  containerPrefix?: string;
  timeoutSeconds?: number;
  idleHours?: number;
  maxAgeDays?: number;
};

export type ResolvedByteplusSandboxConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  image: string;
  instanceType: string;
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
  keyPairName: string;
  sshPrivateKey: string;
  sshUser: string;
  remoteWorkspaceDir: string;
  containerPrefix: string;
  timeoutSeconds: number;
  idleHours: number;
  maxAgeDays: number;
};

function requireConfigField(config: ByteplusSandboxPluginConfig, field: keyof ByteplusSandboxPluginConfig): string {
  const value = config[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `BytePlus Sandbox: missing required config field "${field}". ` +
      `Set it in your openclaw.json under plugins.entries.byteplus-sandbox.config.${field}.`,
    );
  }
  return value;
}

export function resolveConfig(raw: unknown): ResolvedByteplusSandboxConfig {
  const config: ByteplusSandboxPluginConfig =
    raw && typeof raw === "object" ? (raw as ByteplusSandboxPluginConfig) : {};

  return {
    accessKeyId: resolveEnvOrConfig(config, "accessKeyId", "BYTEPLUS_ACCESS_KEY_ID", "VOLCENGINE_ACCESS_KEY_ID"),
    secretAccessKey: resolveEnvOrConfig(config, "secretAccessKey", "BYTEPLUS_SECRET_ACCESS_KEY", "VOLCENGINE_SECRET_ACCESS_KEY"),
    region: config.region?.trim() || "cn-beijing",
    image: requireConfigField(config, "image"),
    instanceType: config.instanceType?.trim() || "ecs.c3i.large",
    vpcId: requireConfigField(config, "vpcId"),
    subnetId: requireConfigField(config, "subnetId"),
    securityGroupId: requireConfigField(config, "securityGroupId"),
    keyPairName: requireConfigField(config, "keyPairName"),
    sshPrivateKey: requireConfigField(config, "sshPrivateKey"),
    sshUser: config.sshUser?.trim() || "root",
    remoteWorkspaceDir: config.remoteWorkspaceDir?.trim() || "/workspace",
    containerPrefix: config.containerPrefix?.trim() || "openclaw-sandbox",
    timeoutSeconds: typeof config.timeoutSeconds === "number" ? config.timeoutSeconds : 180,
    idleHours: typeof config.idleHours === "number" ? config.idleHours : 2,
    maxAgeDays: typeof config.maxAgeDays === "number" ? config.maxAgeDays : 7,
  };
}

function resolveEnvOrConfig(
  config: ByteplusSandboxPluginConfig,
  field: keyof ByteplusSandboxPluginConfig,
  ...envVars: string[]
): string {
  // Prefer environment variables (allows CI/prod override without config file edits)
  for (const envVar of envVars) {
    const val = process.env[envVar];
    if (val?.trim()) {
      return val.trim();
    }
  }
  const val = config[field];
  if (typeof val === "string" && val.trim()) {
    return val.trim();
  }
  throw new Error(
    `BytePlus Sandbox: missing required config field "${field}". ` +
    `Set it via environment variable (${envVars.join(" or ")}) or in openclaw.json.`,
  );
}
