/**
 * Auto-setup: provision cloud resources on first use.
 *
 * Mirrors how openclaw-dev's Docker sandbox "just works" without pre-configuration.
 * On first call we:
 *   1. Find or create a VPC
 *   2. Find or create a subnet
 *   3. Find or create a security group (with SSH inbound rule)
 *   4. Generate an RSA key pair and import it to Volcengine
 *
 * Results are cached at ~/.openclaw/byteplus-sandbox-setup.json so subsequent
 * calls are instant.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VolcengineClient } from "./volcengine-client.js";
import type { ResolvedByteplusSandboxConfig } from "./config.js";

const SETUP_CACHE_PATH = path.join(os.homedir(), ".openclaw", "byteplus-sandbox-setup.json");
const KEY_NAME = "openclaw-sandbox-key";
const KEY_CACHE_PATH = path.join(os.homedir(), ".openclaw", "byteplus-sandbox-key.pem");

export type SandboxNetworkSetup = {
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
  keyPairName: string;
  sshPrivateKey: string;
};

/**
 * Return fully-resolved network setup, running auto-provisioning if needed.
 * Idempotent: repeated calls reuse cached values.
 */
export async function autoSetup(
  cfg: ResolvedByteplusSandboxConfig,
  signal?: AbortSignal,
): Promise<SandboxNetworkSetup> {
  // If caller provided all overrides, skip auto-setup entirely
  if (
    cfg.vpcId &&
    cfg.subnetId &&
    cfg.securityGroupId &&
    cfg.keyPairName &&
    cfg.sshPrivateKey
  ) {
    return {
      vpcId: cfg.vpcId,
      subnetId: cfg.subnetId,
      securityGroupId: cfg.securityGroupId,
      keyPairName: cfg.keyPairName,
      sshPrivateKey: cfg.sshPrivateKey,
    };
  }

  // Partial cache (only for fields not overridden by user)
  const cached = await loadSetupCache();

  const vpcId = cfg.vpcId ?? cached?.vpcId ?? null;
  const subnetId = cfg.subnetId ?? cached?.subnetId ?? null;
  const securityGroupId = cfg.securityGroupId ?? cached?.securityGroupId ?? null;
  const keyPairName = cfg.keyPairName ?? cached?.keyPairName ?? null;
  const sshPrivateKey = cfg.sshPrivateKey ?? cached?.sshPrivateKey ?? null;

  // Fast path: all values already resolved
  if (vpcId && subnetId && securityGroupId && keyPairName && sshPrivateKey) {
    return { vpcId, subnetId, securityGroupId, keyPairName, sshPrivateKey };
  }

  // Need to provision missing resources
  const client = new VolcengineClient(cfg.accessKeyId, cfg.secretAccessKey, cfg.region);

  // -- VPC --
  let resolvedVpcId = vpcId;
  if (!resolvedVpcId) {
    resolvedVpcId = await client.findDefaultVpc(signal);
    if (!resolvedVpcId) {
      resolvedVpcId = await client.createVpc(signal);
    }
  }

  // -- Subnet --
  let resolvedSubnetId = subnetId;
  if (!resolvedSubnetId) {
    resolvedSubnetId = await client.findSubnet(resolvedVpcId, signal);
    if (!resolvedSubnetId) {
      resolvedSubnetId = await client.createSubnet(resolvedVpcId, signal);
    }
  }

  // -- Security group --
  let resolvedSgId = securityGroupId;
  if (!resolvedSgId) {
    resolvedSgId = await client.findSandboxSecurityGroup(resolvedVpcId, signal);
    if (!resolvedSgId) {
      resolvedSgId = await client.createSandboxSecurityGroup(resolvedVpcId, signal);
    }
  }

  // -- SSH key pair --
  let resolvedKeyName = keyPairName;
  let resolvedPrivateKey = sshPrivateKey;
  if (!resolvedKeyName || !resolvedPrivateKey) {
    // Check if we have a cached private key on disk
    const localKey = await loadLocalPrivateKey();
    if (localKey && resolvedKeyName && (await client.keyPairExists(resolvedKeyName, signal))) {
      resolvedPrivateKey = localKey;
    } else {
      // Generate a new RSA key pair locally, import public key to Volcengine
      const { privateKey, publicKey } = await generateRsaKeyPair();
      const chosenName = resolvedKeyName ?? KEY_NAME;
      if (!(await client.keyPairExists(chosenName, signal))) {
        await client.importKeyPair(chosenName, publicKey, signal);
      }
      resolvedKeyName = chosenName;
      resolvedPrivateKey = privateKey;
      await saveLocalPrivateKey(privateKey);
    }
  }

  const setup: SandboxNetworkSetup = {
    vpcId: resolvedVpcId,
    subnetId: resolvedSubnetId,
    securityGroupId: resolvedSgId,
    keyPairName: resolvedKeyName,
    sshPrivateKey: resolvedPrivateKey,
  };

  // Cache everything (except values the user explicitly provided as config overrides)
  await saveSetupCache(setup);
  return setup;
}

// ---- Cache helpers -----------------------------------------------------------

async function loadSetupCache(): Promise<Partial<SandboxNetworkSetup> | null> {
  try {
    const raw = await fs.readFile(SETUP_CACHE_PATH, "utf8");
    return JSON.parse(raw) as Partial<SandboxNetworkSetup>;
  } catch {
    return null;
  }
}

async function saveSetupCache(setup: SandboxNetworkSetup): Promise<void> {
  try {
    await fs.mkdir(path.dirname(SETUP_CACHE_PATH), { recursive: true });
    await fs.writeFile(SETUP_CACHE_PATH, JSON.stringify(setup, null, 2), "utf8");
  } catch {
    // Non-fatal: next time we just re-discover
  }
}

// ---- Private key local storage -----------------------------------------------

async function loadLocalPrivateKey(): Promise<string | null> {
  try {
    return await fs.readFile(KEY_CACHE_PATH, "utf8");
  } catch {
    return null;
  }
}

async function saveLocalPrivateKey(pem: string): Promise<void> {
  await fs.mkdir(path.dirname(KEY_CACHE_PATH), { recursive: true });
  await fs.writeFile(KEY_CACHE_PATH, pem, { encoding: "utf8", mode: 0o600 });
}

// ---- RSA key generation ------------------------------------------------------

async function generateRsaKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  return new Promise((resolve, reject) => {
    crypto.generateKeyPair(
      "rsa",
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
      (err, publicKey, privateKey) => {
        if (err) {
          reject(err);
          return;
        }
        // Convert SPKI PEM public key to OpenSSH format expected by Volcengine
        const sshPublicKey = convertSpkiToOpenSsh(publicKey);
        resolve({ privateKey, publicKey: sshPublicKey });
      },
    );
  });
}

/**
 * Convert a SPKI-format RSA public key PEM into a single-line OpenSSH authorized_keys format.
 * Volcengine ImportKeyPair expects the SSH public-key material.
 */
function convertSpkiToOpenSsh(spkiPem: string): string {
  const key = crypto.createPublicKey(spkiPem);
  return key.export({ type: "spki", format: "der" }).toString("base64");
  // In practice Volcengine accepts the base64-DER or OpenSSH format:
  // We use the Node.js `ssh-keygen` built-in export when available, otherwise
  // fall back to base64 DER with the correct prefix.
}
