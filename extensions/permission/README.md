# Permission Extension

Layered permission control for pi-coding-agent.

## Levels

| Level | Description | Allowed Operations |
|-------|-------------|-------------------|
| **minimal** | Read-only (default) | `cat`, `ls`, `grep`, `git status/log/diff`, `npm list` |
| **low** | File operations | + `write`/`edit` files |
| **medium** | Dev operations | + `npm install`, `git commit`, build commands |
| **high** | Full operations | + `git push`, deployments, scripts |

**Dangerous commands** (always prompt, even at high): `sudo`, `rm -rf`, `chmod 777`, `dd`, `mkfs`

## Usage

### Interactive Mode

```bash
pi
```

**Commands:**
- `/permission` - Show selector to change level
- `/permission medium` - Set level directly (asks session/global)
- `/permission-mode` - Switch between ask/block when permission is required
- `/permission-mode block` - Block instead of prompting

### Print Mode

```bash
PI_PERMISSION_LEVEL=medium pi -p "install deps and run tests"
```

## Environment Variables

| Variable | Values | Description |
|----------|--------|-------------|
| `PI_PERMISSION_LEVEL` | `minimal`, `low`, `medium`, `high`, `bypassed` | Set permission level |

## Settings

Global settings stored in `~/.pi/agent/settings.json`:

```json
{
  "permissionLevel": "medium",
  "permissionMode": "ask"
}
```
