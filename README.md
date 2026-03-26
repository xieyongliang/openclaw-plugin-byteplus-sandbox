# openclaw-plugin-byteplus-sandbox

On-demand [Volcengine ECS](https://www.volcengine.com/products/ecs) cloud sandbox backend for [OpenClaw](https://github.com/openclaw/openclaw).

Designed to work like OpenClaw's local Docker sandbox — **just set your image and credentials, and the plugin handles the rest**. On first use, it automatically provisions a VPC, subnet, security group (with SSH inbound), and SSH key pair. Subsequent runs reuse or restart the same instance.

## Requirements

- OpenClaw >= 2026.3.22
- Volcengine account with ECS + VPC API access
- Credentials: `BYTEPLUS_ACCESS_KEY_ID` and `BYTEPLUS_SECRET_ACCESS_KEY` environment variables

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install openclaw-plugin-byteplus-sandbox
```

### 2. Set credentials

```bash
export BYTEPLUS_ACCESS_KEY_ID=your-ak
export BYTEPLUS_SECRET_ACCESS_KEY=your-sk
```

Or add them to `~/.profile` / `~/.zshrc` for persistence.

### 3. Configure OpenClaw

Add to your `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "allow": ["byteplus-sandbox"]
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

That's it. No VPC ID, no subnet, no security group, no SSH keys to manage.

### 4. (Optional) Specify a custom image

```json
{
  "plugins": {
    "allow": ["byteplus-sandbox"],
    "entries": {
      "byteplus-sandbox": {
        "config": {
          "image": "cr.volces.com/my-org/sandbox:latest"
        }
      }
    }
  }
}
```

## How It Works

On first use, the plugin automatically:

1. **Finds or creates a VPC** — uses the account's default VPC, or creates `openclaw-sandbox-vpc`
2. **Finds or creates a subnet** — reuses existing subnet in the VPC, or creates `openclaw-sandbox-subnet`
3. **Creates a security group** — `openclaw-sandbox` with inbound SSH (port 22) rule
4. **Generates an SSH key pair** — creates an RSA-2048 key, imports the public key to Volcengine as `openclaw-sandbox-key`, stores the private key at `~/.openclaw/byteplus-sandbox-key.pem`

All results are cached in `~/.openclaw/byteplus-sandbox-setup.json`. Subsequent calls skip auto-setup.

Instance lifecycle:
- **Create** — on first sandbox request for a scope key
- **Reuse** — if the same instance is Running or Stopped (auto-started)
- **Recreate** — if the `image` or `instanceType` changes (detected via config hash)
- **Prune** — idle instances (default: 24h) and old instances (default: 7 days) are cleaned up automatically

## Configuration Reference

All fields are optional (credentials come from environment variables):

| Field | Default | Description |
|-------|---------|-------------|
| `image` | `cr.volces.com/openclaw/sandbox:latest` | Container image to run |
| `region` | `cn-beijing` | Volcengine region |
| `instanceType` | `ecs.c3i.large` | ECS instance type |
| `remoteWorkspaceDir` | `/workspace` | Working directory in instance |
| `sshUser` | `root` | SSH login user |
| `containerPrefix` | `openclaw-sbx-` | Prefix for instance names |
| `timeoutSeconds` | `180` | Startup wait timeout |
| `idleHours` | `24` | Prune after idle hours (0 = off) |
| `maxAgeDays` | `7` | Prune after max age (0 = off) |
| `vpcId` | auto | Override: skip auto-detect VPC |
| `subnetId` | auto | Override: skip auto-detect subnet |
| `securityGroupId` | auto | Override: skip auto-create security group |
| `keyPairName` | auto | Override: use existing key pair |
| `sshPrivateKey` | auto | Override: provide SSH private key directly |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BYTEPLUS_ACCESS_KEY_ID` | Volcengine Access Key ID |
| `BYTEPLUS_SECRET_ACCESS_KEY` | Volcengine Secret Access Key |

Aliases `VOLCENGINE_ACCESS_KEY_ID` / `VOLCENGINE_SECRET_ACCESS_KEY` are also accepted.

## Advanced: Skip Auto-Setup

If you have existing cloud resources and want to skip auto-provisioning entirely, provide all five override fields:

```json
{
  "plugins": {
    "entries": {
      "byteplus-sandbox": {
        "config": {
          "image": "cr.volces.com/my-org/sandbox:latest",
          "vpcId": "vpc-xxx",
          "subnetId": "subnet-xxx",
          "securityGroupId": "sg-xxx",
          "keyPairName": "my-key",
          "sshPrivateKey": "-----BEGIN PRIVATE KEY-----\n..."
        }
      }
    }
  }
}
```

## License

MIT
