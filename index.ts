/**
 * BytePlus Volcengine Sandbox plugin for OpenClaw.
 *
 * Registers a "byteplus" sandbox backend that provisions and manages
 * Volcengine ECS instances as isolated code-execution environments for agents.
 *
 * Usage in openclaw.json:
 * {
 *   "plugins": {
 *     "allow": ["byteplus-sandbox"],
 *     "entries": {
 *       "byteplus-sandbox": {
 *         "config": {
 *           "accessKeyId": "AK...",
 *           "secretAccessKey": "SK...",
 *           "image": "cr.volces.com/my-org/sandbox:latest",
 *           "vpcId": "vpc-xxx",
 *           "subnetId": "subnet-xxx",
 *           "securityGroupId": "sg-xxx",
 *           "keyPairName": "my-keypair",
 *           "sshPrivateKey": "-----BEGIN RSA PRIVATE KEY-----\n..."
 *         }
 *       }
 *     }
 *   },
 *   "agents": {
 *     "defaults": {
 *       "sandbox": {
 *         "mode": "all",
 *         "backend": "byteplus"
 *       }
 *     }
 *   }
 * }
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerSandboxBackend } from "openclaw/plugin-sdk/sandbox";
import { createByteplusSandboxFactory } from "./src/backend.js";
import { resolveConfig } from "./src/config.js";
import { createByteplusSandboxManager } from "./src/manager.js";

const plugin = {
  id: "byteplus-sandbox",

  register(api: OpenClawPluginApi): void {
    if (api.registrationMode !== "full") {
      return;
    }

    const cfg = resolveConfig(api.pluginConfig);

    registerSandboxBackend("byteplus", {
      factory: createByteplusSandboxFactory(cfg),
      manager: createByteplusSandboxManager(cfg),
    });
  },
};

export default plugin;
