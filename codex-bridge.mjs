#!/usr/bin/env node
/**
 * codex-bridge.mjs
 * OpenAI-compatible HTTP proxy for OpenAI Codex via OpenClaw OAuth.
 * Exposes:
 *   http://127.0.0.1:11540/v1/chat/completions   (OpenAI-compatible, streams)
 *   http://127.0.0.1:11540/api/chat              (Ollama-compatible, streams)
 *   http://127.0.0.1:11540/api/generate          (Ollama-compatible, streams)
 *   http://127.0.0.1:11540/v1/models, /api/tags  (model list)
 *
 * Reads OAuth from ~/.openclaw/agents/main/agent/auth-profiles.json
 * (profile: openai-codex:default) and refreshes via OpenAI's token endpoint.
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT  = Number(process.env.CODEX_BRIDGE_PORT || 11540);
const HOST  = process.env.CODEX_BRIDGE_HOST || "127.0.0.1";
const MODEL = process.env.CODEX_BRIDGE_MODEL || "openai-codex/gpt-5.4-mini";
const AUTH_PROFILES = process.env.CODEX_BRIDGE_OAUTH_PATH
  || path.join(os.homedir(), ".openclaw/agents/main/agent/auth-profiles.json");
const OAUTH_PROFILE = process.env.CODEX_BRIDGE_OAUTH_PROFILE || "openai-codex:default";

const CODEX_HOST = "chatgpt.com";
const CODEX_PATH = "/backend-api/codex/responses";
const TOKEN_URL  = "https://auth.openai.com/oauth/token";
const CLIENT_ID  = "app_EMoamEEZ73f0CkXaXp7hrann";

const ALIASES = Array.from(new Set([
  MODEL,
  "openai-codex/gpt-5.5",
  "codex:latest",
  "codex:gpt-5.4-mini",
  "codex:gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.5",
]));

// ── OAuth (read OpenClaw auth-profiles.json, refresh when stale) ──────────────

function readProfiles() {
  return JSON.parse(fs.readFileSync(AUTH_PROFILES, "utf8"));
}
function writeProfiles(root) {
  fs.writeFileSync(AUTH_PROFILES, JSON.stringify(root, null, 2) + "\n");
}
function decodeJwt(token) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return null; }
}
function jwtAccountId(token) {
  return decodeJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id || "";
}
function jwtExpiry(token) {
  const exp = Number(decodeJwt(token)?.exp);
  return Number.isFinite(exp) ? exp * 1000 : 0;
}

function profileSession(profile) {
  if (!profile) return null;
  const access  = profile.access  || profile.access_token;
  const refresh = profile.refresh || profile.refresh_token;
  const expires = Number(profile.expires || profile.expires_at || jwtExpiry(access)) || 0;
  const account = profile.accountId || profile.account_id || jwtAccountId(access);
  if (!access) return null;
  return { access, refresh, expires, account };
}

function pickUsableProfile(root) {
  const profiles = root?.profiles || {};
  const named = profiles[OAUTH_PROFILE];
  const namedSess = profileSession(named);
  if (namedSess && namedSess.access && namedSess.expires > Date.now() + 60_000 && namedSess.account) {
    return { key: OAUTH_PROFILE, profile: named, session: namedSess };
  }
  for (const [key, profile] of Object.entries(profiles)) {
    if (key === OAUTH_PROFILE) continue;
    if (!key.startsWith("openai-codex:")) continue;
    const sess = profileSession(profile);
    if (sess && sess.access && sess.expires > Date.now() + 60_000 && sess.account) {
      console.log(`[codex-bridge] Falling back to profile "${key}" (named "${OAUTH_PROFILE}" is stale)`);
      return { key, profile, session: sess };
    }
  }
  if (namedSess) return { key: OAUTH_PROFILE, profile: named, session: namedSess };
  return null;
}

let inflightRefresh = null;
async function getSession() {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const root = readProfiles();
    const picked = pickUsableProfile(root);
    if (!picked) throw new Error(`No usable openai-codex:* profile in ${AUTH_PROFILES}`);
    const { key, profile, session } = picked;

    if (session.expires > Date.now() + 60_000 && session.account) {
      return { accessToken: session.access, accountId: session.account };
    }
    if (!session.refresh) throw new Error(`Profile "${key}" expired and has no refresh_token`);

    console.log(`[codex-bridge] Refreshing OAuth token for "${key}"...`);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.refresh,
        client_id: CLIENT_ID,
      }),
    });
    if (!res.ok) throw new Error(`Refresh failed for "${key}": ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const newAccess  = data.access_token;
    const newRefresh = data.refresh_token || session.refresh;
    const newExpires = Date.now() + (Number(data.expires_in) || 28 * 24 * 3600) * 1000;
    const newAccount = jwtAccountId(newAccess) || session.account;

    root.profiles[key] = {
      ...profile,
      access: newAccess, refresh: newRefresh, expires: newExpires, accountId: newAccount,
    };
    writeProfiles(root);
    console.log(`[codex-bridge] Token refreshed for "${key}"`);
    return { accessToken: newAccess, accountId: newAccount };
  })().finally(() => { setTimeout(() => { inflightRefresh = null; }, 0); });
  return inflightRefresh;
}

// ── Codex Responses call ──────────────────────────────────────────────────────

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(p =>
      typeof p === "string" ? p :
      (p?.type === "text" || p?.type === "input_text") && typeof p.text === "string" ? p.text : ""
    ).filter(Boolean).join("\n");
  }
  return "";
}

function buildPayload(messages, requestedModel) {
  const instructions = messages
    .filter(m => m.role === "system")
    .map(m => normalizeContent(m.content))
    .filter(Boolean)
    .join("\n\n") || "You are a helpful coding assistant.";
  const input = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: normalizeContent(m.content),
      }],
    }));
  const codexModel = String(requestedModel || MODEL)
    .replace(/^openai-codex\//, "")
    .replace(/^openai\//, "");
  return { model: codexModel, instructions, stream: true, store: false, input };
}

function callCodex(session, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: CODEX_HOST, path: CODEX_PATH, method: "POST",
      headers: {
        "Authorization": `Bearer ${session.accessToken}`,
        "ChatGPT-Account-Id": session.accountId,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Accept": "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/codex",
        "User-Agent": "codex-ollama-bridge",
      },
    }, resolve);
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── SSE translator: Codex Responses → OpenAI / Ollama ─────────────────────────

function makeSseParser(onEvent) {
  let buf = "";
  return {
    feed(chunk) {
      buf += chunk.toString("utf8");
      let sep;
      while ((sep = buf.indexOf("\n\n")) !== -1 || (sep = buf.indexOf("\r\n\r\n")) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + (buf[sep] === "\r" ? 4 : 2));
        const data = frame.split(/\r?\n/)
          .filter(l => l.startsWith("data:"))
          .map(l => l.slice(5).trim()).join("");
        if (!data || data === "[DONE]") continue;
        try { onEvent(JSON.parse(data)); } catch { /* skip */ }
      }
    },
  };
}

