/**
 * Cloud sandbox HTTP client — execute commands and manage files on a VeFaaS
 * sandbox via its API Gateway REST endpoint.
 *
 * Direct port of openclaw-dev/src/agents/sandbox/cloud.ts
 *
 * API endpoints:
 *   POST v1/shell/exec  — execute shell command (batch, not streaming)
 *   GET  v1/sandbox     — health check
 */

export type CloudSandboxConfig = {
  /** API Gateway base URL, e.g. "https://xxx.apigateway-cn-beijing.volceapi.com" */
  endpoint: string;
  /** VeFaaS sandbox instance ID (faasInstanceName). */
  sandboxId: string;
  /** Default working directory inside the sandbox. */
  workdir: string;
  /** Optional bearer token for authentication. */
  token?: string | null;
  /**
   * Reusable shell session ID. When set, successive exec calls share one shell
   * session (preserving cwd and env between calls).
   */
  shellSessionId?: string;
};

export type CloudExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type CloudExecRawResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

// ── Helpers ──────────────────────────────────────────────────────────

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function buildUrl(config: CloudSandboxConfig, apiPath: string): string {
  const base = config.endpoint.replace(/\/+$/, "");
  const sep = apiPath.startsWith("/") ? "" : "/";
  const url = new URL(`${base}${sep}${apiPath}`);
  url.searchParams.set("faasInstanceName", config.sandboxId);
  return url.toString();
}

function buildHeaders(config: CloudSandboxConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.token) {
    headers["Authorization"] = `Bearer ${config.token}`;
  }
  return headers;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Execute a shell command on the cloud sandbox.
 * Commands run in a shared shell session if `config.shellSessionId` is set.
 */
export async function cloudExec(params: {
  config: CloudSandboxConfig;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}): Promise<CloudExecResult> {
  const url = buildUrl(params.config, "v1/shell/exec");

  let command = params.command;

  // Prepend environment variable exports
  if (params.env && Object.keys(params.env).length > 0) {
    const exports = Object.entries(params.env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
      .join("; ");
    command = `${exports}; ${command}`;
  }

  // Change directory if workdir differs from default
  const workdir = params.workdir ?? params.config.workdir;
  if (workdir) {
    command = `cd ${shellEscape(workdir)} && ${command}`;
  }

  const body: Record<string, unknown> = {
    command,
    timeout: params.timeout ?? 300,
  };
  if (params.config.shellSessionId) {
    body.id = params.config.shellSessionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(params.config),
    body: JSON.stringify(body),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Cloud sandbox exec failed: HTTP ${response.status} ${response.statusText}: ${text}`,
    );
  }

  const result = (await response.json()) as {
    success?: boolean;
    message?: string;
    data?: {
      session_id?: string;
      output?: string;
      status?: string;
      exit_code?: number;
    };
  };

  if (!result.success) {
    throw new Error(`Cloud sandbox exec failed: ${result.message ?? "unknown error"}`);
  }

  // Capture the shell session ID for reuse across calls
  if (!params.config.shellSessionId && result.data?.session_id) {
    params.config.shellSessionId = result.data.session_id;
  }

  const output = result.data?.output ?? "";
  const exitCode = result.data?.exit_code ?? (result.data?.status === "completed" ? 0 : 1);

  return { stdout: output, stderr: "", exitCode };
}

/**
 * Execute a shell script with positional arguments, returning Buffer results.
 * Mirrors the signature of `execDockerRaw` for use in the fs-bridge.
 */
export async function cloudExecRaw(params: {
  config: CloudSandboxConfig;
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
}): Promise<CloudExecRawResult> {
  let command: string;
  if (params.args?.length) {
    const escaped = params.args.map((a) => shellEscape(a)).join(" ");
    command = `set -- ${escaped}; ${params.script}`;
  } else {
    command = params.script;
  }

  if (params.stdin !== undefined) {
    const data = typeof params.stdin === "string" ? params.stdin : params.stdin.toString("base64");
    const isBase64 = typeof params.stdin !== "string";
    if (isBase64) {
      command = `echo '${data}' | base64 -d | { ${command}; }`;
    } else {
      command = `printf '%s' ${shellEscape(data)} | { ${command}; }`;
    }
  }

  try {
    const result = await cloudExec({ config: params.config, command, signal: params.signal });
    return {
      stdout: Buffer.from(result.stdout, "utf8"),
      stderr: Buffer.from(result.stderr, "utf8"),
      code: result.exitCode,
    };
  } catch (error) {
    if (params.allowFailure) {
      return {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(String(error), "utf8"),
        code: 1,
      };
    }
    throw error;
  }
}

/** Verify the cloud sandbox is reachable. */
export async function ensureCloudSandboxReady(
  config: CloudSandboxConfig,
  signal?: AbortSignal,
): Promise<void> {
  const url = buildUrl(config, "v1/sandbox");

  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(config),
    signal: signal ?? AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(
      `Cloud sandbox at ${config.endpoint} (${config.sandboxId}) returned HTTP ${response.status}`,
    );
  }

  const result = (await response.json()) as { success?: boolean; message?: string };
  if (!result.success) {
    throw new Error(
      `Cloud sandbox at ${config.endpoint} (${config.sandboxId}) not ready: ${result.message ?? "unknown"}`,
    );
  }
}
