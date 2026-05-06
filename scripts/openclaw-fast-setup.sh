#!/usr/bin/env bash
set -euo pipefail

ACTION="all"
BRIDGE_HOST="${CODEX_BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${CODEX_BRIDGE_PORT:-11540}"
BRIDGE_MODEL="${CODEX_BRIDGE_MODEL:-openai-codex/gpt-5.4-mini}"
OPENCLAW_CONFIG="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
EMBED_BASE_URL="${MEMORY_EMBED_BASE_URL:-http://localhost:11434/v1}"
EMBED_MODEL="${MEMORY_EMBED_MODEL:-nomic-embed-text}"
EMBED_DIMENSIONS="${MEMORY_EMBED_DIMENSIONS:-768}"
EMBED_API_KEY="${MEMORY_EMBED_API_KEY:-ollama}"
EMBED_TASK_QUERY="${MEMORY_EMBED_TASK_QUERY:-}"
EMBED_TASK_PASSAGE="${MEMORY_EMBED_TASK_PASSAGE:-}"
EMBED_NORMALIZED="${MEMORY_EMBED_NORMALIZED:-}"
RERANK_API_KEY="${MEMORY_RERANK_API_KEY:-}"
RERANK_PROVIDER="${MEMORY_RERANK_PROVIDER:-jina}"
RERANK_MODEL="${MEMORY_RERANK_MODEL:-jina-reranker-v3}"
RERANK_ENDPOINT="${MEMORY_RERANK_ENDPOINT:-https://api.jina.ai/v1/rerank}"
RESTART_OPENCLAW=0
RUN_CHAT_CHECK=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/codex-ollama-bridge.service"
BRIDGE_URL="http://${BRIDGE_HOST}:${BRIDGE_PORT}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/openclaw-fast-setup.sh [all|install|configure-memory|check] [--restart-openclaw] [--chat-check]

Actions:
  all              Install bridge service, configure memory-lancedb-pro, then check health.
  install          Install and start the codex-ollama-bridge user service.
  configure-memory Merge memory-lancedb-pro defaults into ~/.openclaw/openclaw.json.
  check            Check node, systemd service, bridge, Ollama embeddings, and OpenClaw config.

Environment:
  CODEX_BRIDGE_HOST             Default: 127.0.0.1
  CODEX_BRIDGE_PORT             Default: 11540
  CODEX_BRIDGE_MODEL            Default: openai-codex/gpt-5.4-mini
  OPENCLAW_CONFIG               Default: ~/.openclaw/openclaw.json
  MEMORY_EMBED_BASE_URL         Default: http://localhost:11434/v1
  MEMORY_EMBED_MODEL            Default: nomic-embed-text
  MEMORY_EMBED_DIMENSIONS       Default: 768
  MEMORY_EMBED_API_KEY          Default: ollama  (set to Jina key for Plan A)
  MEMORY_EMBED_TASK_QUERY       Default: (unset) (set to retrieval.query for Jina v5)
  MEMORY_EMBED_TASK_PASSAGE     Default: (unset) (set to retrieval.passage for Jina v5)
  MEMORY_EMBED_NORMALIZED       Default: (unset) (set to true for Jina v5)
  MEMORY_RERANK_API_KEY         Default: (unset) (set to enable cross-encoder reranking)
  MEMORY_RERANK_PROVIDER        Default: jina
  MEMORY_RERANK_MODEL           Default: jina-reranker-v3
  MEMORY_RERANK_ENDPOINT        Default: https://api.jina.ai/v1/rerank

Plan A (Jina embedding + reranker + codex bridge LLM):
  MEMORY_EMBED_BASE_URL=https://api.jina.ai/v1 \
  MEMORY_EMBED_MODEL=jina-embeddings-v5-text-small \
  MEMORY_EMBED_DIMENSIONS=1024 \
  MEMORY_EMBED_API_KEY=<JINA_API_KEY> \
  MEMORY_EMBED_TASK_QUERY=retrieval.query \
  MEMORY_EMBED_TASK_PASSAGE=retrieval.passage \
  MEMORY_EMBED_NORMALIZED=true \
  MEMORY_RERANK_API_KEY=<JINA_API_KEY> \
  scripts/openclaw-fast-setup.sh configure-memory --restart-openclaw

