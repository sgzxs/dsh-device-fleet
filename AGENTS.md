# dsh-device-fleet — Agent instructions

This repository is a DeepSeek Harness plugin (Host + Client) for a multi-device Fleet.

## Using the Fleet at runtime

Read [docs/AGENT-GUIDE.md](docs/AGENT-GUIDE.md) before calling `fleet_*` / `room_*` tools.

Key rules:

- `fleet_list` first; offline fails fast — do not busy-retry.
- Direct calls are stateless; use `fleet_delegate` when the target agent must do a self-contained task.
- Target Tool Policy decides `allow/ask/deny`; never bypass approvals.
- Never expose Fleet keys, invite codes, private keys, or certificate keys.
- `fleet_revoke_device` / `fleet_reset_identity` / rotation fork decisions require explicit user confirmation (`confirm: true`).
- Plugin update / `fleet_join` / `fleet_connect` are hot operations: reload the plugin, do not restart DSH unless the plugin manager cannot reload.

## Editing this repository

- Run `node scripts/ci.mjs` before publishing; run the doc guard:
  `python "$env:USERPROFILE\\.dsh\\skills\\doc-ledger\\scripts\\check_docs.py" --root C:\\Users\\PS\\.dsh\\plugins\\dsh-device-fleet`
- Keep [docs/STATUS.md](docs/STATUS.md) as the single source of truth for version/status; README is installation/usage only.
- If adding a published script or doc, add it to `package.json` `files` (the npm package excludes tests).
- Do not commit secrets; invite codes embed the Fleet key.
