/**
 * Host half of the session-takeout bundle.
 *
 * The ask behind this plugin: carry one conversation to a brand-new computer and keep
 * talking to it there. Only the Host can do that, because the durable session log
 * (`sessionPersistence`), the attachment object store and the workspace registry all
 * live here. So the Host packs a session into a plain ZIP on exact routes, and later
 * restores such a ZIP into this machine's own store; the Client half only presses the
 * buttons.
 *
 * Bundle layout (deliberately readable, so a human can inspect or salvage a bundle
 * without this plugin):
 *
 *   manifest.json                 what the archive is, who/what/where it came from
 *   session/header.json           SessionHeader + inheritedEventCount
 *   session/events.jsonl          one SessionEvent per line, original order and seq
 *   attachments/<id>              raw stored bytes of every referenced attachment
 *   plugin/<file>                 this plugin's own sources, so the archive can install it
 *   README.md                     plain-language instructions
 *
 * Two properties drive the implementation. First, export must be durable: it flushes
 * the live session through the sessions service before reading, because an unfinished
 * write would otherwise be missing from the archive. Second, import must never damage
 * this machine's store: it refuses non-bundles, verifies every CRC before writing
 * anything, uses a fresh session id on collision, and points the restored session at a
 * new directory instead of the exporter's absolute path.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipRead, zipWrite } from './zip.js'

const EXPORT_ROUTE = '/session-takeout/export'
const IMPORT_ROUTE = '/session-takeout/import'
const REVEAL_ROUTE = '/session-takeout/reveal'

const FORMAT = 'dsh-session-bundle'
const FORMAT_VERSION = 1
const PACKAGE_TAG = 'dsh-session-takeout'
const MAX_BODY_BYTES = 512 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/
const TITLE_LIMIT = 60

export const inject = ['webServer', 'subprocess']

/* ------------------------------------------------------------------ paths ---- */

function homeDirectory() {
  return homedir()
}

/** The Host's own data directory: `$DSH_HOME`, else the default `~/.dsh`. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  return path.join(homeDirectory(), '.dsh')
}

/** Content-addressed attachment object path: `<home>/attachments/v1/objects/<aa>/<id>`. */
function attachmentObjectPath(id) {
  return path.join(dshHome(), 'attachments', 'v1', 'objects', id.slice(0, 2), id)
}

function documentsDirectory() {
  return path.join(homeDirectory(), 'Documents')
}

/** First existing directory from the candidates, else the home directory. */
async function firstExistingDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isDirectory()) return candidate
    } catch {
      // Missing candidate: try the next one.
    }
  }
  return homeDirectory()
}

async function exportDirectory() {
  return firstExistingDirectory([path.join(homeDirectory(), 'Downloads'), documentsDirectory()])
}

/* ------------------------------------------------------------------ values --- */

/**
 * Turn an arbitrary title into a single safe path component, keeping non-ASCII text
 * (a Chinese session title should stay readable in Finder).
 */
function safeName(value, fallback, limit = TITLE_LIMIT) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  const clipped = Array.from(text).slice(0, limit).join('').trim()
  return clipped || fallback
}

function shortId(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9]/g, '')
  return cleaned.slice(-6) || randomUUID().slice(0, 6)
}

/** Last `session/title` event wins; the session title is derived state, not a header field. */
function foldTitle(events) {
  let title = ''
  for (const event of events) {
    if (!event || event.type !== 'session/title') continue
    const value = event.data && event.data.title
    if (typeof value === 'string' && value.trim()) title = value.trim()
  }
  return title
}

/** Every attachment id referenced anywhere in the event payloads. */
function collectAttachmentIds(events) {
  const found = new Set()
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 16) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const id = value.attachmentId
    if (typeof id === 'string' && ATTACHMENT_ID.test(id)) found.add(id)
    for (const key of Object.keys(value)) {
      if (key === 'attachmentId') continue
      walk(value[key], depth + 1)
    }
  }
  for (const event of events) walk(event && event.data, 0)
  return [...found].sort()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** An error caused by the submitted archive itself, so the route can answer 4xx. */
