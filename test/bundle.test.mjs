/**
 * Sandboxed integration test for the dsh-session-takeout Host half.
 *
 * Runs the real route handlers from index.js against fake services and a throwaway
 * HOME/DSH_HOME under /tmp, so the whole export → import loop (including attachments,
 * id collision, cwd rewrite and delivery-marker rebinding) is exercised without
 * touching this machine's session store.
 */

import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sandbox = mkdtempSync(path.join(tmpdir(), 'sb-home-'))
mkdirSync(path.join(sandbox, 'Downloads'), { recursive: true })
process.env.HOME = sandbox
process.env.DSH_HOME = path.join(sandbox, '.dsh')

const { zipRead } = await import(new URL('../zip.js', import.meta.url).href)
const host = await import(new URL('../index.js', import.meta.url).href)

/* ------------------------------------------------------------ fake services --- */

const store = new Map()
const workspaces = new Map()

const persistence = {
  async list() {
    return [...store.values()].map((record) => ({ header: record.header, eventCount: record.events.length }))
  },
  async stat(id) {
    const record = store.get(id)
    if (!record) return undefined
    return { header: record.header, eventCount: record.events.length, sizeBytes: 0, revision: 1 }
  },
  async open(id, access) {
    const record = store.get(id)
    if (!record) throw new Error('session not found: ' + id)
    return {
      id,
      header: record.header,
      inheritedEventCount: record.inherited,
      access,
      async read() {
        return { eventState: 'shared-frozen', events: record.events.map((event) => structuredClone(event)) }
      },
      async append(events) {
        record.events.push(...events)
      },
      async flush() {},
      async close() {},
    }
  },
  async create(header, options) {
    if (store.has(header.id)) throw new Error('session already exists: ' + header.id)
    const record = { header, events: [], inherited: options?.inheritedEventCount ?? 0 }
    store.set(header.id, record)
    return {
      id: header.id,
      header,
      inheritedEventCount: record.inherited,
      async append(events) {
        record.events.push(...events)
      },
      async flush() {},
      async close() {},
    }
  },
  async flush() {},
}

const services = {
  sessionPersistence: persistence,
  sessions: { get: () => ({ id: 'x' }), async flush() {} },
  workspaceRegistry: {
    async create(dir, title) {
      const workspace = {
        id: 'ws-' + (workspaces.size + 1),
        path: dir,
        title,
        attached: [],
        async attachSession(sessionId) {
          this.attached.push(sessionId)
        },
      }
      workspaces.set(workspace.id, workspace)
      return workspace
    },
  },
  connection: undefined,
}

const handlers = new Map()
const ctx = {
  get(name) {
    return services[name]
  },
  effect(factory) {
    factory()
  },
  webServer: {
    register({ path: route, handler }) {
      handlers.set(route, handler)
      return () => handlers.delete(route)
    },
  },
  subprocess: {
    spawn() {
      return { done: Promise.resolve({ exitCode: 0 }), collected: {}, terminate() {} }
    },
  },
}

host.apply(ctx)

/* --------------------------------------------------------------- fake http --- */

function request(route, { body, json } = {}) {
  const handler = handlers.get(route)
  if (!handler) throw new Error('route not registered: ' + route)
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json), 'utf8') : body ?? Buffer.alloc(0)
  const req = Readable.from([payload])
  req.method = 'POST'
  req.headers = { 'content-type': json !== undefined ? 'application/json' : 'application/zip' }
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      statusCode: 0,
      headers: null,
      writableEnded: false,
      writeHead(status, headers) {
        this.statusCode = status
        this.headers = headers
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk))
        this.writableEnded = true
        resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      },
    }
    handler(req, res).catch(reject)
  })
}

/* ------------------------------------------------------------------- checks --- */

const results = []
const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition), detail })
  if (!condition) console.log('FAIL  ' + name + '  ' + (detail === undefined ? '' : JSON.stringify(detail)))
  else console.log('ok    ' + name)
}

// 1. seed a source session that references one attachment
const attachmentId = 'AbCdEf0123456789'
const attachmentBytes = Buffer.from('attachment payload \u0000\u0001 bytes', 'utf8')
const objectPath = path.join(sandbox, '.dsh', 'attachments', 'v1', 'objects', attachmentId.slice(0, 2), attachmentId)
mkdirSync(path.dirname(objectPath), { recursive: true })
writeFileSync(objectPath, attachmentBytes)

const sourceId = 'session-11111111-2222-3333-4444-555555555555'
const sourceEvents = [
  { type: 'permission/preset', seq: 0, time: 1793000000000, data: { preset: 'workspace-write' } },
  {
    type: 'user/message',
    seq: 1,
    time: 1793000000001,
    data: { message: { role: 'user', content: [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: attachmentBytes.length } }] } },
  },
  { type: 'session-log-deepseek/delivery-accepted', seq: 2, time: 1793000000002, data: { sessionId: sourceId, sessionFormatVersion: 4, throughSeq: 1 } },
  { type: 'session/title', seq: 3, time: 1793000000003, data: { title: '沙盒里的会话', messageSeqs: [1], source: { kind: 'fallback' } } },
]
store.set(sourceId, {
  header: { version: 4, id: sourceId, createdAt: 1793000000000, cwd: '/old/place', isSeeded: false, agentPreset: 'standard' },
  events: sourceEvents,
  inherited: 0,
})

