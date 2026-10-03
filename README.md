# zcode-acp

[Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter that exposes the
[ZCode](https://z.ai) CLI as an ACP agent over stdio, so ACP clients — Zed, T3 Code, and
anything else speaking ACP — can drive ZCode sessions.

## How it works

The adapter is a zero-dependency Node script (Node ≥ 20). For every ACP turn it spawns one
`zcode -p <prompt> --json [--resume <sess_id>]` process with the session's `cwd`, waits for
the JSON result, and streams the response back to the client. ZCode persists its own
sessions on disk (`sess_*` ids), which gives session resume for free.

Supported ACP surface:

| ACP method | Behavior |
| --- | --- |
| `initialize` | Advertises auth method + prompt capabilities |
| `authenticate` | Succeeds immediately when ZCode credentials exist; otherwise runs `zcode login --no-browser` |
| `session/new` | Creates an ACP session bound to a cwd (permission mode: yolo) |
| `session/prompt` | Runs one ZCode turn, emits `agent_message_chunk`, returns `end_turn` |
| `session/cancel` | Kills the running turn |
| `session/set_mode` | Yolo only (see below) |

Text and image prompt blocks are supported; images are materialized to temp files and
passed via `zcode --attach`.

> **Why yolo only?** In headless `-p` runs, ZCode auto-denies tool use in every non-yolo
> permission mode ("no permission client connected"), so restricting to yolo is honest.

## Install

```sh
npm install -g zcode-acp    # or use the release tarballs
```

Requires the `zcode` CLI on PATH (or point `ZCODE_ACP_ZCODE_BIN` at it).

## Configure

| Env var | Default | Meaning |
| --- | --- | --- |
| `ZCODE_ACP_ZCODE_BIN` | `zcode` | ZCode executable to spawn |
| `ZCODE_ACP_TURN_TIMEOUT_MS` | `0` (off) | Hard per-turn kill timer |
| `ZCODE_ACP_SKIP_AUTH_CHECK` | `0` | Treat `authenticate` as always successful |

## Run

```sh
zcode-acp            # ACP over stdio; logs on stderr
```

## License

MIT
