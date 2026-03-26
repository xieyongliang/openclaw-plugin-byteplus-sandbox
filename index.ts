import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createByteplusSandboxFactory } from "./src/backend.js";
import { createByteplusSandboxManager } from "./src/manager.js";
import { resolveConfig } from "./src/config.js";

export default definePluginEntry({
  id: "byteplus-sandbox",
  setup(api: OpenClawPluginApi) {
    const cfg = resolveConfig(api.getPluginConfig?.() ?? {});

    api.registerSandboxBackend("byteplus", {
      factory: createByteplusSandboxFactory(cfg),
      manager: createByteplusSandboxManager(cfg),
    });
  },
});