function invalid(message, status = 400) {
  const error = new Error(message)
  error.status = status
  return error
}

/* ------------------------------------------------------------------ events --- */

/**
 * Read the complete durable log.
 *
 * `read()` already returns the event array, so the fast path is one call. The loop
 * exists because a large log may be paged: it only continues while the store reports
 * more events than we hold, and de-duplicates by `seq` so an offset the store
 * interprets differently cannot loop forever.
 */
async function readAllEvents(handle, expected) {
  const collected = []
  const seen = new Set()
  const absorb = (list) => {
    if (!Array.isArray(list)) return 0
    let added = 0
    for (const event of list) {
      const seq = event && typeof event.seq === 'number' ? event.seq : undefined
      if (seq !== undefined) {
        if (seen.has(seq)) continue
        seen.add(seq)
      }
      collected.push(event)
      added += 1
    }
    return added
  }

  let page = await handle.read()
  let eventState = page && page.eventState
  let added = absorb(page && page.events)

  for (let guard = 0; guard < 5000 && added > 0; guard += 1) {
    if (typeof expected !== 'number' || collected.length >= expected) break
    page = await handle.read(collected.length)
    eventState = (page && page.eventState) || eventState
    added = absorb(page && page.events)
  }

  return { events: collected, eventState }
}

/* ------------------------------------------------------------------ export --- */

async function exportSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw invalid('invalid session id')
  }

  const persistence = service(ctx, 'sessionPersistence')
  const sessions = service(ctx, 'sessions', true)

  // Durability barrier: a live conversation may still hold unwritten events.
  const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (live && typeof sessions.flush === 'function') {
    await sessions.flush(live)
  } else if (typeof persistence.flush === 'function') {
    await persistence.flush()
  }

  let snapshot
  if (typeof persistence.stat === 'function') {
    snapshot = await persistence.stat(sessionId)
  }
  if (!snapshot) throw invalid('session not found', 404)

  const handle = await persistence.open(sessionId, 'read')
  let events
  let eventState
  let header
  let inheritedEventCount
  try {
    header = handle.header
    inheritedEventCount = Number.isInteger(handle.inheritedEventCount) ? handle.inheritedEventCount : 0
    const result = await readAllEvents(handle, snapshot.eventCount)
    events = result.events
    eventState = result.eventState
  } finally {
    try {
      await handle.close()
    } catch {
      // A read handle that is already gone must not mask the export result.
    }
  }
  if (!header) header = snapshot.header
  if (!Array.isArray(events) || events.length === 0) throw invalid('session has no events')

  const title = foldTitle(events) || safeName(path.basename(header.cwd || ''), '') || 'Untitled session'
  const base = safeName(title, 'session')
  const name = base + '-' + shortId(sessionId) + '.zip'
  const directory = await exportDirectory()
  const target = await uniquePath(path.join(directory, name))

  const attachmentIds = collectAttachmentIds(events)
  const archives = []
  const included = []
  const missing = []
  for (const id of attachmentIds) {
    const objectPath = attachmentObjectPath(id)
    try {
      const info = await stat(objectPath)
      if (!info.isFile()) throw new Error('not a file')
      if (info.size > MAX_ATTACHMENT_BYTES) throw new Error('attachment too large')
      archives.push({ name: 'attachments/' + id, data: await readFile(objectPath) })
      included.push({ id, bytes: info.size })
    } catch (error) {
      missing.push({ id, reason: String((error && error.message) || error) })
    }
  }

  const eventsText = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  const headerDocument = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    header,
    inheritedEventCount,
    eventState: eventState === undefined ? null : eventState,
  }
  const manifest = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    exportedBy: { package: PACKAGE_TAG, platform: process.platform },
    session: {
      id: sessionId,
      title,
      createdAt: header.createdAt,
      cwd: header.cwd === undefined ? null : header.cwd,
      agentPreset: header.agentPreset === undefined ? null : header.agentPreset,
      isSeeded: header.isSeeded === true,
      formatVersion: header.version,
      eventCount: events.length,
    },
    inheritedEventCount,
    counts: {
      events: events.length,
      attachments: included.length,
      missingAttachments: missing.length,
    },
    attachments: included,
    missingAttachments: missing,
    checksums: {
      eventsSha256: sha256(Buffer.from(eventsText, 'utf8')),
    },
  }

  const carried = await carriedSources()
  manifest.counts.pluginFiles = carried.length

  const archive = zipWrite(
    [
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
      { name: 'session/header.json', data: JSON.stringify(headerDocument, null, 2) + '\n' },
      { name: 'session/events.jsonl', data: eventsText },
      ...archives,
      ...carried,
      { name: 'README.md', data: readmeText(title) },
    ],
    new Date(),
  )

  await writeFile(target, archive)
  return {
    path: target,
    name: path.basename(target),
    bytes: archive.length,
    title,
    events: events.length,
    attachments: included.length,
    missingAttachments: missing.length,
  }
}

