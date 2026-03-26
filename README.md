# openclaw-plugin-byteplus-sandbox

[Volcengine VeFaaS](https://www.volcengine.com/products/vefaas) cloud sandbox backend for [OpenClaw](https://github.com/openclaw/openclaw).

Commands run over HTTP through a Volcengine API Gateway endpoint — **no SSH, no VPC, no security group configuration needed**. Just point it at your API Gateway URL.

## Requirements

- OpenClaw >= 2026.3.22
- A Volcengine VeFaaS sandbox instance (pre-existing or auto-created)
- Volcengine API Gateway endpoint for the VeFaaS function

## Quick Start

### Option A — Connect to an existing sandbox

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["byteplus-sandbox"],
    "entries": {
      "byteplus-sandbox": {
        "config": {
          "endpoint": "https://xxx.apigateway-cn-beijing.volceapi.com",
          "sandboxId": "your-vefaas-instance-id"
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all",
        "backend": "byteplus"
      }
    }
  }
}
```

### Option B — Auto-create sandbox on first use

Set credentials and provide your VeFaaS function ID:

```bash
export BYTEPLUS_ACCESS_KEY_ID=your-ak
export BYTEPLUS_SECRET_ACCESS_KEY=your-sk
```

```json
{
  "plugins": {
    "allow": ["byteplus-sandbox"],
    "entries": {
      "byteplus-sandbox": {
        "config": {
          "endpoint": "https://xxx.apigateway-cn-beijing.volceapi.com",
          "functionId": "your-vefaas-function-id",
          "timeoutMin": 60
        }
      }
    }
  },
  "agents": {
    "defaults": {
      "sandbox": { "mode": "all", "backend": "byteplus" }
    }
  }
}
```

When `sandboxId` is omitted, the plugin calls `CreateSandbox` on first use and caches the result in `~/.openclaw/byteplus-sandbox-registry.json`. The sandbox is killed when the agent process exits.

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
Volcengine API Gateway
    │
    │  routes via faasInstanceName=<sandboxId>
    ▼
VeFaaS sandbox instance
    └─ shell commands execute here
```

No SSH tunnels, no VMs to manage. The sandbox is a serverless container.

## Configuration Reference

| Field | Default | Description |
|-------|---------|-------------|
| `endpoint` | — | **Required.** API Gateway base URL |
| `sandboxId` | auto | VeFaaS instance ID. Omit to auto-create |
| `workdir` | `/home/gem` | Working directory in sandbox |
| `token` | — | Bearer token for API Gateway auth |
| `functionId` | — | VeFaaS function ID (for auto-create) |
| `timeoutMin` | `60` | Sandbox timeout in minutes |
| `region` | `cn-beijing` | Volcengine region |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BYTEPLUS_ACCESS_KEY_ID` | Volcengine AK (for auto-create) |
| `BYTEPLUS_SECRET_ACCESS_KEY` | Volcengine SK (for auto-create) |

Aliases `VOLCENGINE_ACCESS_KEY_ID` / `VOLCENGINE_SECRET_ACCESS_KEY` also work.

## Getting the API Gateway URL

In the Volcengine console:
1. Open **VeFaaS** → your function
2. Click **API Gateway** or **Trigger configuration**
3. Copy the endpoint URL

## License

MIT