function streamAsOpenAI(upstream, res, model) {
  const id = `chatcmpl-codex-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const chunk = (delta, finish = null) => res.write("data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + "\n\n");
  chunk({ role: "assistant" });
  const parser = makeSseParser(ev => {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") chunk({ content: ev.delta });
  });
  upstream.on("data", c => parser.feed(c));
  upstream.on("end", () => { chunk({}, "stop"); res.write("data: [DONE]\n\n"); res.end(); });
  upstream.on("error", () => res.end());
}

function streamAsOllama(upstream, res, model, mode) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const writeDelta = (text) => {
    const ts = new Date().toISOString();
    if (mode === "chat") {
      res.write(JSON.stringify({ model, created_at: ts, message: { role: "assistant", content: text }, done: false }) + "\n");
    } else {
      res.write(JSON.stringify({ model, created_at: ts, response: text, done: false }) + "\n");
    }
  };
  const parser = makeSseParser(ev => {
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") writeDelta(ev.delta);
  });
  upstream.on("data", c => parser.feed(c));
  upstream.on("end", () => {
    const ts = new Date().toISOString();
    const tail = { model, created_at: ts, done: true,
      total_duration: 0, load_duration: 0,
      prompt_eval_count: 0, prompt_eval_duration: 0,
      eval_count: 0, eval_duration: 0 };
    if (mode === "chat") res.write(JSON.stringify({ ...tail, message: { role: "assistant", content: "" } }) + "\n");
    else res.write(JSON.stringify({ ...tail, response: "" }) + "\n");
    res.end();
  });
  upstream.on("error", () => res.end());
}

function aggregateText(upstream) {
  return new Promise((resolve, reject) => {
    let text = "";
    const parser = makeSseParser(ev => {
      if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") text += ev.delta;
      else if (ev.type === "response.output_text.done" && typeof ev.text === "string") text = ev.text;
    });
    upstream.on("data", c => parser.feed(c));
    upstream.on("end", () => resolve(text));
    upstream.on("error", reject);
  });
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", c => data += c);
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function resolveModel(name) {
  if (!name || name === "codex:latest" || name === "codex:gpt-5.4-mini" || name === "gpt-5.4-mini") return MODEL;
  if (name === "codex:gpt-5.5" || name === "gpt-5.5") return "openai-codex/gpt-5.5";
  return name;
}
function ollamaTag(name) {
  return {
    name, model: name,
    modified_at: new Date().toISOString(),
    size: 0,
    digest: `sha256:${Buffer.from(name).toString("hex").padEnd(64, "0").slice(0, 64)}`,
    details: { parent_model: "", format: "openai-compatible", family: "codex",
               families: ["codex"], parameter_size: "remote", quantization_level: "none" },
  };
}
function ollamaPull(res, name) {
  const tag = ollamaTag(name || MODEL);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Access-Control-Allow-Origin": "*",
  });
  res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
  res.write(JSON.stringify({ status: "success", digest: tag.digest, model: tag.name }) + "\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    return res.end();
  }

  const url = (req.url || "/").split("?")[0];

  if (req.method === "HEAD" && url === "/") {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    return res.end();
  }
  if (req.method === "GET" && url === "/") {
    return send(res, 200, {
      name: "codex-ollama-bridge", model: MODEL,
      openaiBaseURL: `http://${HOST}:${PORT}/v1`,
      ollamaBaseURL: `http://${HOST}:${PORT}`,
    });
  }
  if (req.method === "GET" && (url === "/api/version" || url === "/version")) {
    return send(res, 200, { version: "0.2.0", bridge: "codex-ollama-bridge" });
  }
  if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
    return send(res, 200, {
      object: "list",
      data: ALIASES.map(id => ({ id, object: "model", created: 1700000000, owned_by: "openai-codex" })),
    });
  }
  if (req.method === "GET" && (url === "/api/tags" || url === "/api/ps")) {
    return send(res, 200, { models: ALIASES.map(ollamaTag) });
  }
  if (req.method === "POST" && url === "/api/show") {
    const body = await readBody(req).catch(() => ({}));
    const name = body.name || MODEL;
    return send(res, 200, {
      ...ollamaTag(name),
      modelfile: `FROM ${name}`, parameters: "", template: "{{ .Prompt }}", model_info: {},
    });
  }
  if (req.method === "POST" && url === "/api/pull") {
    const body = await readBody(req).catch(() => ({}));
    const name = body.name || body.model || MODEL;
    return ollamaPull(res, name);
  }

  const isOpenAI = req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions");
  const isChat   = req.method === "POST" && url === "/api/chat";
  const isGen    = req.method === "POST" && url === "/api/generate";

  if (isOpenAI || isChat || isGen) {
    let body;
    try { body = await readBody(req); }
    catch { return send(res, 400, { error: { message: "Invalid JSON", type: "invalid_request_error" } }); }

    const requestedModel = body.model || MODEL;
    const model = resolveModel(requestedModel);
    const messages = isGen
      ? [...(body.system ? [{ role: "system", content: body.system }] : []),
         { role: "user", content: body.prompt || "" }]
      : (Array.isArray(body.messages) ? body.messages : []);

    let session, upstream;
    try { session = await getSession(); }
    catch (e) { return send(res, 502, { error: { message: e.message, type: "bridge_oauth_error" } }); }
    try { upstream = await callCodex(session, buildPayload(messages, model)); }
    catch (e) { return send(res, 502, { error: { message: e.message, type: "bridge_upstream_error" } }); }

    if (upstream.statusCode >= 400) {
      let raw = "";
      upstream.on("data", c => raw += c);
      upstream.on("end", () => {
        res.writeHead(upstream.statusCode, {
          "Content-Type": upstream.headers["content-type"] || "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(raw);
      });
      return;
    }

    if (isOpenAI) {
      if (body.stream === true) return streamAsOpenAI(upstream, res, requestedModel);
      const text = await aggregateText(upstream);
      return send(res, 200, {
        id: `chatcmpl-codex-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    const stream = body.stream !== false;
    const mode = isChat ? "chat" : "generate";
    if (stream) return streamAsOllama(upstream, res, requestedModel, mode);
    const text = await aggregateText(upstream);
    const ts = new Date().toISOString();
    if (mode === "chat") return send(res, 200, { model: requestedModel, created_at: ts, message: { role: "assistant", content: text }, done: true });
    return send(res, 200, { model: requestedModel, created_at: ts, response: text, done: true });
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`[codex-bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`  OpenAI endpoint : http://${HOST}:${PORT}/v1/chat/completions`);
  console.log(`  Ollama compat   : http://${HOST}:${PORT}/api/chat`);
  console.log(`  Model list      : http://${HOST}:${PORT}/v1/models`);
  console.log(`  OAuth profile   : ${OAUTH_PROFILE} (${AUTH_PROFILES})`);
  console.log(`  Default model   : ${MODEL}`);
});
server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error(`[codex-bridge] Port ${PORT} in use. Set CODEX_BRIDGE_PORT.`);
  } else {
    console.error("[codex-bridge]", e.message);
  }
  process.exit(1);
});
