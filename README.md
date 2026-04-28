# Codex Ollama Bridge

A single-file local HTTP proxy that exposes an OpenAI Codex model to:

- **Ollama clients** (`ollama run codex:latest`, anything with `OLLAMA_HOST`)
- **OpenAI-compatible clients** (`memory-lancedb-pro`, OpenAI Python/JS SDK, `curl`)

It re-uses the **OpenClaw OAuth profile** you already have — no separate login,
no API key. The bridge reads
`~/.openclaw/agents/main/agent/auth-profiles.json`, picks a live
`openai-codex:*` profile, and refreshes the token automatically.

```
┌──────────────────┐   /v1/chat/completions   ┌────────────────────┐
│ memory-lancedb   │ ───────────────────────► │                    │
│ OpenAI SDK, etc. │                          │                    │
└──────────────────┘                          │  codex-bridge.mjs  │     OAuth
                                              │ 127.0.0.1:11540    │ ──────────► chatgpt.com
┌──────────────────┐   /api/chat, /api/tags   │                    │             /backend-api
│  ollama run …    │ ───────────────────────► │                    │             /codex/responses
└──────────────────┘                          └────────────────────┘
```

Default model: `openai-codex/gpt-5.4-mini`
Default endpoint: `http://127.0.0.1:11540`

---

## 1. Start the bridge

### One-off (foreground)

```bash
cd ~/Documents/openclaw-jetson-install/codex-ollama-bridge
npm start
```

You should see:

```
[codex-bridge] Listening on http://127.0.0.1:11540
  OpenAI endpoint : http://127.0.0.1:11540/v1/chat/completions
  Ollama compat   : http://127.0.0.1:11540/api/chat
  Model list      : http://127.0.0.1:11540/v1/models
  OAuth profile   : openai-codex:default (~/.openclaw/agents/main/agent/auth-profiles.json)
  Default model   : openai-codex/gpt-5.4-mini
```

If your `:default` profile is stale, the bridge will log a one-time
`Falling back to profile "openai-codex:<email>"` and keep working.

### As a user systemd service

The unit assumes the repo lives at `~/codex-ollama-bridge`. If you cloned it
elsewhere, edit the `ExecStart` path in
`systemd/codex-ollama-bridge.service` first.

```bash
cp systemd/codex-ollama-bridge.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-ollama-bridge
journalctl --user -u codex-ollama-bridge -f      # follow logs
```

Optional overrides go in `~/.config/codex-ollama-bridge/env`:

```bash
mkdir -p ~/.config/codex-ollama-bridge
cat > ~/.config/codex-ollama-bridge/env <<'EOF'
CODEX_BRIDGE_OAUTH_PROFILE=openai-codex:your-account@example.com
CODEX_BRIDGE_MODEL=openai-codex/gpt-5.4-mini
EOF
systemctl --user restart codex-ollama-bridge
```

---

## 2. Chat from the terminal (Ollama style)

```bash
OLLAMA_HOST=http://127.0.0.1:11540 ollama run codex:latest
```

Type and chat just like any local Ollama model. Aliases that all map to the
configured Codex model:

- `codex:latest`
- `codex:gpt-5.4-mini`
- `gpt-5.4-mini`
- `openai-codex/gpt-5.4-mini`

One-shot from the shell:

```bash
OLLAMA_HOST=http://127.0.0.1:11540 ollama run codex:latest "summarize this readme"
```

---

## 3. Use as an OpenAI endpoint

Any OpenAI-compatible client just needs a `baseURL` and a non-empty `apiKey`
(the bridge ignores the key — it uses your local OAuth).

```text
baseURL: http://127.0.0.1:11540/v1
model:   openai-codex/gpt-5.4-mini
apiKey:  any-non-empty-string
```

### `memory-lancedb-pro` plugin

`memory-lancedb-pro` already has a configurable OpenAI-compatible LLM hook —
no code patch needed, just point it at the bridge.

Edit `~/.openclaw/openclaw.json` and set the plugin's `config.llm` block:

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

Notes:

- `apiKey` can be any non-empty string (the bridge ignores it and uses local
  OAuth).
- Leave the `embedding` block alone — Codex doesn't expose embeddings; keep
  using Ollama (`nomic-embed-text`) or whichever embedder you already have.
