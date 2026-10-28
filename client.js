window.__ModuleLoader__.load({
  id: 'dsh-session-takeout',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionTakeout'
    const DICT = {
      en: {
        title: 'Session takeout',
        exportLabel: 'Export session',
        importLabel: 'Import bundle',
        exportHint: 'Pack this conversation into a ZIP that opens on another computer',
        importHint: 'Restore a session bundle ZIP into this computer',
        exporting: 'Packing…',
        importing: 'Importing…',
        exported: 'Saved {name}',
        imported: 'Imported — this conversation is open',
        importedManual: 'Imported to {path}',
        noSession: 'No session to export yet',
        unavailable: 'Host API is not ready',
        failed: 'Failed: {message}',
      },
      zh: {
        title: '会话打包',
        exportLabel: '导出会话',
        importLabel: '导入会话包',
        exportHint: '把这个会话打成一个压缩包，可在另一台电脑上打开继续',
        importHint: '把会话压缩包恢复到这台电脑',
        exporting: '打包中…',
        importing: '导入中…',
        exported: '已保存 {name}',
        imported: '已导入，会话已打开',
        importedManual: '已导入到 {path}',
        noSession: '还没有可导出的会话',
        unavailable: '本机接口未就绪',
        failed: '失败：{message}',
      },
    }

    const EXPORT_ENDPOINT = 'session-takeout/export'
    const IMPORT_ENDPOINT = 'session-takeout/import'
    const STATUS_LIFETIME_MS = 14000

    const CSS = `
.dsh-sb { display:inline-flex; align-items:center; gap:2px; min-width:0; }
.dsh-sb-btn { display:inline-flex; align-items:center; gap:5px; box-sizing:border-box; height:26px; padding:0 8px; border:0; border-radius:999px; background:transparent; color:var(--dsw-alias-label-secondary); font-family:inherit; font-size:12px; line-height:1; white-space:nowrap; cursor:pointer; user-select:none; -webkit-user-select:none; }
.dsh-sb-btn:hover:not(:disabled) { color:var(--dsw-alias-label-primary); background:var(--dsw-alias-fill-tertiary, rgba(127,127,127,.12)); }
.dsh-sb-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary, currentColor); outline-offset:1px; }
.dsh-sb-btn:disabled { opacity:.55; cursor:default; }
.dsh-sb-btn svg { display:block; flex:none; }
.dsh-sb-status { margin-left:5px; min-width:0; max-width:32vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1; }
.dsh-sb-status.is-ok { color:var(--dsw-alias-state-success-primary); }
.dsh-sb-status.is-error { color:var(--dsw-alias-state-error-primary); }
`

    function text(t, key, values) {
      let value
      try {
        value = t(key)
      } catch (error) {
        value = undefined
      }
      if (typeof value !== 'string' || value === key) value = DICT.en[key] || key
      if (!values) return value
      return value.replace(/\{(\w+)\}/g, (match, name) => (
        values[name] === undefined ? match : String(values[name])
      ))
    }

    /** A package leaving the box (export) or entering it (import). */
    function glyph(direction) {
      const upwards = direction === 'export'
      const arrow = upwards ? 'M7 1.6 V8.4' : 'M7 12.4 V5.6'
      const head = upwards ? 'M4.2 4.4 L7 1.5 L9.8 4.4' : 'M4.2 9.6 L7 12.5 L9.8 9.6'
      const tray = upwards ? 'M2.4 9.4 v1.9 h9.2 V9.4' : 'M2.4 4.6 v-1.9 h9.2 v1.9'
      return h('svg', {
        viewBox: '0 0 14 14', width: 13, height: 13, 'aria-hidden': true, focusable: false,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: arrow }),
      h('path', { d: head }),
      h('path', { d: tray }))
    }

    /**
     * Candidate URLs for a Host route. A remote carrier may mount the application under
     * a path prefix, so try the document-relative form first and the origin-root form
     * second instead of assuming where the server is mounted.
     */
    function endpointCandidates(endpoint) {
      const urls = []
      try {
        urls.push(new URL(endpoint, document.baseURI).href)
      } catch (error) {
        // A malformed baseURI falls through to the origin-relative form.
      }
      const rooted = location.origin + '/' + endpoint
      if (!urls.includes(rooted)) urls.push(rooted)
      return urls
    }

    /**
     * Call a Host route and return its `{ ok: true }` payload.
     *
     * Only transport failures and a missing route move on to the next candidate URL: an
     * HTTP error carrying a message is a real answer from the Host and is surfaced.
     */
    async function callHost(endpoint, init) {
      let lastError = null
      for (const url of endpointCandidates(endpoint)) {
        let response
        try {
          response = await fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            ...init,
          })
        } catch (error) {
          lastError = error
          continue
        }
        if (response.status === 404) {
          lastError = new Error('HTTP 404')
          continue
        }
        let payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (!response.ok) {
          const message = payload && payload.error ? String(payload.error) : 'HTTP ' + response.status
          throw new Error(message)
        }
        if (!payload || payload.ok !== true) throw new Error('unexpected reply')
        return payload
      }
      throw lastError || new Error('unreachable')
    }

    function createViews(ctx, t) {
      function useLocaleTick() {
        const [, bump] = React.useReducer((value) => value + 1, 0)
        React.useEffect(() => {
          const locale = ctx.get('locale')
          if (!locale || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(() => bump())
        }, [])
      }

      const describe = (error) => {
        const message = String((error && error.message) || error || '')
        return /service-unavailable/.test(message) ? text(t, 'unavailable') : message
      }

      function SessionBundle(props) {
        useLocaleTick()
        const [status, setStatus] = React.useState(null)
        const [busy, setBusy] = React.useState(null)
        const fileInput = React.useRef(null)

        React.useEffect(() => {
          if (!status || status.kind !== 'ok') return undefined
          const timer = window.setTimeout(() => setStatus(null), STATUS_LIFETIME_MS)
          return () => window.clearTimeout(timer)
        }, [status])

        // The slot hands each entry its own props; read the id here so a session switch
        // can never leave the buttons pointing at the previous conversation.
        const readSessionId = () => {
          if (!props) return null
          if (typeof props.sessionId === 'string' && props.sessionId) return props.sessionId
          if (props.session && typeof props.session.id === 'string') return props.session.id
          if (props.sessionInfo && typeof props.sessionInfo.sessionId === 'string') return props.sessionInfo.sessionId
          return null
        }

        const doExport = async () => {
          if (busy) return
          const sessionId = readSessionId()
          if (!sessionId) {
            setStatus({ kind: 'error', text: text(t, 'noSession') })
            return
          }
          setBusy('export')
          setStatus({ kind: 'pending', text: text(t, 'exporting') })
          try {
            const payload = await callHost(EXPORT_ENDPOINT, {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
            const extra = payload.missingAttachments > 0 ? ' · ' + payload.missingAttachments + ' attachment(s) missing' : ''
            setStatus({ kind: 'ok', text: text(t, 'exported', { name: payload.name }) + extra })
          } catch (error) {
            setStatus({ kind: 'error', text: text(t, 'failed', { message: describe(error) }) })
          } finally {
            setBusy(null)
          }
        }

        const doImport = (event) => {
          const input = event && event.target
          const file = input && input.files && input.files[0]
          if (input) input.value = ''
          if (!file || busy) return
          setBusy('import')
          setStatus({ kind: 'pending', text: text(t, 'importing') })
          Promise.resolve(file.arrayBuffer())
            .then((buffer) => callHost(IMPORT_ENDPOINT, {
              headers: { 'content-type': 'application/octet-stream' },
              body: buffer,
            }))
            .then(async (payload) => {
              const sessions = ctx.get('sessions')
              if (sessions && typeof sessions.refresh === 'function') {
                try {
                  await sessions.refresh()
                } catch (error) {
                  // The workspace record below is the authoritative update.
                }
              }
              const ui = ctx.get('uiWorkspace')
              let opened = false
              if (ui && typeof ui.openSession === 'function') {
                try {
                  await ui.openSession(payload.sessionId)
                  opened = true
                } catch (error) {
                  opened = false
                }
              }
              setStatus({
                kind: 'ok',
                text: opened ? text(t, 'imported') : text(t, 'importedManual', { path: payload.path }),
              })
            })
            .catch((error) => {
              setStatus({ kind: 'error', text: text(t, 'failed', { message: describe(error) }) })
            })
            .finally(() => setBusy(null))
        }

        return h('div', { className: 'dsh-sb' },
          h('style', null, CSS),
          h('button', {
            type: 'button',
            className: 'dsh-sb-btn',
            onClick: doExport,
            disabled: busy === 'export',
            title: text(t, 'exportHint'),
            'aria-label': text(t, 'exportHint'),
          },
          glyph('export'),
          h('span', null, text(t, 'exportLabel'))),
          h('button', {
            type: 'button',
            className: 'dsh-sb-btn',
            onClick: () => {
              const input = fileInput.current
              if (input) input.click()
            },
            disabled: busy === 'import',
            title: text(t, 'importHint'),
            'aria-label': text(t, 'importHint'),
          },
          glyph('import'),
          h('span', null, text(t, 'importLabel'))),
          h('input', {
            ref: fileInput,
            type: 'file',
            accept: '.zip,application/zip,application/x-zip-compressed',
            style: { display: 'none' },
            onChange: doImport,
            tabIndex: -1,
            'aria-hidden': 'true',
          }),
          status
            ? h('span', {
              className: 'dsh-sb-status is-' + status.kind,
              role: 'status',
              title: status.text,
            }, status.text)
            : null)
      }

      return { SessionBundle }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposers = []
          for (const locale of Object.keys(DICT)) {
            try {
              disposers.push(ctx.locale.register(NS, locale, DICT[locale]))
            } catch (error) {
              console.warn('[session-takeout] locale registration skipped for ' + locale, error)
            }
          }
          return () => {
            for (const dispose of disposers) dispose()
          }
        }, 'session-takeout: dictionaries')

        const t = ctx.locale.bind(NS)
        const { SessionBundle } = createViews(ctx, t)

        ctx.effect(() => {
          const dispose = ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'session-takeout',
            order: 42,
            label: () => t('title'),
          }, SessionBundle))
          return () => dispose()
        }, 'session-takeout: composer dock placement')
      },
    }
  },
})