/** Files copied into every bundle so the receiving machine can install the plugin. */
const CARRIED_FILES = [
  'package.json',
  'cordis.patch.yml',
  'index.js',
  'client.js',
  'zip.js',
  'icon.svg',
  'README.md',
  'locale/en.json',
  'locale/zh.json',
]

async function carriedSources() {
  let root
  try {
    root = fileURLToPath(new URL('.', import.meta.url))
  } catch {
    return []
  }
  const entries = []
  for (const name of CARRIED_FILES) {
    try {
      const target = path.join(root, name)
      const info = await stat(target)
      if (!info.isFile()) continue
      entries.push({ name: 'plugin/' + name, data: await readFile(target) })
    } catch {
      // A missing file only trims the copy carried in the archive; the session data
      // itself is what must never be dropped.
    }
  }
  return entries
}

function readmeText(title) {
  return [
    '# DeepSeek Harness session bundle',
    '',
    'Session: ' + title,
    '',
    'This ZIP is one conversation, packed so it can be opened on another computer.',
    '',
    '## To continue the conversation elsewhere',
    '',
    '1. Copy this ZIP to the other computer (AirDrop, USB stick, cloud drive: any way).',
    '2. Unzip it. It carries the plugin itself in `plugin/`.',
    '3. On the other computer, tell the DeepSeek Harness agent:',
    '',
    '       install the plugin in <path>/plugin as an installed bundle, then import <path>.zip',
    '',
    '   (The agent installs it with its plugin manager and posts the ZIP to the plugin route.)',
    '   Without an agent, install `plugin/` yourself, restart, then click "Import bundle"',
    '   below the message box and pick this ZIP.',
    '4. The conversation opens in its own workspace; keep typing to continue.',
    '',
    '## What is inside',
    '',
    '- `manifest.json` — what this archive is, plus counts and checksums.',
    '- `session/header.json` — the original session header.',
    '- `session/events.jsonl` — the full event log, one JSON object per line.',
    '- `attachments/` — raw bytes of every image or file the conversation used.',
    '- `plugin/` — the plugin that can open this archive on a computer that lacks it.',
    '- `README.md` — this file.',
    '',
    'The conversation text is plain JSON, so it stays readable without this plugin.',
    '',
  ].join('\n')
}

/* ------------------------------------------------------------------ import --- */

