#!/usr/bin/env node
// zcode-acp — Agent Client Protocol (ACP) adapter that exposes the ZCode CLI
// (zcode) as an ACP agent over stdio, so ACP clients (Zed, T3 Code, ...) can
// drive ZCode sessions.
//
// Wire format: newline-delimited JSON-RPC 2.0 on stdin/stdout. Diagnostics go
// to stderr only. Zero runtime dependencies.
//
// Backend: one `zcode -p <text> --json [--resume sess_...]` process per turn,
// with `--cwd`, `--mode` and `--attach` mapping from the ACP session state.
// ZCode persists sessions on disk (sess_* ids), which gives us resume for free.
//
// Models: the catalog is read from zcode's personal provider config (the
// first of ZCODE_ACP_PROVIDER_CONFIG, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
// ~/.zcode/headless/provider_config.json, ~/.zcode/v2/provider_config.json
// that parses). session/new advertises it as availableModels; session/set_model
// pins a per-session model, applied per turn by materializing a rotated copy
// of the provider config (requested provider first, requested model first in
// its modelOrder) and pointing ZCODE_PERSONAL_PROVIDER_CONFIG_FILE at it.
// The bare id "zcode-default" keeps the config's own default.
//
// Env:
//   ZCODE_ACP_ZCODE_BIN        zcode executable (default: "zcode" on PATH)
//   ZCODE_ACP_TURN_TIMEOUT_MS  hard per-turn kill timer (default: 0 = none)
//   ZCODE_ACP_MODES            comma list to restrict advertised modes
//   ZCODE_ACP_SKIP_AUTH_CHECK  "1" to treat authenticate as always successful
//   ZCODE_ACP_PROVIDER_CONFIG  provider config path override for the catalog

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ZCODE_BIN = process.env.ZCODE_ACP_ZCODE_BIN || "zcode";
const TURN_TIMEOUT_MS = Number(process.env.ZCODE_ACP_TURN_TIMEOUT_MS || 0);
const DEFAULT_MODEL_ID = "zcode-default";

// In headless `-p` runs zcode auto-DENIES tool use in every mode except yolo
// ("No permission client connected"), so only yolo is advertised by default.
// ZCODE_ACP_MODES can re-expose the others for experiments; turns will
// complete but tools will be denied.
const MODES = [{ id: "yolo", name: "Yolo — tools run without approvals", kind: "all" }];
const requestedModes = (process.env.ZCODE_ACP_MODES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const availableModes = requestedModes.length
  ? MODES.filter((m) => requestedModes.includes(m.id))
  : MODES;

const log = (...args) => process.stderr.write(`[zcode-acp] ${args.join(" ")}\n`);

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const ERR_METHOD_NOT_FOUND = -32601;
const ERR_TURN_FAILED = -32000;

// ---------------------------------------------------------------- sessions

/** @type {Map<string, {cwd:string, mode:string, model:string|null, zcodeSession:string|null, child:import('child_process').ChildProcess|null, cancelled:boolean}>} */
const sessions = new Map();

// Provider-config model catalog, re-read per turn basis but cached for the
// advertisement; session/set_model re-validates against a fresh read.
const catalog = loadCatalog();

// ---------------------------------------------------------------- models

// Composite model id: `<providerId>::<modelId>`. Provider ids may contain
// slashes (9router rows like cc/claude-opus-5), so "::" is the separator.
function compositeModelId(providerId, modelId) {
  return `${providerId}::${modelId}`;
}

function splitCompositeModelId(id) {
  const idx = typeof id === "string" ? id.indexOf("::") : -1;
  if (idx <= 0) return null;
  return { providerId: id.slice(0, idx), modelId: id.slice(idx + 2) };
}

function providerConfigCandidates() {
  // Desktop config first: it carries every provider the ZCode app offers
  // (with their access blocks), so the model list matches what the user sees
  // there. The explicit override wins; the wrapper's headless config is the
  // last resort.
  return [
    process.env.ZCODE_ACP_PROVIDER_CONFIG,
    join(process.env.HOME || "", ".zcode", "v2", "provider_config.json"),
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
    join(process.env.HOME || "", ".zcode", "headless", "provider_config.json"),
  ].filter(Boolean);
}

function readProviderConfig() {
  for (const path of providerConfigCandidates()) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const config = parsed?.config ?? parsed;
      if (config && typeof config === "object") {
        return { path, schemaVersion: parsed?.schemaVersion ?? 1, config };
      }
    } catch {
      // missing or unparseable — try the next candidate
    }
  }
  return null;
}

