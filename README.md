# openclaw-plugin-byteplus-sandbox

OpenClaw plugin that provides a **Volcengine (BytePlus) cloud sandbox backend** for agent code execution.

Agents using this plugin run code inside on-demand Volcengine ECS instances, connected via SSH. Instances are provisioned automatically on first use, reused across sessions, and pruned after configurable idle / age limits.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) >= 2026.3.22
- A [Volcengine](https://www.volcengine.com/) account with ECS access
- A pre-configured VPC, subnet, security group (inbound SSH on port 22), and key pair

## Installation

```bash
openclaw plugins install openclaw-plugin-byteplus-sandbox
```

Or link a local development copy:

```bash
openclaw plugins install --link /path/to/openclaw-plugin-byteplus-sandbox
```

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "allow": ["byteplus-sandbox"],
    "entries": {
      "byteplus-sandbox": {
        "config": {
          "accessKeyId": "AK...",
          "secretAccessKey": "SK...",
          "region": "cn-beijing",
          "image": "cr.volces.com/my-org/sandbox:latest",
          "instanceType": "ecs.c3i.large",
          "vpcId": "vpc-xxx",
          "subnetId": "subnet-xxx",
          "securityGroupId": "sg-xxx",
          "keyPairName": "my-keypair",
          "sshPrivateKey": "-----BEGIN RSA PRIVATE KEY-----\n..."
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

Alternatively, set credentials via environment variables:

```bash
export BYTEPLUS_ACCESS_KEY_ID=AK...
export BYTEPLUS_SECRET_ACCESS_KEY=SK...
```

## Configuration Reference

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `accessKeyId` | ✅ | — | Volcengine Access Key ID |
| `secretAccessKey` | ✅ | — | Volcengine Secret Access Key |
| `image` | ✅ | — | Container/AMI image ID or name |
| `vpcId` | ✅ | — | VPC ID |
| `subnetId` | ✅ | — | Subnet ID |
| `securityGroupId` | ✅ | — | Security group ID (must allow SSH inbound) |
| `keyPairName` | ✅ | — | Pre-created ECS key pair name |
| `sshPrivateKey` | ✅ | — | PEM private key matching keyPairName |
| `region` | | `cn-beijing` | Volcengine region |
| `instanceType` | | `ecs.c3i.large` | ECS instance type |
| `sshUser` | | `root` | SSH login user |
| `remoteWorkspaceDir` | | `/workspace` | Workspace directory on the instance |
| `containerPrefix` | | `openclaw-sandbox` | Prefix for ECS instance names |
| `timeoutSeconds` | | `180` | Instance startup timeout |
| `idleHours` | | `2` | Auto-delete idle instances after N hours (0 = off) |
| `maxAgeDays` | | `7` | Auto-delete instances older than N days (0 = off) |

## How it works

1. **First use**: The plugin provisions a new Volcengine ECS instance using `RunInstances` API.
2. **Instance naming**: Instance name is derived from a hash of the `scopeKey` (workspace + session context), prefixed with `containerPrefix`.
3. **Reuse**: On subsequent calls, the existing instance is reused (or restarted if stopped).
4. **Config change detection**: If the image or instance type changes, the old instance is deleted and a new one is created.
5. **SSH execution**: Commands run over SSH using OpenClaw's `runSshSandboxCommand` infrastructure.
6. **File bridge**: File operations use `createRemoteShellSandboxFsBridge` (remote-shell mode, no local mirroring).
7. **Pruning**: Stale instances (idle or too old) are automatically cleaned up.

## Instance registry

The plugin maintains a local registry at `~/.openclaw/byteplus-sandbox-registry.json` that maps instance names to Volcengine instance IDs. This file is local to each machine.

## License

MIT