async function importBundle(ctx, buffer) {
  let files
  try {
    files = zipRead(buffer)
  } catch (error) {
    throw invalid('not a readable zip archive: ' + String((error && error.message) || error))
  }
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw invalid('not a session bundle (no manifest.json)')

  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw invalid('not a session bundle (manifest.json is not valid JSON)')
  }
  if (!manifest || manifest.format !== FORMAT) throw invalid('not a session bundle (unexpected format)')
  if (Number(manifest.formatVersion) > FORMAT_VERSION) {
    throw invalid('bundle was written by a newer version of this plugin (format ' + manifest.formatVersion + ')')
  }

  const headerBytes = files.get('session/header.json')
  const eventsBytes = files.get('session/events.jsonl')
  if (!headerBytes) throw invalid('bundle is incomplete (no session/header.json)')
  if (!eventsBytes) throw invalid('bundle is incomplete (no session/events.jsonl)')

  let headerDocument
  try {
    headerDocument = JSON.parse(headerBytes.toString('utf8'))
  } catch {
    throw invalid('bundle is incomplete (session/header.json is not valid JSON)')
  }
  const sourceHeader = headerDocument && headerDocument.header ? headerDocument.header : headerDocument
  if (!sourceHeader || typeof sourceHeader !== 'object') throw invalid('bundle is incomplete (empty header)')

  const events = []
  for (const line of eventsBytes.toString('utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      throw invalid('bundle is corrupt (unparseable event on line ' + (events.length + 1) + ')')
    }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
      throw invalid('bundle is corrupt (malformed event on line ' + (events.length + 1) + ')')
    }
    events.push(event)
  }
  if (events.length === 0) throw invalid('bundle is empty (no events)')

  // The archive may have been edited by hand, and the events are the user's own data,
  // so a checksum mismatch is reported rather than turned into a refusal. Each ZIP entry
  // was already CRC-verified by the reader, which catches the damage that matters.
  const expected = manifest.checksums && typeof manifest.checksums.eventsSha256 === 'string'
    ? manifest.checksums.eventsSha256.toLowerCase()
    : null
  const checksumVerified = expected === null ? null : sha256(eventsBytes) === expected

  const inheritedEventCount = Number.isInteger(headerDocument.inheritedEventCount)
    ? Math.max(0, headerDocument.inheritedEventCount)
    : Number.isInteger(manifest.inheritedEventCount)
      ? Math.max(0, manifest.inheritedEventCount)
      : 0

  const title =
    (manifest.session && typeof manifest.session.title === 'string' && manifest.session.title.trim()) ||
    foldTitle(events) ||
    'Imported session'
  const stamp = shortId(manifest.session && manifest.session.id)
  const workspaceTitle = safeName(title, 'Imported session')
  const directory = await uniquePath(
    path.join(documentsDirectory(), 'DeepSeek Harness', safeName(workspaceTitle, 'session', 48) + '-' + stamp),
  )
  await mkdir(directory, { recursive: true })

  // Attachments first: a session whose image references resolve is strictly better,
  // and a failure here must not leave a half-restored session behind.
  const restored = []
  const skipped = []
  for (const [name, data] of files) {
    if (!name.startsWith('attachments/')) continue
    const id = name.slice('attachments/'.length)
    if (!ATTACHMENT_ID.test(id)) continue
    const target = attachmentObjectPath(id)
    try {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, data, { flag: 'wx' })
      restored.push(id)
    } catch (error) {
      if (error && error.code === 'EEXIST') skipped.push(id)
      else throw new Error('could not restore attachment ' + id + ': ' + String((error && error.message) || error))
    }
  }

  const persistence = service(ctx, 'sessionPersistence')
  const localVersion = await localFormatVersion(persistence)
  const version = localVersion === null || localVersion === undefined
    ? (Number.isInteger(sourceHeader.version) ? sourceHeader.version : null)
    : localVersion
  if (!Number.isInteger(version)) throw new Error('could not determine the local session format version')
  const minted = () => 'session-' + randomUUID()

  let id = typeof sourceHeader.id === 'string' && SESSION_ID.test(sourceHeader.id) ? sourceHeader.id : minted()
  if (await sessionExists(persistence, id)) id = minted()

  const buildHeader = (sessionId) => {
    const header = {
      version,
      id: sessionId,
      createdAt: coerceCreatedAt(sourceHeader.createdAt),
      cwd: directory,
      isSeeded: false,
    }
    if (typeof sourceHeader.agentPreset === 'string' && sourceHeader.agentPreset.trim()) {
      header.agentPreset = sourceHeader.agentPreset
    }
    return header
  }

  let markersRebound = 0
  const create = async (sessionId) => {
    markersRebound = rebindDeliveryMarkers(events, sessionId, version)
    const handle = await persistence.create(buildHeader(sessionId), { inheritedEventCount })
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      try {
        await handle.close()
      } catch {
        // Closing twice is not an error worth failing an import over.
      }
    }
  }

  try {
    await create(id)
  } catch (error) {
    const message = String((error && error.message) || error)
    if (!/exist/i.test(message)) throw new Error('could not write the session: ' + message)
    id = minted()
    await create(id)
  }

  const registry = service(ctx, 'workspaceRegistry', true)
  let workspaceId = null
  let workspaceError = null
  if (registry && typeof registry.create === 'function') {
    // A duplicate title is a presentation problem, not a reason to hide the session, so
    // fall back to progressively plainer registrations before giving up.
    const attempts = [
      () => registry.create(directory, workspaceTitle),
      () => registry.create(directory),
      () => registry.create(directory, workspaceTitle + ' (2)'),
    ]
    let workspace = null
    for (const attempt of attempts) {
      try {
        workspace = await attempt()
        workspaceError = null
        break
      } catch (error) {
        workspaceError = String((error && error.message) || error)
      }
    }
    if (workspace) {
      workspaceId = workspace.id ? workspace.id : null
      try {
        if (typeof workspace.attachSession === 'function') await workspace.attachSession(id)
        workspaceError = null
      } catch (error) {
        // The session is imported and the workspace exists; only the link failed, which
        // the UI can fix by dragging the session into the workspace.
        workspaceError = 'session imported but not attached to its workspace: ' + String((error && error.message) || error)
      }
    }
  }

  return {
    sessionId: id,
    workspaceId,
    path: directory,
    title: workspaceTitle,
    events: events.length,
    attachments: restored.length,
    attachmentsAlreadyPresent: skipped.length,
    checksumVerified,
    markersRebound,
    ...(workspaceError === null ? {} : { workspaceError }),
  }
}