function providerModelEntries(config) {
  const rules = Array.isArray(config?.providerConfigRules?.providerRules)
    ? config.providerConfigRules.providerRules
    : [];
  const byId = new Map();
  for (const rule of rules) {
    if (typeof rule?.providerId !== "string" || !rule.providerId) continue;
    // The model lists hang off the rule's own config block (same shape in the
    // headless and desktop provider configs).
    const inner = rule.config && typeof rule.config === "object" ? rule.config : {};
    const models = Array.isArray(inner.modelOrder) && inner.modelOrder.length
      ? inner.modelOrder
      : (Array.isArray(inner.personalModelIds) ? inner.personalModelIds : []);
    const clean = models.filter((m) => typeof m === "string" && m);
    if (clean.length) byId.set(rule.providerId, clean);
  }
  const order = [
    ...(Array.isArray(config?.providerOrder) ? config.providerOrder : []),
    ...[...byId.keys()],
  ].filter((id, i, all) => typeof id === "string" && byId.has(id) && all.indexOf(id) === i);
  const entries = [];
  for (const providerId of order) {
    for (const modelId of byId.get(providerId)) entries.push({ providerId, modelId });
  }
  return entries;
}

function loadCatalog() {
  const source = readProviderConfig();
  const entries = source ? providerModelEntries(source.config) : [];
  return {
    entries,
    availableModels: entries.map(({ providerId, modelId }) => ({
      modelId: compositeModelId(providerId, modelId),
      name: `${modelId} · ${providerId}`,
    })),
  };
}

/** Materialize a rotated provider config so `zcode -p` runs the requested
 *  model: its provider first in providerOrder, the model first in that
 *  provider's modelOrder/personalModelIds. Zcode picks the session default
 *  from exactly that order. Returns the temp file path; caller removes it. */
