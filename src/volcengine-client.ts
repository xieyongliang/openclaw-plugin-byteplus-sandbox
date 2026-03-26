/**
 * Volcengine ECS + VPC API client.
 *
 * Uses Volcengine's HMAC-SHA256 request signing scheme.
 * Reference: https://www.volcengine.com/docs/6369/67269
 */

import crypto from "node:crypto";

// ---- Signing -----------------------------------------------------------------

const VOLCENGINE_HOST = "open.volcengineapi.com";
const ECS_SERVICE = "ecs";
const VPC_SERVICE = "vpc";
const ECS_VERSION = "2020-04-01";
const VPC_VERSION = "2020-04-01";

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function buildAuthHeaders(params: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  action: string;
  version: string;
  queryParams: Record<string, string>;
}): Record<string, string> {
  const now = new Date();
  const dateStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 8);
  const dateTimeStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const host = VOLCENGINE_HOST;

  const allQueryParams: Record<string, string> = {
    Action: params.action,
    Version: params.version,
    ...params.queryParams,
  };
  const sortedKeys = Object.keys(allQueryParams).sort();
  const canonicalQueryString = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allQueryParams[k])}`)
    .join("&");

  const payloadHash = sha256Hex("");
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-date:${dateTimeStamp}\n`;
  const signedHeaders = "content-type;host;x-date";
  const canonicalRequest = [
    "GET",
    "/",
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    dateTimeStamp,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(params.secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  return {
    "Content-Type": "application/json",
    "X-Date": dateTimeStamp,
    Authorization: `HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---- HTTP helper -------------------------------------------------------------

async function apiGet(params: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  version: string;
  action: string;
  queryParams: Record<string, string>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { action, version, queryParams, signal, service, ...authParams } = params;
  const allParams = { Action: action, Version: version, ...queryParams };
  const qs = Object.keys(allParams)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join("&");

  const headers = buildAuthHeaders({ ...authParams, service, action, version, queryParams });
  const res = await fetch(`https://${VOLCENGINE_HOST}/?${qs}`, {
    method: "GET",
    headers,
    signal,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Volcengine API non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err = new VolcengineApiError(
      `Volcengine API error (HTTP ${res.status}): ${JSON.stringify(data)}`,
      res.status,
      data,
    );
    throw err;
  }
  return data;
}

export class VolcengineApiError extends Error {
  code?: string;
  constructor(message: string, public readonly statusCode: number, public readonly body: unknown) {
    super(message);
    if (isRecord(body) && isRecord(body.ResponseMetadata) && isRecord(body.ResponseMetadata.Error)) {
      const e = body.ResponseMetadata.Error as Record<string, unknown>;
      if (typeof e.Code === "string") this.code = e.Code;
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// ---- Types -------------------------------------------------------------------

export type VolcengineInstanceState =
  | "Running"
  | "Stopped"
  | "Starting"
  | "Stopping"
  | "NotFound";

export type SshEndpoint = { host: string; port: number };

export type CreateInstanceParams = {
  instanceName: string;
  image: string;
  instanceType: string;
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
  keyPairName: string;
};

// ---- Client ------------------------------------------------------------------

export class VolcengineClient {
  constructor(
    private readonly ak: string,
    private readonly sk: string,
    private readonly region: string,
  ) {}

  // ---- ECS -------------------------------------------------------------------

  private async ecs(action: string, q: Record<string, string>, signal?: AbortSignal) {
    return apiGet({
      accessKeyId: this.ak,
      secretAccessKey: this.sk,
      region: this.region,
      service: ECS_SERVICE,
      version: ECS_VERSION,
      action,
      queryParams: q,
      signal,
    });
  }

  // ---- VPC -------------------------------------------------------------------

  private async vpc(action: string, q: Record<string, string>, signal?: AbortSignal) {
    return apiGet({
      accessKeyId: this.ak,
      secretAccessKey: this.sk,
      region: this.region,
      service: VPC_SERVICE,
      version: VPC_VERSION,
      action,
      queryParams: q,
      signal,
    });
  }

  // ---- Instance lifecycle ----------------------------------------------------

  async createInstance(params: CreateInstanceParams, signal?: AbortSignal): Promise<string> {
    const data = await this.ecs(
      "RunInstances",
      {
        InstanceName: params.instanceName,
        ImageId: params.image,
        InstanceType: params.instanceType,
        VpcId: params.vpcId,
        SubnetId: params.subnetId,
        MinCount: "1",
        MaxCount: "1",
        "SecurityGroupIds.1": params.securityGroupId,
        KeyPairName: params.keyPairName,
      },
      signal,
    );
    if (!isRecord(data) || !isRecord(data.Result)) {
      throw new Error(`RunInstances: unexpected response: ${JSON.stringify(data)}`);
    }
    const ids = data.Result.InstanceIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error(`RunInstances: no InstanceIds returned`);
    }
    return String(ids[0]);
  }

  async describeInstanceState(instanceId: string, signal?: AbortSignal): Promise<VolcengineInstanceState> {
    try {
      const data = await this.ecs("DescribeInstances", { "InstanceIds.1": instanceId }, signal);
      if (!isRecord(data) || !isRecord(data.Result)) return "NotFound";
      const insts = data.Result.Instances;
      if (!Array.isArray(insts) || insts.length === 0) return "NotFound";
      const status = String((insts[0] as Record<string, unknown>).Status ?? "").toLowerCase();
      if (status === "running") return "Running";
      if (status === "stopped") return "Stopped";
      if (status === "starting" || status === "rebuilding") return "Starting";
      if (status === "stopping") return "Stopping";
      return "NotFound";
    } catch (err) {
      if (err instanceof VolcengineApiError &&
        (err.code === "InvalidInstanceId.NotFound" || err.statusCode === 404)) {
        return "NotFound";
      }
      throw err;
    }
  }

  async describeInstancePrimaryIp(instanceId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const data = await this.ecs("DescribeInstances", { "InstanceIds.1": instanceId }, signal);
      if (!isRecord(data) || !isRecord(data.Result)) return null;
      const insts = data.Result.Instances;
      if (!Array.isArray(insts) || insts.length === 0) return null;
      const inst = insts[0] as Record<string, unknown>;
      // Prefer EIP (public IP) so we can reach the instance from outside VPC
      if (isRecord(inst.EipAddress) && typeof inst.EipAddress.IpAddress === "string") {
        return inst.EipAddress.IpAddress;
      }
      const nics = inst.NetworkInterfaces;
      if (Array.isArray(nics) && nics.length > 0) {
        const nic = nics[0] as Record<string, unknown>;
        if (typeof nic.PrimaryIpAddress === "string") return nic.PrimaryIpAddress;
      }
      return null;
    } catch {
      return null;
    }
  }

  async startInstance(instanceId: string, signal?: AbortSignal): Promise<void> {
    await this.ecs("StartInstances", { "InstanceIds.1": instanceId }, signal);
  }

  async deleteInstance(instanceId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.ecs("DeleteInstances", { "InstanceIds.1": instanceId }, signal);
    } catch (err) {
      if (err instanceof VolcengineApiError &&
        (err.code === "InvalidInstanceId.NotFound" || err.statusCode === 404)) return;
      throw err;
    }
  }

  async waitForRunning(instanceId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<SshEndpoint> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const state = await this.describeInstanceState(instanceId, signal);
      if (state === "Running") {
        const ip = await this.describeInstancePrimaryIp(instanceId, signal);
        if (!ip) throw new Error(`Instance ${instanceId} Running but has no IP`);
        return { host: ip, port: 22 };
      }
      if (state === "NotFound") throw new Error(`Instance ${instanceId} not found`);
      if (state === "Stopped") throw new Error(`Instance ${instanceId} stopped unexpectedly`);
      await sleep(5_000);
    }
    throw new Error(`Instance ${instanceId} did not reach Running state within ${timeoutSeconds}s`);
  }

  async getSshEndpoint(instanceId: string, signal?: AbortSignal): Promise<SshEndpoint> {
    const ip = await this.describeInstancePrimaryIp(instanceId, signal);
    if (!ip) throw new Error(`Instance ${instanceId} has no IP address`);
    return { host: ip, port: 22 };
  }

  // ---- VPC auto-setup --------------------------------------------------------

  /** Return the first available VPC ID, or null if none exists. */
  async findDefaultVpc(signal?: AbortSignal): Promise<string | null> {
    try {
      const data = await this.vpc("DescribeVpcs", { PageSize: "10" }, signal);
      if (!isRecord(data) || !isRecord(data.Result)) return null;
      const vpcs = data.Result.Vpcs;
      if (!Array.isArray(vpcs) || vpcs.length === 0) return null;
      // Prefer any VPC marked as default, otherwise take the first
      const def = (vpcs as Record<string, unknown>[]).find((v) => v.IsDefault === true);
      return String((def ?? vpcs[0] as Record<string, unknown>).VpcId ?? "");
    } catch {
      return null;
    }
  }

  /** Create a minimal VPC for sandbox use. */
  async createVpc(signal?: AbortSignal): Promise<string> {
    const data = await this.vpc(
      "CreateVpc",
      { VpcName: "openclaw-sandbox-vpc", CidrBlock: "10.0.0.0/16" },
      signal,
    );
    if (!isRecord(data) || !isRecord(data.Result) || typeof data.Result.VpcId !== "string") {
      throw new Error(`CreateVpc: unexpected response: ${JSON.stringify(data)}`);
    }
    return data.Result.VpcId;
  }

  /** Return the first subnet in the given VPC, or null. */
  async findSubnet(vpcId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const data = await this.vpc("DescribeSubnets", { VpcId: vpcId, PageSize: "10" }, signal);
      if (!isRecord(data) || !isRecord(data.Result)) return null;
      const subnets = data.Result.Subnets;
      if (!Array.isArray(subnets) || subnets.length === 0) return null;
      return String((subnets[0] as Record<string, unknown>).SubnetId ?? "");
    } catch {
      return null;
    }
  }

  /** Create a subnet in the VPC. */
  async createSubnet(vpcId: string, signal?: AbortSignal): Promise<string> {
    const data = await this.vpc(
      "CreateSubnet",
      { VpcId: vpcId, SubnetName: "openclaw-sandbox-subnet", CidrBlock: "10.0.0.0/24" },
      signal,
    );
    if (!isRecord(data) || !isRecord(data.Result) || typeof data.Result.SubnetId !== "string") {
      throw new Error(`CreateSubnet: unexpected response: ${JSON.stringify(data)}`);
    }
    return data.Result.SubnetId;
  }

  /** Find security group named "openclaw-sandbox" in the VPC. */
  async findSandboxSecurityGroup(vpcId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const data = await this.vpc(
        "DescribeSecurityGroups",
        { VpcId: vpcId, PageSize: "20" },
        signal,
      );
      if (!isRecord(data) || !isRecord(data.Result)) return null;
      const sgs = data.Result.SecurityGroups;
      if (!Array.isArray(sgs)) return null;
      const found = (sgs as Record<string, unknown>[]).find(
        (sg) => sg.SecurityGroupName === "openclaw-sandbox",
      );
      return found ? String(found.SecurityGroupId) : null;
    } catch {
      return null;
    }
  }

  /** Create a security group that allows inbound SSH (port 22). */
  async createSandboxSecurityGroup(vpcId: string, signal?: AbortSignal): Promise<string> {
    // Create group
    const data = await this.vpc(
      "CreateSecurityGroup",
      {
        VpcId: vpcId,
        SecurityGroupName: "openclaw-sandbox",
        Description: "OpenClaw sandbox — inbound SSH",
      },
      signal,
    );
    if (!isRecord(data) || !isRecord(data.Result) || typeof data.Result.SecurityGroupId !== "string") {
      throw new Error(`CreateSecurityGroup: unexpected response: ${JSON.stringify(data)}`);
    }
    const sgId = data.Result.SecurityGroupId;

    // Add inbound SSH rule
    await this.vpc(
      "AuthorizeSecurityGroupIngress",
      {
        SecurityGroupId: sgId,
        Protocol: "tcp",
        PortStart: "22",
        PortEnd: "22",
        CidrIp: "0.0.0.0/0",
        Description: "SSH access for OpenClaw sandbox",
      },
      signal,
    ).catch(() => {
      // Non-fatal: security group was created, SSH rule failed
    });

    return sgId;
  }

  // ---- SSH key pair management -----------------------------------------------

  /** Find key pair by name, return true if exists. */
  async keyPairExists(keyPairName: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const data = await this.ecs(
        "DescribeKeyPairs",
        { KeyPairName: keyPairName, PageSize: "1" },
        signal,
      );
      if (!isRecord(data) || !isRecord(data.Result)) return false;
      const kps = data.Result.KeyPairs;
      return Array.isArray(kps) && kps.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Import a key pair using an existing public key.
   * Returns the key pair name.
   */
  async importKeyPair(
    keyPairName: string,
    publicKeyMaterial: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.ecs(
      "ImportKeyPair",
      { KeyPairName: keyPairName, PublicKey: publicKeyMaterial },
      signal,
    );
    return keyPairName;
  }

  async deleteKeyPair(keyPairName: string, signal?: AbortSignal): Promise<void> {
    await this.ecs("DeleteKeyPairs", { "KeyPairNames.1": keyPairName }, signal).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
