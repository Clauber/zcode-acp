#!/usr/bin/env node
// Minimal ACP client for smoke-testing zcode-acp over stdio.
// Usage: node scripts/test-client.mjs [--prompt "text"] [--cwd dir]

import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const PROMPT = get("--prompt", "Create a file named acp-bridge-test.txt in the cwd containing exactly BRIDGE-OK, then confirm.");
const CWD = get("--cwd", process.cwd());
const BRIDGE = get("--bridge", new URL("../bin/zcode-acp.mjs", import.meta.url).pathname);

const child = spawn(process.execPath, [BRIDGE], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "session/update") {
      const u = msg.params.update;
      console.log(`[update] ${u.sessionUpdate}`, u.content?.text ? JSON.stringify(u.content.text).slice(0, 120) : "");
    } else if (msg.method) {
      console.log(`[notify] ${msg.method}`);
    }
  }
});

const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const init = await request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log("[init]", JSON.stringify(init.result || init.error));
if (!init.result) process.exit(1);

await request("authenticate", { methodId: "zcode-login" });
console.log("[auth] done");

const sn = await request("session/new", { cwd: CWD, mcpServers: [] });
console.log("[session/new]", JSON.stringify(sn.result || sn.error));
if (!sn.result) process.exit(1);
const sessionId = sn.result.sessionId;

console.log(`[prompt] ${PROMPT}`);
const t0 = Date.now();
const result = await request("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: PROMPT }],
});
console.log(`[prompt result] (${((Date.now() - t0) / 1000).toFixed(1)}s)`, JSON.stringify(result.result || result.error));

child.stdin.end();
child.kill();
process.exit(0);
