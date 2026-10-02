/**
 * Host half of dsh-tts-reader: it watches the model's own streamed answer, cuts it into
 * phrases, and serves the spoken audio to the page.
 *
 * Why the host and not the browser: the speech service refuses a WebSocket upgrade unless the
 * request carries a browser `User-Agent`, and no browser `WebSocket` can set request headers.
 * Node can, so synthesis lives here.
 *
 * Why it listens to `agent/assistant-stream` instead of reading the rendered page: that event
 * is the model's text as it arrives, before any of it is on screen. Phrases therefore become
 * speakable while the answer is still being written, which is what makes this feel immediate
 * rather than like a post-processing step.
 *
 * Two read-only routes publish that work; both are cursor-based, and both synthesize only on
 * demand, so a session nobody is listening to costs nothing:
 *
 *   GET /dsh-tts/tail?session=<id>&since=<seq>&limit=<n>
 *     The live answer as it is written, one queue per session.
 *
 *   GET /dsh-tts/message?session=<id>&id=<messageId>&since=<seq>&limit=<n>
 *     One finished answer, on demand, for the button in a message's action row. The text comes
 *     from the session log, so this works for the whole visible history and not only for
 *     answers that arrived after the plugin loaded.
 *
 * Both routes are additive: the live channel keeps its own queue and its own cursor, so asking
 * for one finished answer never disturbs what is being read as it is written.
 */

import { DEFAULT_VOICE, splitForRequests, synthesizeMp3WithRetry } from './edge-tts.js'
import { createFeedStore } from './feed.js'

/** The routes this half serves. */
const TAIL_ROUTE = '/dsh-tts/tail'
const MESSAGE_ROUTE = '/dsh-tts/message'

/** Tunables, overridable from the profile patch's `config` block. */
const DEFAULTS = {
  enabled: true,
  voice: DEFAULT_VOICE,
  rate: '+0%',
  volume: '+0%',
  pitch: '+0Hz',
  maxPerRequest: 3,
}

/** Separator between session id and message id in the on-demand queue key. */
const KEY_SEPARATOR = '\u0000'

/** Hosts that count as "this machine / this app" without asking the host fence. */
const LOCAL_HOSTS = new Set(['dsh-app', 'app', 'localhost', '127.0.0.1', '::1', '[::1]'])

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return false
  if (LOCAL_HOSTS.has(host)) return true
  if (host.endsWith('.localhost')) return true
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
}

/**
 * Local checks: GET/HEAD only, no cross-site fetch, and an Origin that belongs to this app.
 * This mirrors the reviewed fence in `dsh-lucy-companion` and `dsh-whale-widget`.
 *
 * @param req - the incoming request.
 * @returns a status code when the request must be refused, otherwise null.
 */
function localRejection(req) {
  const headers = (req && req.headers) || {}
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return 405
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin && origin !== 'null') {
    try {
      const parsed = new URL(origin)
      // the app's own custom scheme, or a same-host http origin
      if (parsed.protocol !== 'dsh-app:') {
        const host = new URL('http://' + String(headers.host || '')).host.toLowerCase()
        if (parsed.host.toLowerCase() !== host) return 403
      }
    } catch {
      return 403
    }
  }
  return null
}

/** Spoken text of one compact assistant stream: the visible answer, never reasoning or calls. */
function textsFromStream(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (!record || typeof record !== 'object') continue
    if (record.type === 'text-chunks' && Array.isArray(record.texts)) {
      parts.push(record.texts.join(''))
    } else if (record.type === 'chunk' && record.chunk?.type === 'text-delta' && typeof record.chunk.text === 'string') {
      parts.push(record.chunk.text)
    }
  }
  return parts.join('')
}

/** Fallback for a settlement whose compact stream is absent: the message's own text blocks. */
function textFromMessage(message) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** The speakable text of one `assistant/message` event, or an empty string. */
function messageTextOf(event) {
  if (!event || event.type !== 'assistant/message' || !event.data) return ''
  const fromStream = textsFromStream(event.data.stream)
  return fromStream.trim().length > 0 ? fromStream : textFromMessage(event.data.message)
}

/**
 * Find one finished answer by its durable message id.
 *
 * The session store holds every live session and its log, so a message stays readable for as
 * long as its session is open — which is exactly when its action row is on screen. A session
 * that is no longer live cannot serve its history this way, and neither can a session that was
 * never live in this process.
 *
 * @param ctx - the plugin context, used to reach the session store optionally.
 * @param sessionId - the session the message belongs to.
 * @param messageId - the durable message id the action row carries.
 * @returns the speakable text, or undefined when this process cannot resolve it.
 */
function lookupMessageText(ctx, sessionId, messageId) {
  let sessions
  try {
    sessions = ctx.get('sessions')
  } catch {
    sessions = undefined
  }
  if (!sessions || typeof sessions.get !== 'function') return undefined

  let session
  try {
    session = sessions.get(sessionId)
  } catch {
    session = undefined
  }
  if (!session) return undefined

  let events = []
  try {
    events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  } catch {
    events = []
  }

  // Newest first: the button is nearly always used on a recent answer.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    if (event.data?.message?.id !== messageId) continue
    const text = messageTextOf(event)
    if (text.trim().length > 0) return text
  }
  return undefined
}

