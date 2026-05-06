---
name: codex-ollama-bridge
version: 0.3.0
description: Operate the local Codex Ollama bridge that exposes openai-codex/gpt-5.4-mini through Ollama and OpenAI-compatible endpoints, using OpenClaw OAuth.
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["node"]
      files: ["~/.openclaw/agents/main/agent/auth-profiles.json"]
---

# Codex Ollama Bridge

A single-file local HTTP proxy that re-uses OpenClaw's OAuth profile to talk
to OpenAI Codex, exposes both **OpenAI** and **Ollama** APIs at
`http://127.0.0.1:11540`.

Use this skill when the user wants to:

- Chat with Codex from a terminal via `ollama run codex:latest`
- Use Codex as the LLM in `memory-lancedb-pro` or any other OpenAI-compatible
  client (`baseURL: http://127.0.0.1:11540/v1`)
- Quickly install/check the bridge and wire OpenClaw `memory-lancedb-pro`
  against it

## Defaults

- Bridge URL: `http://127.0.0.1:11540`
- OpenAI base URL: `http://127.0.0.1:11540/v1`
- Default model: `openai-codex/gpt-5.4-mini`
- Codex aliases: `codex:latest`, `codex:gpt-5.4-mini`, `codex:gpt-5.5`,
  `gpt-5.4-mini`, `gpt-5.5`, `openai-codex/gpt-5.4-mini`,
  `openai-codex/gpt-5.5`
- Auth: OpenClaw `auth-profiles.json`, profile `openai-codex:default`
  (auto-falls-back to any other live `openai-codex:*` profile)

## Fast OpenClaw setup

From the repo root:

```bash
npm run openclaw:setup
```

This installs the user systemd service, backs up and merges
`~/.openclaw/openclaw.json`, enables `memory-lancedb-pro` as the memory slot,
points the plugin's LLM block at `http://127.0.0.1:11540/v1`, and checks the
bridge plus Ollama embeddings.

Useful variants:

```bash
scripts/openclaw-fast-setup.sh check
scripts/openclaw-fast-setup.sh all --restart-openclaw
scripts/openclaw-fast-setup.sh check --chat-check
```

## Start

Foreground:

```bash
cd ~/Documents/openclaw-jetson-install/codex-ollama-bridge
npm start
```

As a user service:

```bash
cp ~/Documents/openclaw-jetson-install/codex-ollama-bridge/systemd/codex-ollama-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-ollama-bridge
journalctl --user -u codex-ollama-bridge -f
```

## Chat through Ollama

```bash
OLLAMA_HOST=http://127.0.0.1:11540 ollama run codex:latest
```

One-shot:

```bash
OLLAMA_HOST=http://127.0.0.1:11540 ollama run codex:latest "say ok"
OLLAMA_HOST=http://127.0.0.1:11540 ollama run openai-codex/gpt-5.5 "say ok"
```

Direct API (bypasses the CLI — useful for debugging):

```bash
curl -sS http://127.0.0.1:11540/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"codex:latest","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## Use as an OpenAI endpoint

```text
baseURL: http://127.0.0.1:11540/v1
model:   openai-codex/gpt-5.4-mini
apiKey:  any non-empty string (bridge uses local OAuth)
```

## Patch `memory-lancedb-pro` to use this bridge

`memory-lancedb-pro` has a configurable LLM block — no code change needed.
For the fast path, run:

```bash
scripts/openclaw-fast-setup.sh configure-memory --restart-openclaw
```

Manual setup is also simple. Edit `~/.openclaw/openclaw.json` and set:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "config": {
          "llm": {
            "baseURL": "http://127.0.0.1:11540/v1",
            "model":   "openai-codex/gpt-5.4-mini",
            "apiKey":  "codex-bridge"
          }
        }
      }
    }
  }
}
```

Leave the `embedding` block alone — Codex doesn't expose embeddings, so keep
your existing embedder (e.g. Ollama `nomic-embed-text`). Restart OpenClaw to
pick up the change.

Verify with:

```bash
curl -sS http://127.0.0.1:11540/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai-codex/gpt-5.4-mini","messages":[{"role":"user","content":"ok"}],"stream":false}'
```

Common pitfall: write the model id with a forward slash
(`openai-codex/gpt-5.4-mini`), **not** a backslash.

## Environment

| Var | Default |
|---|---|
| `CODEX_BRIDGE_HOST` | `127.0.0.1` |
| `CODEX_BRIDGE_PORT` | `11540` |
| `CODEX_BRIDGE_MODEL` | `openai-codex/gpt-5.4-mini` |
| `CODEX_BRIDGE_OAUTH_PATH` | `~/.openclaw/agents/main/agent/auth-profiles.json` |
| `CODEX_BRIDGE_OAUTH_PROFILE` | `openai-codex:default` |

To pin a specific profile and silence fallback log lines, write
`~/.config/codex-ollama-bridge/env`:

```bash
CODEX_BRIDGE_OAUTH_PROFILE=openai-codex:<your-email>
```

## Troubleshooting

- **Ollama CLI: "something went wrong, please see the ollama server logs"** —
  generic CLI error. Run the equivalent `curl` against `/api/chat` to see the
  real upstream error.
- **`refresh_token_reused`** — that profile's refresh token has already been
  spent. Bridge auto-falls-back if another `openai-codex:*` profile is live;
  otherwise re-authenticate in OpenClaw.
- **`No usable openai-codex:* profile`** — no live Codex profile in
  `auth-profiles.json`. Log into OpenClaw with the Codex provider.
- **`address already in use`** — another process is on `11540`; set
  `CODEX_BRIDGE_PORT` or `pkill -f codex-bridge.mjs`.
- **`model_not_found`** — the upstream account doesn't have access to the
  configured model. Set `CODEX_BRIDGE_MODEL` to something the account can use.

---

## Health Check

Run this after setup (or any time you suspect the pipeline is broken):

```bash
bash ~/.openclaw/tools/scripts/check-memory.sh
# or if installed from the repo:
bash ~/path/to/copilot-ollama-bridge/scripts/check-memory.sh
```

What it checks (no `curl` required — uses `node` for HTTP tests):

| Check | How |
|---|---|
| Bridge service active | `systemctl --user is-active` |
| LLM endpoint replies | HTTP POST to `/v1/chat/completions` |
| Ollama embedding returns vectors | HTTP POST to `/v1/embeddings` |
| Plugin configured in `openclaw.json` | Direct JSON parse (avoids CLI hang) |
| LanceDB files present | `~/.openclaw/memory/lancedb-pro/` |
| Embedding pipeline | Two parallel embed calls |
| autoRecall firing | `openclaw logs --plain` grep |

**Known limitation:** `openclaw memory-pro stats/search` hang in non-TTY
contexts (background `setInterval` keeps Node alive — upstream bug in
`memory-lancedb-pro@1.1.0-beta.9`). The script works around this by reading
`openclaw.json` and the LanceDB directory directly instead of using the CLI.
Apply the CLI patch in `patches/` (if present) to fix the CLI if needed.

**`usage_limit_reached` warning:**
If the bridge LLM check returns a usage-limit warning, smart extraction calls
will fail until the quota resets (the `resets_at` timestamp is shown). Embedding
and recall still work — only new memory extraction is affected.

Environment overrides:
```bash
CODEX_BRIDGE_MODEL=openai-codex/gpt-5.5 \
MEMORY_EMBED_MODEL=mxbai-embed-large \
bash scripts/check-memory.sh
```
