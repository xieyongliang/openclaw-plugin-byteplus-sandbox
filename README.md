# openclaw-plugin-byteplus-sandbox

[BytePlus VeFaaS](https://www.byteplus.com/en/product/vefaas) cloud sandbox backend for [OpenClaw](https://github.com/openclaw/openclaw).

Commands run over HTTP through a BytePlus API Gateway endpoint — **no SSH, no VPC, no security group configuration needed**. Just point it at your API Gateway URL.

## Requirements

- OpenClaw >= 2026.3.22
- A BytePlus VeFaaS sandbox instance (pre-existing or auto-created)
- BytePlus API Gateway endpoint for the VeFaaS function

## Installation

```bash
openclaw plugins install byteplus-sandbox-plugin
```

## Configuration

Configuration is split into two parts: **credentials** (AK/SK, via env vars) and **connection settings** (endpoint, functionId, etc., via `openclaw config set`).

### Step 1 — Set credentials (AK/SK)

Run the onboarding wizard to be prompted for your BytePlus Access Key and Secret Key. These are stored as environment variables, not in the config file:

```bash
openclaw onboard
# → Select "BytePlus Cloud Sandbox" → enter BYTEPLUS_ACCESS_KEY_ID and BYTEPLUS_SECRET_ACCESS_KEY
```

Or set them directly in your shell profile:

```bash
export BYTEPLUS_ACCESS_KEY_ID="your-access-key-id"
export BYTEPLUS_SECRET_ACCESS_KEY="your-secret-access-key"
```

### Step 2 — Set connection config

Use `openclaw config set` to configure the endpoint and (optionally) the VeFaaS function ID:

```bash
# API Gateway endpoint (required)
openclaw config set plugins.entries.byteplus-sandbox.config.endpoint \
  "https://xxx.apigateway-ap-southeast-1.apigw-byteplus.com"

# VeFaaS function ID — needed for auto-create mode (see below)
openclaw config set plugins.entries.byteplus-sandbox.config.functionId "your-function-id"

# Optional: pre-existing sandbox instance ID (skips auto-create)
openclaw config set plugins.entries.byteplus-sandbox.config.sandboxId "your-instance-id"

# Optional: working directory inside the sandbox (default: /home/gem)
openclaw config set plugins.entries.byteplus-sandbox.config.workdir "/home/gem"

# Optional: sandbox timeout in minutes (default: 60)
openclaw config set plugins.entries.byteplus-sandbox.config.timeoutMin 60

# Optional: BytePlus region (default: ap-southeast-1)
openclaw config set plugins.entries.byteplus-sandbox.config.region "ap-southeast-1"
```

### Step 3 — Enable sandbox in agent defaults

```bash
openclaw config set agents.defaults.sandbox.mode all
openclaw config set agents.defaults.sandbox.backend byteplus
```

### Quick Start: Option A — Connect to an existing sandbox

```bash
export BYTEPLUS_ACCESS_KEY_ID=your-ak
export BYTEPLUS_SECRET_ACCESS_KEY=your-sk
openclaw config set plugins.entries.byteplus-sandbox.config.endpoint "https://xxx.apigateway-..."
openclaw config set plugins.entries.byteplus-sandbox.config.sandboxId "your-instance-id"
openclaw config set agents.defaults.sandbox.mode all
openclaw config set agents.defaults.sandbox.backend byteplus
```

### Quick Start: Option B — Auto-create sandbox on first use

Omit `sandboxId` and provide `functionId` instead. The plugin will call `CreateSandbox` on first use and cache the result in `~/.openclaw/byteplus-sandbox-registry.json`. The sandbox is killed when the agent process exits.

```bash
export BYTEPLUS_ACCESS_KEY_ID=your-ak
export BYTEPLUS_SECRET_ACCESS_KEY=your-sk
openclaw config set plugins.entries.byteplus-sandbox.config.endpoint "https://xxx.apigateway-..."
openclaw config set plugins.entries.byteplus-sandbox.config.functionId "your-function-id"
openclaw config set agents.defaults.sandbox.mode all
openclaw config set agents.defaults.sandbox.backend byteplus
```

## How It Works

```
OpenClaw Agent
    │
    │  runShellCommand / exec tool
    ▼
Plugin backend (src/backend.ts)
    │
    │  HTTP POST v1/shell/exec
    ▼
BytePlus API Gateway
    │
    │  routes via faasInstanceName=<sandboxId>
    ▼
VeFaaS sandbox instance
    └─ shell commands execute here
```

No SSH tunnels, no VMs to manage. The sandbox is a serverless container.

## Configuration Reference

### Plugin config keys (`plugins.entries.byteplus-sandbox.config.*`)

| Key | Default | Description |
|-----|---------|-------------|
| `endpoint` | — | **Required.** BytePlus API Gateway base URL |
| `sandboxId` | auto | VeFaaS instance ID. Omit to auto-create |
| `workdir` | `/home/gem` | Working directory inside the sandbox |
| `token` | — | Bearer token for API Gateway auth |
| `functionId` | — | VeFaaS function ID (required for auto-create) |
| `timeoutMin` | `60` | Sandbox timeout in minutes |
| `region` | `ap-southeast-1` | BytePlus region for VeFaaS API |

Set any key with: `openclaw config set plugins.entries.byteplus-sandbox.config.<key> <value>`

### Credentials (environment variables only)

AK/SK are credentials and are **not** stored in the config file. Set them as environment variables:

| Variable | Description |
|----------|-------------|
| `BYTEPLUS_ACCESS_KEY_ID` | BytePlus Access Key ID (required for auto-create) |
| `BYTEPLUS_SECRET_ACCESS_KEY` | BytePlus Secret Access Key (required for auto-create) |

Use `openclaw onboard` after installation to be prompted for these values interactively.

## Getting the API Gateway URL

In the BytePlus console:
1. Open **VeFaaS** → your function
2. Click **API Gateway** or **Trigger configuration**
3. Copy the endpoint URL (format: `https://xxx.apigateway-ap-southeast-1.apigw-byteplus.com`)

## License

MIT