// 2. export
const exported = await request('/session-takeout/export', { json: { sessionId: sourceId } })
check('export: HTTP 200', exported.status === 200, exported.status)
check('export: ok', exported.body.ok === true, exported.body)
check('export: zip written under sandbox Downloads', String(exported.body.path).startsWith(path.join(sandbox, 'Downloads')), exported.body.path)
check('export: title folded from events', exported.body.title === '沙盒里的会话', exported.body.title)
check('export: one attachment collected', exported.body.attachments === 1, exported.body)
check('export: nothing missing', exported.body.missingAttachments === 0, exported.body)
check('export: revealed', exported.body.revealed === true, exported.body)

const archive = readFileSync(exported.body.path)
const entries = zipRead(archive)
check('zip: manifest present', entries.has('manifest.json'))
check('zip: header present', entries.has('session/header.json'))
check('zip: events present', entries.has('session/events.jsonl'))
check('zip: attachment bytes identical', Buffer.compare(entries.get('attachments/' + attachmentId), attachmentBytes) === 0)
check('zip: events line count', entries.get('session/events.jsonl').toString('utf8').trim().split('\n').length === 4)
check('zip: README is bilingual', /## \u4e2d\u6587/.test(entries.get('README.md').toString('utf8')) && /## English/.test(entries.get('README.md').toString('utf8')))
const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
check('manifest: format tag', manifest.format === 'dsh-session-bundle', manifest.format)
check('manifest: checksum present', /^[0-9a-f]{64}$/.test(manifest.checksums.eventsSha256), manifest.checksums)
const eventsText = entries.get('session/events.jsonl')
check(
  'manifest: checksum matches',
  createHash('sha256').update(eventsText).digest('hex') === manifest.checksums.eventsSha256,
)

// 3. import into the sandbox, with the attachment object removed from the store first
unlinkSync(objectPath)
check('zip holds the only copy of the attachment', !existsSync(objectPath))
const imported = await request('/session-takeout/import', { body: archive })
check('import: HTTP 200', imported.status === 200, imported.body)
check('import: ok', imported.body.ok === true, imported.body)
check('import: checksum verified', imported.body.checksumVerified === true, imported.body)
check('import: markers rebound', imported.body.markersRebound === 1, imported.body)
check('import: event count', imported.body.events === 4, imported.body)

const importedRecord = store.get(imported.body.sessionId)
check('import: session stored', Boolean(importedRecord))
check('import: cwd points inside sandbox Documents', String(importedRecord.header.cwd).startsWith(path.join(sandbox, 'Documents', 'DeepSeek Harness')), importedRecord.header.cwd)
check('import: createdAt stays a number', typeof importedRecord.header.createdAt === 'number', importedRecord.header.createdAt)
check('import: local format version', importedRecord.header.version === 4, importedRecord.header.version)
check('import: preset traveled', importedRecord.header.agentPreset === 'standard', importedRecord.header)
check('import: isSeeded cleared', importedRecord.header.isSeeded === false)
check('import: parentSession dropped', importedRecord.header.parentSession === undefined)
check('import: attachment restored to object store', existsSync(objectPath) && Buffer.compare(readFileSync(objectPath), attachmentBytes) === 0)
check('import: restored attachment reported', imported.body.attachments === 1, imported.body)
const marker = importedRecord.events.find((event) => event.type === 'session-log-deepseek/delivery-accepted')
check('import: marker names the new session', marker.data.sessionId === imported.body.sessionId, marker.data)
check('import: workspace created', typeof imported.body.workspaceId === 'string', imported.body.workspaceId)
const workspace = workspaces.get(imported.body.workspaceId)
check('import: session attached to workspace', workspace.attached.includes(imported.body.sessionId), workspace)
check('import: workspace title', workspace.title === '沙盒里的会话', workspace.title)

// 4. import the same archive again: id collides, directory gets a suffix
const again = await request('/session-takeout/import', { body: archive })
check('re-import: ok', again.body.ok === true, again.body)
check('re-import: new session id minted', again.body.sessionId !== imported.body.sessionId, again.body.sessionId)
check('re-import: separate directory', again.body.path !== imported.body.path, [imported.body.path, again.body.path])
check('re-import: second directory exists', statSync(again.body.path).isDirectory())
check('re-import: existing attachment left alone', again.body.attachmentsAlreadyPresent === 1, again.body)

// 5. a second export of the imported session round-trips the same content
const reexport = await request('/session-takeout/export', { json: { sessionId: imported.body.sessionId } })
check('re-export: ok', reexport.body.ok === true, reexport.body)
check('re-export: same event count', reexport.body.events === 4, reexport.body)
check('re-export: different file name', reexport.body.name !== exported.body.name, [exported.body.name, reexport.body.name])

// 6. rejections
const notZip = await request('/session-takeout/import', { body: Buffer.from('this is not a zip file at all') })
check('reject: non-zip is 400', notZip.status === 400, notZip)
const empty = await request('/session-takeout/import', { body: Buffer.alloc(0) })
check('reject: empty body is 400', empty.status === 400, empty)
const noSession = await request('/session-takeout/export', { json: { sessionId: 'session-does-not-exist' } })
check('reject: unknown session is 404', noSession.status === 404, noSession)
const badId = await request('/session-takeout/export', { json: { sessionId: '../etc/passwd' } })
check('reject: path-ish session id', badId.status === 400 || badId.status === 500, badId)

// 7. corrupt archive: flip a byte inside the deflated stream
const damaged = Buffer.from(archive)
const target = damaged.indexOf(Buffer.from('attachment payload'))
damaged[target + 2] ^= 0xff
const corrupt = await request('/session-takeout/import', { body: damaged })
check('reject: corrupted archive', corrupt.status === 400, corrupt)

const failed = results.filter((entry) => !entry.ok)
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed')
if (failed.length) process.exitCode = 1