function materializeModelConfig(source, wanted) {
  const parts = splitCompositeModelId(wanted);
  if (!parts) return null;
  const { providerId, modelId } = parts;
  const sourceConfig = source.config;
  const rules = Array.isArray(sourceConfig?.providerConfigRules?.providerRules)
    ? sourceConfig.providerConfigRules.providerRules
    : [];
  const rule = rules.find((r) => r?.providerId === providerId);
  if (!rule) return null;
  // The model lists hang off the rule's own config block.
  const inner = rule.config && typeof rule.config === "object" ? rule.config : {};
  const own = Array.isArray(inner.modelOrder) && inner.modelOrder.includes(modelId)
    ? inner.modelOrder
    : (Array.isArray(inner.personalModelIds) ? inner.personalModelIds : null);
  if (!own || !own.includes(modelId)) return null;
  const next = structuredClone(sourceConfig);
  const nextInner = next.providerConfigRules.providerRules.find((r) => r?.providerId === providerId).config;
  if (Array.isArray(nextInner.modelOrder)) nextInner.modelOrder = [modelId, ...nextInner.modelOrder.filter((m) => m !== modelId)];
  if (Array.isArray(nextInner.personalModelIds)) nextInner.personalModelIds = [modelId, ...nextInner.personalModelIds.filter((m) => m !== modelId)];
  const order = Array.isArray(next.providerOrder) ? next.providerOrder.filter((id) => id !== providerId) : [];
  next.providerOrder = [providerId, ...order];
  // Written back as the full wrapper — schemaVersion included, or zcode
  // rejects the file and the turn dies in model creation.
  const dir = mkdtempSync(join(tmpdir(), "zcode-acp-model-"));
  const file = join(dir, "provider_config.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: source.schemaVersion, config: next }, null, 2));
  return file;
}

// ---------------------------------------------------------------- zcode run

function materializeAttachments(promptBlocks, workDir) {
  const textParts = [];
  const attachPaths = [];
  for (const block of promptBlocks || []) {
    if (block?.type === "text" && block.text) {
      textParts.push(block.text);
    } else if (block?.type === "image" && block.data) {
      const ext = (block.mimeType || "png").split("/")[1].split("+")[0];
      const file = join(mkdtempSync(join(tmpdir(), "zcode-acp-")), `attach.${ext}`);
      writeFileSync(file, Buffer.from(block.data, "base64"));
      attachPaths.push(file);
    } else if (block?.type === "resource_link" && block.uri) {
      textParts.push(`[linked resource: ${block.uri}]`);
    } else if (block?.type === "resource" && block.resource?.text) {
      textParts.push(`[resource ${block.resource?.uri || ""}]\n${block.resource.text}`);
    }
  }
  return { text: textParts.join("\n").trim(), attachPaths };
}

function runTurn(sess, promptBlocks) {
  return new Promise((resolve) => {
    const { text, attachPaths } = materializeAttachments(promptBlocks, sess.cwd);
    if (!text && attachPaths.length === 0) {
      resolve({ ok: false, error: "empty prompt" });
      return;
    }

    // No ZCODE_BIN in argv: spawn(command, args) already sets argv0, and a
    // duplicated binary name reaches zcode as a stray positional that breaks
    // its provider-config validation ("路径必须同时提供").
    const argv = ["-p", text, "--json", "--cwd", sess.cwd, "--mode", sess.mode];
    for (const file of attachPaths) argv.push("--attach", file);
    if (sess.zcodeSession) argv.push("--resume", sess.zcodeSession);

    // A pinned composite model rides a rotated provider config copy for this
    // turn only; "zcode-default" keeps the config's own default.
    let modelConfigFile = null;
    const childEnv = { ...process.env };
    if (sess.model && sess.model !== DEFAULT_MODEL_ID) {
      const source = readProviderConfig();
      if (source) {
        modelConfigFile = materializeModelConfig(source, sess.model);
        if (modelConfigFile) {
          childEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = modelConfigFile;
        } else {
          log(`model ${sess.model} not found in provider config — running the config default`);
        }
      }
    }

    log(`turn start: mode=${sess.mode} model=${sess.model || DEFAULT_MODEL_ID} resume=${sess.zcodeSession || "new"} attach=${attachPaths.length}`);
    const child = spawn(ZCODE_BIN, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    sess.child = child;
    sess.cancelled = false;

    let stdout = "";
    let stderrTail = "";
    let timeout = null;
    if (TURN_TIMEOUT_MS > 0) {
      timeout = setTimeout(() => {
        log(`turn timed out after ${TURN_TIMEOUT_MS}ms — killing`);
        try { child.kill("SIGKILL"); } catch {}
      }, TURN_TIMEOUT_MS);
    }
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d).slice(-4000);
      process.stderr.write(d); // pass through for T3 logs
    });

    const done = (result) => {
      if (timeout) clearTimeout(timeout);
      sess.child = null;
      if (modelConfigFile) {
        try { rmSync(join(modelConfigFile, ".."), { recursive: true, force: true }); } catch {}
      }
      for (const file of attachPaths) {
        try { rmSync(join(file, ".."), { recursive: true, force: true }); } catch {}
      }
      resolve(result);
    };

    child.on("error", (err) => done({ ok: false, error: `failed to spawn ${ZCODE_BIN}: ${err.message}` }));
    child.on("close", (code) => {
      if (sess.cancelled) {
        done({ ok: false, cancelled: true });
        return;
      }
      // zcode -p --json prints one JSON object; be lenient about stray output.
      let parsed = null;
      const trimmed = stdout.trim();
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start >= 0 && end > start) {
          try { parsed = JSON.parse(trimmed.slice(start, end + 1)); } catch {}
        }
      }
      if (!parsed || typeof parsed !== "object") {
        done({
          ok: false,
          error: `zcode exited with code ${code} and no JSON result${stderrTail ? `: ${stderrTail.trim().split("\n").pop()}` : ""}`,
        });
        return;
      }
      if (parsed.sessionId) sess.zcodeSession = parsed.sessionId;
      const response =
        typeof parsed.response === "string" && parsed.response.length > 0
          ? parsed.response
          : "(zcode returned an empty response)";
      done({ ok: true, response, sessionId: parsed.sessionId ?? null });
    });
  });
}