Examples:
  scripts/openclaw-fast-setup.sh all --restart-openclaw
  scripts/openclaw-fast-setup.sh check --chat-check
USAGE
}

if (($#)); then
  case "$1" in
    all|install|configure-memory|check)
      ACTION="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --restart-openclaw|--chat-check) ;;
    *)
      echo "Unknown action: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

while (($#)); do
  case "$1" in
    --restart-openclaw) RESTART_OPENCLAW=1 ;;
    --chat-check) RUN_CHAT_CHECK=1 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

log() { printf '==> %s\n' "$*"; }
ok() { printf 'OK  %s\n' "$*"; }
warn() { printf 'WARN %s\n' "$*" >&2; }
die() { printf 'ERR %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

json_get() {
  node -e "const fs=require('fs'); const s=fs.readFileSync(0,'utf8'); const o=JSON.parse(s); $1"
}

install_service() {
  need_cmd node
  need_cmd systemctl

  local node_bin
  node_bin="$(command -v node)"

  log "Installing codex-ollama-bridge user service"
  mkdir -p "$SERVICE_DIR" "$HOME/.config/codex-ollama-bridge"

  cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Codex Ollama Bridge - OpenAI-compatible Codex proxy via OpenClaw OAuth
After=network.target

[Service]
Type=simple
Environment=CODEX_BRIDGE_HOST=${BRIDGE_HOST}
Environment=CODEX_BRIDGE_PORT=${BRIDGE_PORT}
Environment=CODEX_BRIDGE_MODEL=${BRIDGE_MODEL}
Environment=CODEX_BRIDGE_OAUTH_PROFILE=openai-codex:default
EnvironmentFile=-%h/.config/codex-ollama-bridge/env
ExecStart=${node_bin} ${REPO_ROOT}/codex-bridge.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

  systemctl --user daemon-reload
  systemctl --user enable --now codex-ollama-bridge.service
  ok "Service installed at $SERVICE_FILE"
}

configure_memory() {
  need_cmd node
  [[ -f "$OPENCLAW_CONFIG" ]] || die "OpenClaw config not found: $OPENCLAW_CONFIG"

  local backup="${OPENCLAW_CONFIG}.bak.$(date +%Y%m%d-%H%M%S)"
  cp "$OPENCLAW_CONFIG" "$backup"
  log "Backed up OpenClaw config to $backup"

  OPENCLAW_CONFIG="$OPENCLAW_CONFIG" \
  BRIDGE_BASE_URL="${BRIDGE_URL}/v1" \
  BRIDGE_MODEL="$BRIDGE_MODEL" \
  EMBED_BASE_URL="$EMBED_BASE_URL" \
  EMBED_MODEL="$EMBED_MODEL" \
  EMBED_DIMENSIONS="$EMBED_DIMENSIONS" \
  EMBED_API_KEY="$EMBED_API_KEY" \
  EMBED_TASK_QUERY="$EMBED_TASK_QUERY" \
  EMBED_TASK_PASSAGE="$EMBED_TASK_PASSAGE" \
  EMBED_NORMALIZED="$EMBED_NORMALIZED" \
  RERANK_API_KEY="$RERANK_API_KEY" \
  RERANK_PROVIDER="$RERANK_PROVIDER" \
  RERANK_MODEL="$RERANK_MODEL" \
  RERANK_ENDPOINT="$RERANK_ENDPOINT" \
  node <<'NODE'
const fs = require("fs");

const configPath = process.env.OPENCLAW_CONFIG;
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));