/**
 * Host plugin body.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - this row's `config` block from the profile patch.
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }

  /** Serialize pulls per queue so two polls cannot synthesize the same phrase twice. */
  const inFlight = new Map()

  /**
   * Build one queue store. Live answers and on-demand messages use the same machinery; only
   * how they are seeded differs.
   *
   * @returns the store.
   */
  function createStore() {
    return createFeedStore({
      maxPerRequest: settings.maxPerRequest,
      log: (message) => console.warn(`[dsh-tts] ${message}`),
      synthesize: async ({ text, signal }) => {
        // `clampPhrase` already bounds a phrase, so this normally yields a single piece; it is
        // the honest guard against a caller feeding an unbounded string.
        const parts = []
        for (const piece of splitForRequests(text, 1800)) {
          parts.push(
            await synthesizeMp3WithRetry({
              text: piece,
              voice: settings.voice,
              rate: settings.rate,
              volume: settings.volume,
              pitch: settings.pitch,
              signal,
            }),
          )
        }
        return Buffer.concat(parts)
      },
    })
  }

  const live = createStore()
  const spoken = createStore()
  /** Messages whose text has already been queued; seeding twice would duplicate the answer. */
  const seeded = new Set()

  /** Run `tail` for one queue, one pull at a time. */
  function pull(store, key, since, limit, signal) {
    const previous = inFlight.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => store.tail(key, since, limit, signal))
    inFlight.set(key, run)
    return run.finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key)
    })
  }

  // --- the model's answer, as it is written ------------------------------------------
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (!settings.enabled || !frame || typeof frame !== 'object') return
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return

    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      // `text-delta` is the visible answer. Reasoning and tool-call fragments are not spoken.
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        live.push(sessionId, chunk.text)
      }
      return
    }
    if (frame.type === 'end') live.flush(sessionId)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    if (typeof agent?.id !== 'string') return
    live.forget(agent.id)
    // Forget which of this session's answers were queued; the queues go with the session.
    const prefix = `${agent.id}${KEY_SEPARATOR}`
    for (const key of seeded) {
      if (key.startsWith(prefix)) {
        seeded.delete(key)
        spoken.forget(key)
      }
    }
  })

  // --- serving it to the page ---------------------------------------------------------
  ctx.inject(['webServer'], (scoped) => {
    const disposers = []

    /** Wrap a handler with the fence and a JSON reply helper. */
    function guarded(handler) {
      return async (req, res) => {
        const send = (code, body) => {
          try {
            const text = JSON.stringify(body)
            res.writeHead(code, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(text),
            })
            res.end(text)
          } catch {
            /* already closed */
          }
        }

        const local = localRejection(req)
        if (local !== null) return send(local, { ok: false, error: 'refused' })

        let hostname = ''
        try {
          hostname = new URL('http://' + String((req.headers || {}).host || '')).hostname
        } catch {
          hostname = ''
        }
        if (!isLocalHost(hostname)) {
          try {
            const fence =
              scoped.connection && typeof scoped.connection.requestRejection === 'function'
                ? scoped.connection.requestRejection(req)
                : 403
            if (fence) return send(typeof fence === 'number' ? fence : 403, { ok: false, error: 'refused' })
          } catch {
            return send(403, { ok: false, error: 'refused' })
          }
        }

        let params
        try {
          params = new URL(String(req.url || '/'), 'http://localhost').searchParams
        } catch {
          return send(400, { ok: false, error: 'bad request' })
        }

        // The client aborts a poll it no longer needs; stop paying for synthesis with it.
        const controller = new AbortController()
        const onClose = () => controller.abort()
        res.on('close', onClose)
        try {
          return await handler({ params, send, signal: controller.signal })
        } catch (error) {
          return send(500, { ok: false, error: String(error?.message ?? error) })
        } finally {
          res.removeListener('close', onClose)
        }
      }
    }

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: TAIL_ROUTE,
        handler: guarded(async ({ params, send, signal }) => {
          const sessionId = params.get('session') || ''
          if (sessionId.length === 0) return send(400, { ok: false, error: 'missing session' })
          if (!settings.enabled) {
            return send(200, { ok: true, enabled: false, voice: settings.voice, next: 0, items: [] })
          }
          const since = Number(params.get('since') ?? '-1')
          const limit = Number(params.get('limit') ?? settings.maxPerRequest)
          const result = await pull(live, sessionId, since, limit, signal)
          send(200, { ok: true, enabled: true, voice: settings.voice, ...result })
        }),
      }),
    )

    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: MESSAGE_ROUTE,
        handler: guarded(async ({ params, send, signal }) => {
          const sessionId = params.get('session') || ''
          const messageId = params.get('id') || ''
          if (sessionId.length === 0 || messageId.length === 0) {
            return send(400, { ok: false, error: 'missing session or id' })
          }

          const key = `${sessionId}${KEY_SEPARATOR}${messageId}`
          if (!seeded.has(key)) {
            const text = lookupMessageText(ctx, sessionId, messageId)
            if (text === undefined) {
              return send(404, { ok: false, error: 'message-not-found' })
            }
            // Seed the queue once; the set above keeps a later poll from duplicating it.
            seeded.add(key)
            spoken.push(key, text)
            spoken.flush(key)
          }

          const end = spoken.cursor(key)
          const since = Number(params.get('since') ?? '-1')
          if (since < 0) return send(200, { ok: true, voice: settings.voice, next: end, done: false, items: [] })

          const limit = Number(params.get('limit') ?? settings.maxPerRequest)
          const result = await pull(spoken, key, since, limit, signal)
          send(200, { ok: true, voice: settings.voice, ...result, done: result.next >= end })
        }),
      }),
    )

    ctx.on('dispose', () => {
      for (const fn of disposers) {
        try {
          fn()
        } catch {
          /* gone */
        }
      }
    })
  })
}

export { DEFAULTS, lookupMessageText, messageTextOf }