function emitMessageChunk(sessionId, text) {
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

// ---------------------------------------------------------------- auth

function probeAuthed() {
  if (process.env.ZCODE_ACP_SKIP_AUTH_CHECK === "1") return true;
  // The GLM headless wrapper's provider config is a reliable "already signed
  // in" marker on machines set up like this one; stock installs keep creds
  // under ~/.zcode/cli.
  const candidates = [
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
    join(process.env.HOME || "", ".zcode", "headless", "provider_config.json"),
  ].filter(Boolean);
  if (candidates.some((p) => existsSync(p))) return true;
  return false;
}

function runLoginFlow() {
  return new Promise((resolve) => {
    log("not signed in — starting `zcode login --no-browser`; complete the OAuth URL printed below");
    const child = spawn(ZCODE_BIN, ["login", "--no-browser"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (err) => {
      log(`login failed to start: ${err.message}`);
      resolve();
    });
    child.on("close", (code) => {
      log(`login exited with code ${code}`);
      resolve();
    });
  });
}

// ---------------------------------------------------------------- dispatch

async function handleRequest(id, method, params) {
  switch (method) {
    case "initialize": {
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { text: true, image: true, embeddedContext: false },
        },
        authMethods: [
          {
            id: "zcode-login",
            name: "Z.AI account (zcode login)",
            description: "Sign in to ZCode via the zcode OAuth flow.",
          },
        ],
      });
      return;
    }
    case "authenticate": {
      if (probeAuthed()) {
        log("authenticate: already signed in");
        reply(id, {});
        return;
      }
      await runLoginFlow();
      reply(id, {});
      return;
    }
    case "session/new": {
      const sessionId = randomUUID();
      sessions.set(sessionId, {
        cwd: params?.cwd || process.cwd(),
        mode: availableModes[0]?.id || "yolo",
        model: null,
        zcodeSession: null,
        child: null,
        cancelled: false,
      });
      reply(id, {
        sessionId,
        modes: { currentModeId: availableModes[0]?.id || "yolo", availableModes },
        models: {
          currentModelId: DEFAULT_MODEL_ID,
          availableModels: [
            { modelId: DEFAULT_MODEL_ID, name: "ZCode default (provider config)" },
            ...catalog.availableModels,
          ],
        },
      });
      return;
    }
    case "session/prompt": {
      const sess = sessions.get(params?.sessionId);
      if (!sess) {
        replyError(id, ERR_TURN_FAILED, `unknown session ${params?.sessionId}`);
        return;
      }
      if (sess.child) {
        replyError(id, ERR_TURN_FAILED, "a turn is already running in this session");
        return;
      }
      const outcome = await runTurn(sess, params?.prompt);
      if (outcome.ok) {
        emitMessageChunk(params.sessionId, outcome.response);
        reply(id, { stopReason: "end_turn" });
      } else if (outcome.cancelled) {
        reply(id, { stopReason: "cancelled" });
      } else {
        replyError(id, ERR_TURN_FAILED, outcome.error);
      }
      return;
    }
    case "session/cancel": {
      const sess = sessions.get(params?.sessionId);
      if (sess?.child) {
        sess.cancelled = true;
        try { sess.child.kill("SIGTERM"); } catch {}
        log(`cancelled turn in session ${params.sessionId}`);
      }
      return; // notification — no reply
    }
    case "session/set_mode": {
      const sess = sessions.get(params?.sessionId);
      if (!sess) {
        replyError(id, ERR_TURN_FAILED, `unknown session ${params?.sessionId}`);
        return;
      }
      if (!availableModes.some((m) => m.id === params?.modeId)) {
        replyError(id, ERR_TURN_FAILED, `unknown mode ${params?.modeId}`);
        return;
      }
      sess.mode = params.modeId;
      notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_mode", currentModeId: sess.mode },
      });
      reply(id, {});
      return;
    }
    case "session/set_model": {
      const sess = sessions.get(params?.sessionId);
      if (!sess) {
        replyError(id, ERR_TURN_FAILED, `unknown session ${params?.sessionId}`);
        return;
      }
      const wanted = params?.modelId;
      if (typeof wanted !== "string" || !wanted) {
        replyError(id, ERR_TURN_FAILED, "modelId required");
        return;
      }
      if (wanted !== DEFAULT_MODEL_ID && !splitCompositeModelId(wanted)) {
        replyError(id, ERR_TURN_FAILED, `unknown model ${wanted} — use "<providerId>::<modelId>" or ${DEFAULT_MODEL_ID}`);
        return;
      }
      sess.model = wanted;
      notify("session/update", {
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_model", currentModelId: sess.model },
      });
      reply(id, {});
      return;
    }
    case "session/load": {
      replyError(id, ERR_METHOD_NOT_FOUND, "session load is not supported (loadSession: false)");
      return;
    }
    default: {
      log(`unknown method: ${method}`);
      replyError(id, ERR_METHOD_NOT_FOUND, `method not supported: ${method}`);
    }
  }
}

// ---------------------------------------------------------------- main loop

// ACP clients and installers probe availability with `--version`; answer on
// stdout with a dotted triple before touching stdin (the stdio server would
// otherwise hang waiting for a request that never comes).
const ADAPTER_VERSION = "0.3.0";
if (process.argv.slice(2).some((arg) => arg === "--version" || arg === "-v")) {
  console.log(`zcode-acp ${ADAPTER_VERSION}`);
  process.exit(0);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log(`unparseable message: ${err.message}`);
      continue;
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      handleRequest(msg.id, msg.method, msg.params).catch((err) => {
        log(`handler error for ${msg.method}: ${err?.stack || err}`);
        replyError(msg.id, ERR_TURN_FAILED, `internal error: ${err?.message || err}`);
      });
    } else if (msg.method) {
      handleRequest(null, msg.method, msg.params).catch((err) => {
        log(`notification error for ${msg.method}: ${err?.stack || err}`);
      });
    }
  }
});
process.stdin.on("end", () => {
  for (const sess of sessions.values()) {
    try { sess.child?.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
});

log(`ready (zcode-acp ${ADAPTER_VERSION}, zcode=${ZCODE_BIN}, modes=${availableModes.map((m) => m.id).join(",")})`);