function objectAt(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

cfg.plugins = objectAt(cfg, "plugins");
cfg.plugins.allow = Array.isArray(cfg.plugins.allow) ? cfg.plugins.allow : [];
if (!cfg.plugins.allow.includes("memory-lancedb-pro")) {
  cfg.plugins.allow.push("memory-lancedb-pro");
}

cfg.plugins.slots = objectAt(cfg.plugins, "slots");
cfg.plugins.slots.memory = "memory-lancedb-pro";

cfg.plugins.entries = objectAt(cfg.plugins, "entries");
const entry = objectAt(cfg.plugins.entries, "memory-lancedb-pro");
entry.enabled = true;
entry.hooks = objectAt(entry, "hooks");
entry.hooks.allowConversationAccess = true;
entry.config = objectAt(entry, "config");

entry.config.llm = {
  ...(entry.config.llm && typeof entry.config.llm === "object" ? entry.config.llm : {}),
  apiKey: "codex-bridge",
  model: process.env.BRIDGE_MODEL,
  baseURL: process.env.BRIDGE_BASE_URL
};

const embedBase = {
  baseURL: process.env.EMBED_BASE_URL,
  model: process.env.EMBED_MODEL,
  apiKey: process.env.EMBED_API_KEY || "ollama",
  dimensions: Number(process.env.EMBED_DIMENSIONS || 768),
};
if (process.env.EMBED_TASK_QUERY)   embedBase.taskQuery   = process.env.EMBED_TASK_QUERY;
if (process.env.EMBED_TASK_PASSAGE) embedBase.taskPassage = process.env.EMBED_TASK_PASSAGE;
if (process.env.EMBED_NORMALIZED)   embedBase.normalized  = process.env.EMBED_NORMALIZED === "true";
entry.config.embedding = {
  ...embedBase,
  ...(entry.config.embedding && typeof entry.config.embedding === "object" ? entry.config.embedding : {})
};

if (process.env.RERANK_API_KEY) {
  entry.config.retrieval = {
    mode: "hybrid",
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    rerank: "cross-encoder",
    rerankProvider: process.env.RERANK_PROVIDER || "jina",
    rerankModel: process.env.RERANK_MODEL || "jina-reranker-v3",
    rerankEndpoint: process.env.RERANK_ENDPOINT || "https://api.jina.ai/v1/rerank",
    rerankApiKey: process.env.RERANK_API_KEY,
    candidatePoolSize: 12,
    minScore: 0.6,
    hardMinScore: 0.62,
    filterNoise: true,
    ...(entry.config.retrieval && typeof entry.config.retrieval === "object" ? entry.config.retrieval : {})
  };
}

if (entry.config.autoCapture === undefined) entry.config.autoCapture = true;
if (entry.config.autoRecall === undefined) entry.config.autoRecall = true;
if (entry.config.smartExtraction === undefined) entry.config.smartExtraction = true;
if (entry.config.captureAssistant === undefined) entry.config.captureAssistant = false;
if (entry.config.maxRecallResults === undefined) entry.config.maxRecallResults = 8;
if (entry.config.minRelevanceScore === undefined) entry.config.minRelevanceScore = 0.35;

fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
NODE

  ok "memory-lancedb-pro points LLM calls at ${BRIDGE_URL}/v1"
}

