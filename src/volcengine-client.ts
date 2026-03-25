/**
 * Volcengine ECS API client for managing cloud sandbox instances.
 *
 * Uses Volcengine's request signing scheme (HMAC-SHA256, similar to AWS SigV4).
 * Reference: https://www.volcengine.com/docs/6369/67269
 *
 * API reference (ECS):
 *   - RunInstances: create instances
 *   - DescribeInstancesIpv6Addresses / DescribeInstances: query instance state
 *   - StopInstances: stop instances
 *   - DeleteInstances: delete instances
 */

import crypto from "node:crypto";

// ---- Volcengine request signing (HMC-SHA256 / V4-like) -----------------------

const VOLCENGINE_HOST = "open.volcengineapi.com";
const ECS_SERVICE = "ecs";
const ECS_VERSION = "2020-04-01";

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Build Volcengine API authorization headers for a GET request with query params.
 * Volcengine uses a signature scheme documented at https://www.volcengine.com/docs/6369/67269
 */
function buildVolcengineAuthHeaders(params: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  action: string;
  version: string;
  queryParams: Record<string, string>;
  body?: string;
}): Record<string, string> {
  const now = new Date();
  // ISO8601 basic format: 20240101T000000Z
  const dateStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 8);
  const dateTimeStamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

  const method = "GET";
  const uri = "/";
  const host = VOLCENGINE_HOST;

  // Merge action/version into query params and sort
  const allQueryParams: Record<string, string> = {
    Action: params.action,
    Version: params.version,
    ...params.queryParams,
  };
  const sortedKeys = Object.keys(allQueryParams).sort();
  const canonicalQueryString = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allQueryParams[k])}`)
    .join("&");

  const bodyPayload = params.body ?? "";
  const payloadHash = sha256Hex(bodyPayload);

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-date:${dateTimeStamp}\n`;
  const signedHeaders = "content-type;host;x-date";

  const canonicalRequest = [
    method,
    uri,
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

  // Derive signing key
  const kDate = hmacSha256(params.secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  const kSigning = hmacSha256(kService, "request");
  const signature = hmacSha256(kSigning, stringToSign).toString("hex");

  const authorization = [
    `HMAC-SHA256 Credential=${params.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return {
    "Content-Type": "application/json",
    "X-Date": dateTimeStamp,
    Authorization: authorization,
  };
}

// ---- Types -------------------------------------------------------------------

export type VolcengineInstanceState = "Running" | "Stopped" | "Starting" | "Stopping" | "NotFound";

export type SshEndpoint = {
  host: string;
  port: number;
};

export type CreateInstanceParams = {
  instanceName: string;
  image: string;
  instanceType: string;
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
  keyPairName: string;
  /** Optional: user data script (base64 encoded) */
  userData?: string;
};

type VolcengineApiError = Error & {
  code?: string;
  statusCode?: number;
};

// ---- HTTP helper -------------------------------------------------------------

async function volcengineGet(params: {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  action: string;
  version: string;
  queryParams: Record<string, string>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const { action, version, queryParams, signal, ...authParams } = params;

  const allQueryParams: Record<string, string> = {
    Action: action,
    Version: version,
    ...queryParams,
  };

  const sortedKeys = Object.keys(allQueryParams).sort();
  const qs = sortedKeys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(allQueryParams[k])}`)
    .join("&");

  const headers = buildVolcengineAuthHeaders({
    ...authParams,
    action,
    version,
    queryParams,
  });

  const url = `https://${VOLCENGINE_HOST}/?${qs}`;

  const res = await fetch(url, {
    method: "GET",
    headers,
    signal,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Volcengine API returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err: VolcengineApiError = new Error(
      `Volcengine API error (HTTP ${res.status}): ${JSON.stringify(data)}`,
    );
    err.statusCode = res.status;
    if (isRecord(data) && isRecord(data.ResponseMetadata) && typeof data.ResponseMetadata.Error === "object") {
      const apiError = data.ResponseMetadata.Error as Record<string, unknown>;
      if (typeof apiError.Code === "string") {
        err.code = apiError.Code;
      }
    }
    throw err;
  }

  return data;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// ---- VolcengineClient --------------------------------------------------------

export class VolcengineClient {
  constructor(
    private readonly accessKeyId: string,
    private readonly secretAccessKey: string,
    private readonly region: string,
  ) {}

  private async ecsGet(
    action: string,
    queryParams: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return volcengineGet({
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      region: this.region,
      service: ECS_SERVICE,
      action,
      version: ECS_VERSION,
      queryParams,
      signal,
    });
  }

  /**
   * Create an ECS instance and return its instance ID.
   * Uses RunInstances API (single instance).
   */
  async createInstance(params: CreateInstanceParams, signal?: AbortSignal): Promise<string> {
    const queryParams: Record<string, string> = {
      InstanceName: params.instanceName,
      ImageId: params.image,
      InstanceType: params.instanceType,
      VpcId: params.vpcId,
      SubnetId: params.subnetId,
      MinCount: "1",
      MaxCount: "1",
      "SecurityGroupIds.1": params.securityGroupId,
      "KeyPairName": params.keyPairName,
    };

    if (params.userData) {
      queryParams.UserData = params.userData;
    }

    const data = await this.ecsGet("RunInstances", queryParams, signal);

    if (!isRecord(data) || !isRecord(data.Result)) {
      throw new Error(`RunInstances: unexpected response shape: ${JSON.stringify(data)}`);
    }

    const instanceIds = data.Result.InstanceIds;
    if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
      throw new Error(`RunInstances: no InstanceIds returned: ${JSON.stringify(data)}`);
    }

    return String(instanceIds[0]);
  }

  /**
   * Describe an instance and return its current state.
   * Returns "NotFound" if the instance does not exist.
   */
  async describeInstanceState(instanceId: string, signal?: AbortSignal): Promise<VolcengineInstanceState> {
    let data: unknown;
    try {
      data = await this.ecsGet(
        "DescribeInstances",
        { "InstanceIds.1": instanceId },
        signal,
      );
    } catch (err) {
      const ve = err as VolcengineApiError;
      if (ve.code === "InvalidInstanceId.NotFound" || ve.statusCode === 404) {
        return "NotFound";
      }
      throw err;
    }

    if (!isRecord(data) || !isRecord(data.Result)) {
      return "NotFound";
    }

    const instances = data.Result.Instances;
    if (!Array.isArray(instances) || instances.length === 0) {
      return "NotFound";
    }

    const inst = instances[0] as Record<string, unknown>;
    const status = String(inst.Status ?? "");

    // Map Volcengine ECS status strings to our type
    // https://www.volcengine.com/docs/6396/70122
    switch (status.toLowerCase()) {
      case "running":
        return "Running";
      case "stopped":
        return "Stopped";
      case "starting":
      case "rebuilding":
        return "Starting";
      case "stopping":
        return "Stopping";
      default:
        return "NotFound";
    }
  }

  /**
   * Describe an instance and return its primary private IP address.
   */
  async describeInstancePrimaryIp(instanceId: string, signal?: AbortSignal): Promise<string | null> {
    let data: unknown;
    try {
      data = await this.ecsGet("DescribeInstances", { "InstanceIds.1": instanceId }, signal);
    } catch {
      return null;
    }

    if (!isRecord(data) || !isRecord(data.Result)) return null;

    const instances = data.Result.Instances;
    if (!Array.isArray(instances) || instances.length === 0) return null;

    const inst = instances[0] as Record<string, unknown>;

    // Try EIP (public IP) first, then VPC primary private IP
    if (isRecord(inst.EipAddress) && typeof inst.EipAddress.IpAddress === "string") {
      return inst.EipAddress.IpAddress;
    }

    // Walk network interfaces for primary private IP
    const nics = inst.NetworkInterfaces;
    if (Array.isArray(nics) && nics.length > 0) {
      const primaryNic = nics[0] as Record<string, unknown>;
      if (typeof primaryNic.PrimaryIpAddress === "string") {
        return primaryNic.PrimaryIpAddress;
      }
    }

    return null;
  }

  /**
   * Start a stopped ECS instance.
   */
  async startInstance(instanceId: string, signal?: AbortSignal): Promise<void> {
    await this.ecsGet("StartInstances", { "InstanceIds.1": instanceId }, signal);
  }

  /**
   * Stop an ECS instance.
   */
  async stopInstance(instanceId: string, signal?: AbortSignal): Promise<void> {
    await this.ecsGet("StopInstances", { "InstanceIds.1": instanceId, ForceStop: "false" }, signal);
  }

  /**
   * Delete (terminate) an ECS instance.
   */
  async deleteInstance(instanceId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.ecsGet("DeleteInstances", { "InstanceIds.1": instanceId }, signal);
    } catch (err) {
      const ve = err as VolcengineApiError;
      // Ignore "not found" errors during deletion — already gone
      if (ve.code === "InvalidInstanceId.NotFound" || ve.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  /**
   * Wait until an instance reaches the Running state, polling every 5 seconds.
   * Throws if the instance is not Running within timeoutSeconds.
   */
  async waitForRunning(instanceId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<SshEndpoint> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const POLL_INTERVAL_MS = 5_000;

    while (Date.now() < deadline) {
      const state = await this.describeInstanceState(instanceId, signal);
      if (state === "Running") {
        const ip = await this.describeInstancePrimaryIp(instanceId, signal);
        if (!ip) {
          throw new Error(`Instance ${instanceId} is Running but has no IP address`);
        }
        return { host: ip, port: 22 };
      }
      if (state === "NotFound") {
        throw new Error(`Instance ${instanceId} not found after creation`);
      }
      if (state === "Stopped") {
        throw new Error(`Instance ${instanceId} stopped unexpectedly during startup`);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(
      `Instance ${instanceId} did not reach Running state within ${timeoutSeconds}s`,
    );
  }

  /**
   * Get SSH connection endpoint for a Running instance.
   */
  async getSshEndpoint(instanceId: string, signal?: AbortSignal): Promise<SshEndpoint> {
    const ip = await this.describeInstancePrimaryIp(instanceId, signal);
    if (!ip) {
      throw new Error(`Cannot resolve SSH endpoint: instance ${instanceId} has no IP address`);
    }
    return { host: ip, port: 22 };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