/** `createdAt` is stored as epoch milliseconds; an ISO string from an older bundle is converted. */
function coerceCreatedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const milliseconds = Date.parse(value)
    if (!Number.isNaN(milliseconds)) return milliseconds
  }
  return Date.now()
}

const DELIVERY_MARKER = 'session-log-deepseek/delivery-accepted'

/**
 * Re-point the log's delivery markers at the session this machine will actually own.
 *
 * A marker records which session its accepted prefix belongs to, and the store refuses a
 * log whose current marker names another session ("delivery marker names the wrong
 * Session"). That is exactly what a restored log looks like once this machine mints a
 * fresh id, or once the source and target disagree about the format version, so both
 * fields are rewritten here. Everything else in the log is left untouched: those are
 * historical facts about what happened, not claims about where the log now lives.
 */
function rebindDeliveryMarkers(events, sessionId, version) {
  let rebound = 0
  for (const event of events) {
    if (!event || event.type !== DELIVERY_MARKER) continue
    if (!event.data || typeof event.data !== 'object') continue
    if (event.data.sessionId !== sessionId) {
      event.data.sessionId = sessionId
      rebound += 1
    }
    if (Number.isInteger(version) && event.data.sessionFormatVersion !== version) {
      event.data.sessionFormatVersion = version
      rebound += 1
    }
  }
  return rebound
}

async function sessionExists(persistence, id) {
  if (typeof persistence.stat !== 'function') return false
  try {
    const snapshot = await persistence.stat(id)
    return snapshot !== undefined && snapshot !== null
  } catch {
    return false
  }
}

/**
 * The session format version this installation writes.
 *
 * A restored log must use the local format, or reads would reject it. The store does
 * not publish the constant, so read it from any session that already exists here; a
 * machine with no sessions at all falls back to the bundle's own version, which is the
 * best available guess and is at least self-consistent.
 */
