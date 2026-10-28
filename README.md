# dsh-session-takeout

**English** · [简体中文](README.zh-CN.md)

Packs one DeepSeek Harness conversation into a single ZIP, so you can carry it to
another computer and keep talking there.

```bash
plugin_manager → install_bundle → target: <this directory>
```

Below the message box there are two small buttons:

- **导出会话 / Export session** — packs the current conversation into one ZIP in
  `~/Downloads`, then reveals it in Finder.
- **导入会话包 / Import bundle** — restores such a ZIP on this computer, opens it, and
  continues the conversation.

## Why the Host does the work

A conversation is not just text in the browser. The durable event log, the attachment
object store and the workspace registry live on the machine running the Host, so the
Client half only presses two routes:

| Route | Purpose |
| --- | --- |
| `POST /session-takeout/export` | `{ sessionId }` → writes and reveals a ZIP, returns its path |
| `POST /session-takeout/import` | raw ZIP bytes → restores the session, returns its new id |
| `POST /session-takeout/reveal` | `{ path }` → reveals a path in Finder |

## What is inside a bundle

```
manifest.json          format tag, session summary, counts, checksums
session/header.json    SessionHeader + inheritedEventCount
session/events.jsonl   the full event log, one JSON object per line
attachments/<id>       raw bytes of every image or file the conversation used
plugin/<file>          this plugin's own sources, so the archive can install it
README.md              plain instructions for a human
```

The container is an ordinary ZIP (deflate, UTF-8 names, no ZIP64), written with
`node:zlib` and a local CRC-32 table so no dependency is pulled in. It opens in Finder,
Explorer and `unzip`; the conversation itself stays readable without this plugin.

The `format` tag inside `manifest.json` stays `dsh-session-bundle` on purpose: the
archive format is versioned separately from the project name, so bundles written by
earlier builds keep importing after a rename.

## Export is durable, import is careful

- **Export** first flushes the live session through the sessions service, because a
  conversation that is still being written would otherwise be short of events. It then
  reads the durable log and copies only attachments the events actually reference.
- **Import** never touches this machine's store until the archive has been fully parsed
  and every entry CRC-verified. It then:
  - restores attachments into the content-addressed object store (existing objects win),
  - writes the log under the *local* session format version,
  - points the restored session's `cwd` at a fresh directory,
  - mints a new session id when the source id already exists here,
  - registers that directory as a workspace and attaches the session to it.

A restored conversation therefore lands in
`~/Documents/DeepSeek Harness/<title>-<shortid>/`, which becomes its workspace — the
exporter's absolute paths are never reused.

## Carrying it to a computer that has never seen this plugin

Every exported ZIP carries this plugin's sources under `plugin/`, so a fresh machine
needs nothing but the archive:

1. Copy the ZIP over and unzip it.
2. Install `plugin/` as a bundle (`plugin_manager → install_bundle → <unzipped>/plugin`).
   On a machine that has never run this plugin, ask its agent to do this step — it can
   also post the ZIP to the route itself, without opening any dialog:
   `curl -X POST http://127.0.0.1:<port>/session-takeout/import --data-binary @bundle.zip`
3. Click **导入会话包 / Import bundle** and pick the ZIP (or let the agent's request do
   the same thing), then the restored conversation opens ready to continue.

## Limits worth knowing

- Attachments whose object file is missing on the exporting machine are listed in
  `manifest.json` under `missingAttachments` and simply do not travel.
- A session that was forked from another conversation keeps its `inheritedEventCount`;
  the parent's prefix is not part of the bundle, so only the part stored in this log
  arrives.
- `agentPreset` travels as an id. If that preset is not installed on the target, the
  session opens with the default agent.

## Install

```
plugin_manager → install_bundle → target: <this directory>
```

The bundle patch inserts one row; nothing else in the profile needs editing. Restart
the Web UI (or let the client plugin hot-reload) and the two buttons appear under the
message box.

## Test

```bash
node test/bundle.test.mjs   # 48 checks against fake services and a throwaway HOME
```

## License

MIT
