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
// Env:
//   ZCODE_ACP_ZCODE_BIN        zcode executable (default: "zcode" on PATH)
//   ZCODE_ACP_TURN_TIMEOUT_MS  hard per-turn kill timer (default: 0 = none)
//   ZCODE_ACP_MODES            comma list to restrict advertised modes
//   ZCODE_ACP_SKIP_AUTH_CHECK  "1" to treat authenticate as always successful

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const ZCODE_BIN = process.env.ZCODE_ACP_ZCODE_BIN || "zcode";
const TURN_TIMEOUT_MS = Number(process.env.ZCODE_ACP_TURN_TIMEOUT_MS || 0);

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

/** @type {Map<string, {cwd:string, mode:string, zcodeSession:string|null, child:import('child_process').ChildProcess|null, cancelled:boolean}>} */
const sessions = new Map();

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

    const argv = [ZCODE_BIN, "-p", text, "--json", "--cwd", sess.cwd, "--mode", sess.mode];
    for (const file of attachPaths) argv.push("--attach", file);
    if (sess.zcodeSession) argv.push("--resume", sess.zcodeSession);

    log(`turn start: mode=${sess.mode} resume=${sess.zcodeSession || "new"} attach=${attachPaths.length}`);
    const child = spawn(ZCODE_BIN, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
        zcodeSession: null,
        child: null,
        cancelled: false,
      });
      reply(id, {
        sessionId,
        modes: { currentModeId: availableModes[0]?.id || "yolo", availableModes },
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
      replyError(id, ERR_METHOD_NOT_FOUND, "model switching is not supported by zcode-acp v1");
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

log(`ready (zcode=${ZCODE_BIN}, modes=${availableModes.map((m) => m.id).join(",")})`);