- Common pitfall: the model id uses a forward slash, **not** a backslash:
  `openai-codex/gpt-5.4-mini`.

Smoke-test with curl from the same shell that runs OpenClaw:

```bash
curl -sS http://127.0.0.1:11540/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai-codex/gpt-5.4-mini",
       "messages":[{"role":"user","content":"say ok"}],
       "stream":false}'
```

Expected: a JSON `chat.completion` whose `choices[0].message.content` is
`ok`. If you see that, restart OpenClaw and `memory-lancedb-pro` will start
using Codex for memory extraction / recall scoring.

### OpenAI Python SDK

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:11540/v1", api_key="local-bridge")
r = client.chat.completions.create(
    model="openai-codex/gpt-5.4-mini",
    messages=[{"role": "user", "content": "say ok"}],
)
print(r.choices[0].message.content)
```

### curl (streaming)

```bash
curl -N http://127.0.0.1:11540/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai-codex/gpt-5.4-mini",
       "messages":[{"role":"user","content":"hello"}],
       "stream":true}'
```

---

## 4. HTTP endpoints

| Method | Path | Purpose |
|---|---|---|
| `HEAD` `GET` | `/` | Health / banner (Ollama CLI pings this) |
| `GET` | `/api/version`, `/version` | Bridge version |
| `GET` | `/v1/models`, `/models` | OpenAI model list |
| `GET` | `/api/tags`, `/api/ps` | Ollama model list |
| `POST` | `/api/show` | Ollama "show" metadata |
| `POST` | `/v1/chat/completions`, `/chat/completions` | OpenAI chat (streams) |
| `POST` | `/api/chat` | Ollama chat (streams NDJSON) |
| `POST` | `/api/generate` | Ollama generate (streams NDJSON) |

Streaming (`stream:true`) is fully supported — the bridge translates upstream
Codex Responses SSE to OpenAI Chat Completions SSE / Ollama NDJSON in real
time, so tokens land in the terminal as they're generated.

---

## 5. Configuration

All config is via env vars (no flags, no CLI args):

| Var | Default | Purpose |
|---|---|---|
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `CODEX_BRIDGE_PORT` | `11540` | Bind port |
| `CODEX_BRIDGE_MODEL` | `openai-codex/gpt-5.4-mini` | Default + advertised model |
| `CODEX_BRIDGE_OAUTH_PATH` | `~/.openclaw/agents/main/agent/auth-profiles.json` | OpenClaw profile file |
| `CODEX_BRIDGE_OAUTH_PROFILE` | `openai-codex:default` | Preferred profile key |

### Profile fallback

If `CODEX_BRIDGE_OAUTH_PROFILE` is missing, expired, or its refresh token is
already spent, the bridge automatically picks **the first other
`openai-codex:*` profile** in your `auth-profiles.json` that has a non-expired
access token. To stop relying on the fallback (and silence the log line),
point `CODEX_BRIDGE_OAUTH_PROFILE` at your live profile directly.

---

## 6. Troubleshooting

**`Error: something went wrong, please see the ollama server logs for details`**
The Ollama CLI's generic error — usually means an upstream request failed.
Reproduce with curl to see the real cause:

```bash
curl -sS http://127.0.0.1:11540/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"codex:latest","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

**`Refresh failed: 401 ... refresh_token_reused`**
That profile's refresh token has already been spent (usually because OpenClaw
itself refreshed it). The bridge will auto-fall-back to another live profile
if one exists. Otherwise re-authenticate in OpenClaw to get a fresh pair.

**`No usable openai-codex:* profile in ...`**
No profile in `auth-profiles.json` has a non-expired Codex access token. Log
into OpenClaw with the Codex provider.

**`address already in use`**
Another process owns port `11540`. Either kill it (`pkill -f
codex-bridge.mjs`) or set `CODEX_BRIDGE_PORT` to something free.

**`model_not_found` from upstream**
Your account doesn't have access to `gpt-5.4-mini`. Set
`CODEX_BRIDGE_MODEL=openai-codex/<model-id-you-can-use>`.

---

## 7. File layout

```
codex-ollama-bridge/
├── codex-bridge.mjs                ← the entire bridge (single file)
├── package.json                    ← npm start
├── README.md
├── skills/codex-ollama-bridge/     ← OpenClaw skill doc
└── systemd/                        ← optional user service unit
```

---

## License

MIT.
