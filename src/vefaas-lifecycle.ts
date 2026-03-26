/**
 * VeFaaS sandbox lifecycle — create and kill sandbox instances.
 *
 * Direct port of openclaw-dev/extensions/volcengine-cloud-sandbox/lifecycle.ts
 * Uses Volcengine Signature V4 (HMAC-SHA256, POST with JSON body).
 *
 * API: vefaas service, version 2024-06-06
 */

import { createHash, createHmac } from "node:crypto";
import type { VeFaaSCredentials } from "./config.js";

const SERVICE = "vefaas";
const API_VERSION = "2024-06-06";
const HOST = "open.volcengineapi.com";

// ── Volcengine Signature V4 ──────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmacSHA256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSHA256(secretKey, dateStamp);
  const kRegion = hmacSHA256(kDate, region);
  const kService = hmacSHA256(kRegion, service);
  return hmacSHA256(kService, "request");
}

function buildSignedRequest(params: {
  action: string;
  body: Record<string, unknown>;
  credentials: VeFaaSCredentials;
}): { url: string; headers: Record<string, string>; body: string } {
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = `${dateStamp}T${now.toISOString().slice(11, 19).replace(/:/g, "")}Z`;

  const { action, body, credentials } = params;
  const bodyStr = JSON.stringify(body);
  const payloadHash = sha256(bodyStr);

  const queryParams = new URLSearchParams({ Action: action, Version: API_VERSION });
  const canonicalQueryString = [...queryParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: HOST,
    "x-date": amzDate,
    "x-content-sha256": payloadHash,
  };

  const signedHeaderKeys = Object.keys(headers).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders =
    signedHeaderKeys.map((k) => `${k}:${headers[k].trim()}`).join("\n") + "\n";

  const canonicalRequest = [
    "POST",
    "/",
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${credentials.region}/${SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join(
    "\n",
  );

  const signingKey = getSigningKey(credentials.secretKey, dateStamp, credentials.region, SERVICE);
  const signature = hmacSHA256(signingKey, stringToSign).toString("hex");

  const authorization =
    `HMAC-SHA256 Credential=${credentials.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${HOST}/?${canonicalQueryString}`,
    headers: { ...headers, Authorization: authorization },
    body: bodyStr,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/** Create a VeFaaS sandbox instance. Returns the sandbox ID. */
export async function createVeFaaSSandbox(
  credentials: VeFaaSCredentials,
  signal?: AbortSignal,
): Promise<string> {
  const req = buildSignedRequest({
    action: "CreateSandbox",
    body: {
      FunctionId: credentials.functionId,
      Timeout: credentials.timeoutMin,
    },
    credentials,
  });

  const response = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal,
  });

  const result = (await response.json()) as {
    Result?: { SandboxId?: string };
    ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
    sandbox_id?: string;
  };

  if (!response.ok || result.ResponseMetadata?.Error) {
    const err = result.ResponseMetadata?.Error;
    throw new Error(
      `CreateSandbox failed: ${err?.Code ?? response.status} — ${err?.Message ?? response.statusText}`,
    );
  }

  const sandboxId = result.Result?.SandboxId ?? result.sandbox_id;
  if (!sandboxId) {
    throw new Error(`CreateSandbox returned no sandbox_id: ${JSON.stringify(result)}`);
  }

  return sandboxId;
}

/** Kill (destroy) a VeFaaS sandbox instance. */
export async function killVeFaaSSandbox(
  credentials: VeFaaSCredentials,
  sandboxId: string,
  signal?: AbortSignal,
): Promise<void> {
  const req = buildSignedRequest({
    action: "KillSandbox",
    body: { FunctionId: credentials.functionId, SandboxId: sandboxId },
    credentials,
  });

  try {
    const response = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }
  } catch (err) {
    // Best-effort — log but don't throw so callers aren't blocked on cleanup
    console.warn(
      `[byteplus-sandbox] KillSandbox(${sandboxId}) failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