check_bridge() {
  need_cmd curl

  log "Checking codex-ollama-bridge at $BRIDGE_URL"
  local models
  models="$(curl -fsS "${BRIDGE_URL}/v1/models")" || die "Bridge did not answer /v1/models"
  printf '%s' "$models" | json_get "if(!o.data || !o.data.length) process.exit(1); console.log('OK  bridge models: ' + o.data.map(m=>m.id).join(', '));" || die "Bridge returned unexpected /v1/models JSON"

  local ollama_models
  ollama_models="$(curl -fsS "${BRIDGE_URL}/api/tags")" || die "Bridge did not answer /api/tags"
  printf '%s' "$ollama_models" | json_get "const names=(o.models||[]).map(m=>m.name); if(!names.includes('codex:latest')) process.exit(1); if(names.some(n=>n.startsWith('gemma4') || n.includes('gemma-4'))) process.exit(2); console.log('OK  Codex Ollama aliases: ' + names.join(', '));" || die "Bridge /api/tags did not advertise the expected Codex-only aliases"

  if ((RUN_CHAT_CHECK)); then
    log "Running optional bridge chat check"
    curl -fsS "${BRIDGE_URL}/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"${BRIDGE_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"say ok\"}],\"stream\":false}" \
      | json_get "const c=o.choices?.[0]?.message?.content || ''; if(!c) process.exit(1); console.log('OK  bridge chat: ' + c.trim().slice(0, 80));"
  fi
}

check_ollama_embeddings() {
  need_cmd curl

  log "Checking Ollama embedding endpoint at $EMBED_BASE_URL"
  local payload response
  payload="{\"model\":\"${EMBED_MODEL}\",\"input\":\"openclaw memory check\"}"
  if ! response="$(curl -fsS "${EMBED_BASE_URL}/embeddings" -H "Content-Type: application/json" -d "$payload" 2>/dev/null)"; then
    warn "Ollama embeddings unavailable. Start Ollama and pull ${EMBED_MODEL}: ollama pull ${EMBED_MODEL}"
    return 0
  fi
  printf '%s' "$response" | json_get "const emb=o.data?.[0]?.embedding || o.embedding; if(!Array.isArray(emb)) process.exit(1); console.log('OK  embedding dimensions: ' + emb.length);" || warn "Embedding response did not match OpenAI-compatible JSON"
}

check_openclaw_config() {
  log "Checking OpenClaw config"
  [[ -f "$OPENCLAW_CONFIG" ]] || {
    warn "OpenClaw config not found: $OPENCLAW_CONFIG"
    return 0
  }

  BRIDGE_BASE_URL="${BRIDGE_URL}/v1" node - "$OPENCLAW_CONFIG" <<'NODE'
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const entry = cfg.plugins?.entries?.["memory-lancedb-pro"];
const errors = [];
if (!cfg.plugins?.allow?.includes("memory-lancedb-pro")) errors.push("plugins.allow lacks memory-lancedb-pro");
if (cfg.plugins?.slots?.memory !== "memory-lancedb-pro") errors.push("plugins.slots.memory is not memory-lancedb-pro");
if (!entry?.enabled) errors.push("memory-lancedb-pro is not enabled");
if (!entry?.hooks?.allowConversationAccess) errors.push("conversation access hook is not enabled");
if (entry?.config?.llm?.baseURL !== process.env.BRIDGE_BASE_URL) errors.push("llm.baseURL does not point at the bridge");
if (!entry?.config?.embedding?.model) errors.push("embedding model is missing");
if (errors.length) {
  for (const error of errors) console.error("WARN " + error);
  process.exit(2);
}
console.log("OK  OpenClaw memory config is wired for codex-ollama-bridge");
NODE

  if command -v openclaw >/dev/null 2>&1; then
    openclaw config validate >/dev/null 2>&1 && ok "openclaw config validate passed" || warn "openclaw config validate failed"
  else
    warn "openclaw command not found; skipped OpenClaw validation"
  fi
}

check_service() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found; skipped service status"
    return 0
  fi
  if systemctl --user is-active --quiet codex-ollama-bridge.service; then
    ok "codex-ollama-bridge.service is active"
  else
    warn "codex-ollama-bridge.service is not active"
  fi
}

restart_openclaw() {
  ((RESTART_OPENCLAW)) || return 0

  log "Restarting OpenClaw gateway"
  if command -v openclaw >/dev/null 2>&1; then
    if openclaw gateway restart; then
      ok "OpenClaw gateway restart requested"
      return 0
    fi
    warn "openclaw gateway restart failed; trying systemd user service"
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files openclaw-gateway.service >/dev/null 2>&1; then
    systemctl --user restart openclaw-gateway.service && ok "openclaw-gateway.service restarted" || warn "openclaw-gateway.service restart failed"
  else
    warn "No OpenClaw gateway restart method found"
  fi
}

run_checks() {
  check_service
  check_bridge
  check_ollama_embeddings
  check_openclaw_config
}

case "$ACTION" in
  all)
    install_service
    configure_memory
    restart_openclaw
    run_checks
    ;;
  install)
    install_service
    ;;
  configure-memory)
    configure_memory
    restart_openclaw
    ;;
  check)
    run_checks
    ;;
esac