async function localFormatVersion(persistence) {
  try {
    const snapshots = await persistence.list()
    for (const snapshot of snapshots || []) {
      const version = snapshot && snapshot.header && snapshot.header.version
      if (Number.isInteger(version)) return version
    }
  } catch {
    // Fall through to the caller's fallback.
  }
  return null
}

/** Append `-2`, `-3`, ... until the path is free. */
async function uniquePath(candidate) {
  try {
    await stat(candidate)
  } catch {
    return candidate
  }
  const extension = path.extname(candidate)
  const stem = candidate.slice(0, candidate.length - extension.length)
  for (let index = 2; index < 1000; index += 1) {
    const next = stem + '-' + index + extension
    try {
      await stat(next)
    } catch {
      return next
    }
  }
  return stem + '-' + Date.now() + extension
}

/* ------------------------------------------------------------------ reveal --- */

async function revealPath(ctx, target) {
  if (process.platform !== 'darwin') return false
  const argv = ['/usr/bin/open', '-R', target]
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: '/',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 8192 } },
      graceMs: 1000,
    })
    await handle.done
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------- route --- */

function service(ctx, name, optional = false) {
  let value
  try {
    value = ctx.get(name)
  } catch (error) {
    value = undefined
  }
  if (!value && !optional) throw new Error('service-unavailable: ' + name)
  return value
}

/**
 * Authentication policy, deliberately identical to the other first-party-scale plugin
 * in this profile: Connection's `403` is a real Host/Origin violation and the route
 * refuses; `401` means no browser credential was replayed, which is not meaningful for
 * a loopback request made by a process that could read the same files directly, and no
 * CORS headers are emitted so another origin cannot read the answer from a page.
 */
function blockRejection(rejection) {
  return rejection === 403
}

function sendJson(res, status, body, method) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(method === 'HEAD' ? undefined : payload)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const fail = (error) => {
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(invalid('request body is too large', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', fail)
    req.on('aborted', () => fail(new Error('request aborted')))
  })
}

async function readJson(req) {
  const body = await readBody(req, MAX_JSON_BYTES)
  if (body.length === 0) return {}
  try {
    const value = JSON.parse(body.toString('utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

export function apply(ctx) {
  const guard = (req, res, method) => {
    const connection = ctx.get('connection')
    if (!connection || typeof connection.requestRejection !== 'function') return false
    let rejection
    try {
      rejection = connection.requestRejection({ headers: req.headers })
    } catch {
      rejection = undefined
    }
    if (!blockRejection(rejection)) return false
    sendJson(res, rejection, { ok: false, error: 'unauthorized' }, method)
    return true
  }

  const route = (pathname, handler) => {
    const listener = async (req, res) => {
      const method = (req.method || 'GET').toUpperCase()
      if (method !== 'POST' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
        return
      }
      if (guard(req, res, method)) return
      try {
        const payload = await handler(req, method)
        if (!res.writableEnded) sendJson(res, 200, payload, method)
      } catch (error) {
        const message = String((error && error.message) || error)
        const status = error && typeof error.status === 'number' ? error.status : 500
        if (!res.writableEnded) sendJson(res, status, { ok: false, error: message }, method)
      }
    }
    return ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: pathname, handler: listener }),
      'session-takeout: ' + pathname,
    )
  }

  route(EXPORT_ROUTE, async (req) => {
    const body = await readJson(req)
    const result = await exportSession(ctx, body.sessionId)
    const revealed = await revealPath(ctx, result.path)
    return { ok: true, revealed, ...result }
  })

  route(IMPORT_ROUTE, async (req) => {
    const body = await readBody(req, MAX_BODY_BYTES)
    if (body.length === 0) throw invalid('request body is empty')
    const result = await importBundle(ctx, body)
    return { ok: true, ...result }
  })

  route(REVEAL_ROUTE, async (req) => {
    const body = await readJson(req)
    const target = typeof body.path === 'string' ? body.path : ''
    if (!target) throw invalid('invalid path')
    const revealed = await revealPath(ctx, target)
    return { ok: true, revealed }
  })
}
