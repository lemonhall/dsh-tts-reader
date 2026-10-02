/**
 * A zero-dependency client for Microsoft Edge's online "Read Aloud" speech service.
 *
 * The sibling SKILL (`multilingual-tts-audio`) synthesizes through `uv run --with
 * edge-tts python ...`, which costs a package-manager resolution, a Python start-up and a
 * whole-file wait before the first sound. This module keeps the same protocol but drops all
 * three: it speaks the service's WebSocket directly from Node's built-ins, so one short
 * sentence costs one round trip (~0.3–0.8 s) and nothing else.
 *
 * Why hand-rolled instead of the global `WebSocket`: the service refuses the upgrade (HTTP
 * 403) unless the request carries a *current* browser `User-Agent` — verified by isolating the
 * header: Chrome/143 upgrades to 101 while Chrome/130 is refused. The WHATWG WebSocket API,
 * which is all Node exposes, cannot set request headers at all. `node:https` can, so the
 * upgrade and the frame codec live here. Frame compression is never offered, so the server
 * answers uncompressed and the codec stays small.
 *
 * The constants below mirror `edge_tts/constants.py` and `edge_tts/drm.py` (7.2.8). If
 * Microsoft raises the user-agent bar, `CHROMIUM_FULL_VERSION` is the one line to update.
 */

import { createHash, randomUUID } from 'node:crypto'
import { request as httpsRequest } from 'node:https'

/** The voice this plugin reads with unless configured otherwise. */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'

/** Output container the service streams; 48 kbps mono MP3 decodes in every renderer. */
export const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const CHROMIUM_FULL_VERSION = '143.0.3650.75'
const CHROMIUM_MAJOR = CHROMIUM_FULL_VERSION.split('.')[0]
const SEC_MS_GEC_VERSION = `1-${CHROMIUM_FULL_VERSION}`
const WSS_HOST = 'speech.platform.bing.com'
const WSS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1'
const VOICES_PATH = '/consumer/speech/synthesize/readaloud/voices/list'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
/**
 * The service identifies a voice by its long `Name`, not by the `ShortName` every UI and
 * document uses. Sending the short form is not a soft error: the service accepts the upgrade,
 * then resets the socket without a frame. The mapping is learned from the live catalog; this
 * is the shape it takes, kept for the offline fallback.
 */
const VOICE_NAME_PREFIX = 'Microsoft Server Speech Text to Speech Voice'

/**
 * Frame-level trace, off unless `DSH_TTS_DEBUG` is set. The service reports a rejected
 * request by resetting the socket instead of answering, so without a trace the only symptom
 * is a closed connection; this is what turns that into a readable log.
 */
function trace(...parts) {
  if (process.env.DSH_TTS_DEBUG) console.error('[edge-tts]', ...parts)
}
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR}.0.0.0`

const WIN_EPOCH = 11644473600
/** Server clock minus local clock, learned from a refused request's `Date` header. */
let clockSkewSeconds = 0

/**
 * The `Sec-MS-GEC` anti-abuse token: the current time in Windows file time, floored to five
 * minutes, hashed with the trusted client token.
 *
 * The multiplication mirrors `edge-tts`'s floating-point form, but the precision is a
 * non-issue and was checked rather than assumed. The product is always a multiple of
 * `300 * 1e9 / 100` (3e9), which is itself a multiple of 16, so the float64 result is exactly
 * representable and agrees with exact integer arithmetic — verified over 332,640 five-minute
 * buckets spanning three years back and two months forward, with zero disagreements.
 *
 * The token is also not the gate it looks like: `Sec-MS-GEC-Version` accepts an invented value
 * (`1-99.0.0.0` upgraded fine when tested), while a correct token with an outdated
 * `User-Agent` is refused with a bare 403. The user agent is the gate.
 *
 * @returns the uppercase hex SHA-256 digest the service expects.
 */
function secMsGec() {
  let ticks = Math.floor(Date.now() / 1000 + clockSkewSeconds) + WIN_EPOCH
  ticks -= ticks % 300
  ticks *= 1e9 / 100
  return createHash('sha256')
    .update(`${ticks.toFixed(0)}${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

/** `Mon Jun 09 2025 17:00:00 GMT+0000 (Coordinated Universal Time)`, as the service wants it. */
function dateToString(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`
  )
}

/** Characters the service rejects; mirrors `remove_incompatible_characters`. */
function stripIncompatible(text) {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if ((code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31)) out += ' '
    else out += char
  }
  return out
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * The SSML request body the service reads. Prosody is emitted even at neutral values so a
 * configured rate or pitch always changes the request.
 */
function buildSsml({ text, voice, rate, volume, pitch, locale }) {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${locale}'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapeXml(text)}</prosody>` +
    `</voice></speak>`
  )
}

/** Split text so no single request exceeds the service's byte budget, preferring punctuation. */
export function splitForRequests(text, maxBytes = 1800) {
  const encoder = new TextEncoder()
  const sizeOf = (value) => encoder.encode(value).length
  const breaks = ['。', '！', '？', '；', '，', '. ', '! ', '? ', '; ', ', ', ' ']
  const pieces = []
  let rest = text

  while (rest.length > 0) {
    if (sizeOf(rest) <= maxBytes) {
      pieces.push(rest)
      break
    }
    // Largest character prefix that still fits the byte budget. The budget is in bytes but
    // text is indexed in UTF-16 units, so a binary search is the honest way to relate them.
    let low = 1
    let high = rest.length
    let best = 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (sizeOf(rest.slice(0, middle)) <= maxBytes) {
        best = middle
        low = middle + 1
      } else high = middle - 1
    }

    const window = rest.slice(0, best)
    let cut = best
    for (const marker of breaks) {
      const at = window.lastIndexOf(marker)
      if (at > 0) cut = Math.min(cut, at + marker.length)
    }
    if (cut <= 0) cut = best
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }

  return pieces.filter((piece) => piece.trim().length > 0)
}

/**
 * A minimal RFC 6455 client over an already-negotiated socket: masked client frames out,
 * text/binary/ping/close in, with continuation reassembly.
 */
class EdgeSocket {
  #socket
  #buffer = Buffer.alloc(0)
  #fragments = []
  #fragmentOpcode = 0
  #closed = false

  constructor(socket, handlers) {
    this.#socket = socket
    this.handlers = handlers
    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
    socket.on('error', (error) => this.handlers.onError?.(error))
    socket.on('close', () => this.handlers.onClose?.())
  }

  /** Parse every whole frame currently buffered. */
  #drain() {
    for (;;) {
      const frame = this.#readFrame()
      if (frame === null) return
      this.#dispatch(frame)
    }
  }

  /** Read one frame off the head of the buffer, or null when more bytes are still needed. */
  #readFrame() {
    const buffer = this.#buffer
    if (buffer.length < 2) return null

    const fin = (buffer[0] & 0x80) !== 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) !== 0
    let length = buffer[1] & 0x7f
    let offset = 2

    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const big = buffer.readBigUInt64BE(offset)
      if (big > 64n * 1024n * 1024n) throw new Error('edge-tts: refusing an oversized frame')
      length = Number(big)
      offset += 8
    }

    let maskKey = null
    if (masked) {
      if (buffer.length < offset + 4) return null
      maskKey = buffer.subarray(offset, offset + 4)
      offset += 4
    }
    if (buffer.length < offset + length) return null

    let payload = buffer.subarray(offset, offset + length)
    if (maskKey) {
      payload = Buffer.from(payload)
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= maskKey[index % 4]
    }

    this.#buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }

  #dispatch({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      this.close()
      return
    }
    if (opcode === 0x9) {
      this.#write(0xa, payload)
      return
    }
    if (opcode === 0xa) return

    if (opcode === 0x0) this.#fragments.push(payload)
    else {
      this.#fragments = [payload]
      this.#fragmentOpcode = opcode
    }
    if (!fin) return

    const whole = Buffer.concat(this.#fragments)
    this.#fragments = []
    if (this.#fragmentOpcode === 0x1) this.handlers.onText?.(whole.toString('utf8'))
    else if (this.#fragmentOpcode === 0x2) this.handlers.onBinary?.(whole)
  }

  /** Write one masked frame; client frames must be masked or the server drops the connection. */
  #write(opcode, payload) {
    if (this.#closed) return
    const length = payload.length
    const header = []
    header.push(Buffer.from([0x80 | opcode]))

    if (length < 126) header.push(Buffer.from([0x80 | length]))
    else if (length < 65536) {
      const size = Buffer.alloc(3)
      size[0] = 0x80 | 126
      size.writeUInt16BE(length, 1)
      header.push(size)
    } else {
      const size = Buffer.alloc(9)
      size[0] = 0x80 | 127
      size.writeBigUInt64BE(BigInt(length), 1)
      header.push(size)
    }

    const maskKey = Buffer.from(randomUUID().replace(/-/g, ''), 'hex').subarray(0, 4)
    header.push(maskKey)
    const masked = Buffer.from(payload)
    for (let index = 0; index < masked.length; index += 1) masked[index] ^= maskKey[index % 4]
    header.push(masked)

    try {
      this.#socket.write(Buffer.concat(header))
    } catch {
      /* the peer went away; the close handler settles the promise */
    }
  }

  /** Send one text frame. */
  sendText(text) {
    this.#write(0x1, Buffer.from(text, 'utf8'))
  }

  /** Send a close frame and destroy the socket. */
  close() {
    if (this.#closed) return
    this.#closed = true
    this.#write(0x8, Buffer.alloc(0))
    try {
      this.#socket.destroy()
    } catch {
      /* already gone */
    }
  }
}

/** Cached `ShortName -> Name` mapping taken from the live catalog. */
const voiceNames = { at: 0, byKey: new Map() }
const VOICE_NAME_TTL_MS = 6 * 60 * 60 * 1000

/** The long service name a short name implies, without asking the service. */
export function derivedVoiceName(shortName) {
  const cut = shortName.lastIndexOf('-')
  if (cut <= 0) return shortName
  return `${VOICE_NAME_PREFIX} (${shortName.slice(0, cut)}, ${shortName.slice(cut + 1)})`
}

/**
 * Translate the voice name a human would write (`zh-CN-XiaoyiNeural`) into the one the
 * service accepts (`Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoyiNeural)`).
 *
 * The catalog is the authority — a short name is not always `locale-name`, and dialects such
 * as `zh-CN-liaoning-XiaobeiNeural` prove it — so it is fetched once per process and cached.
 * The derived form keeps synthesis working when the catalog cannot be reached; it agrees with
 * the catalog for every voice checked.
 *
 * @param voice - a `ShortName`, or a `Name` that is already long.
 * @param options.signal - abort the catalog fetch.
 * @returns the name to put in the SSML `voice` element.
 */
export async function resolveVoiceName(voice, { signal } = {}) {
  const requested = String(voice ?? '').trim() || DEFAULT_VOICE
  if (requested.startsWith(VOICE_NAME_PREFIX)) return requested

  const fresh = Date.now() - voiceNames.at < VOICE_NAME_TTL_MS && voiceNames.byKey.size > 0
  if (!fresh) {
    try {
      const voices = await listVoices({ signal })
      const byKey = new Map()
      for (const entry of voices) {
        if (entry?.ShortName && entry?.Name) byKey.set(entry.ShortName, entry.Name)
      }
      voiceNames.byKey = byKey
      voiceNames.at = Date.now()
    } catch {
      /* the derived name below is the fallback */
    }
  }

  return voiceNames.byKey.get(requested) ?? derivedVoiceName(requested)
}

/** Open the upgrade and resolve once the handshake is 101. */
function openSocket(url) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: WSS_HOST,
        port: 443,
        path: url,
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomUUID().replace(/-/g, '') + 'AA==',
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Origin: ORIGIN,
          Cookie: `muid=${randomUUID().replace(/-/g, '').toUpperCase()};`,
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': USER_AGENT,
        },
      },
      () => {},
    )

    request.on('upgrade', (response, socket) => {
      if (response.statusCode !== 101) {
        socket.destroy()
        reject(new Error(`edge-tts: websocket upgrade answered ${response.statusCode}`))
        return
      }
      resolve(socket)
    })

    request.on('response', (response) => {
      const serverDate = Date.parse(response.headers.date ?? '')
      response.resume()
      const error = new Error(`edge-tts: websocket upgrade refused (HTTP ${response.statusCode})`)
      error.statusCode = response.statusCode
      // The service rejects tokens produced from a clock too far off its own; remember the
      // offset so the caller's single retry lands inside the window.
      if (Number.isFinite(serverDate)) {
        const skew = serverDate / 1000 - Date.now() / 1000
        if (Math.abs(skew) > 30) clockSkewSeconds += skew
      }
      reject(error)
    })

    request.on('error', (error) => reject(error))
    request.end()
  })
}

/**
 * Synthesize one phrase with the service's Read Aloud endpoint.
 *
 * @param options.text - the phrase to speak; caller keeps it within {@link splitForRequests}.
 * @param options.voice - a `ShortName` from {@link listVoices}; resolved to the long form here.
 * @param options.locale - SSML `xml:lang`. The service accepts the default for every voice
 *   tried, including Chinese ones, so it stays fixed unless a caller overrides it.
 * @param options.timeoutMs - whole-call ceiling.
 * @param options.signal - abort the call and the socket.
 * @returns the complete MP3 bytes.
 */
export async function synthesizeMp3({
  text,
  voice = DEFAULT_VOICE,
  rate = '+0%',
  volume = '+0%',
  pitch = '+0Hz',
  locale = 'en-US',
  timeoutMs = 45_000,
  signal,
} = {}) {
  const phrase = stripIncompatible(text).trim()
  if (phrase.length === 0) return Buffer.alloc(0)
  if (signal?.aborted) throw new Error('edge-tts: aborted before the request')

  const voiceName = await resolveVoiceName(voice, { signal })
  if (signal?.aborted) throw new Error('edge-tts: aborted before the request')

  const requestId = randomUUID().replace(/-/g, '')
  const query =
    `${WSS_PATH}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&ConnectionId=${requestId}` +
    `&Sec-MS-GEC=${secMsGec()}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

  const socket = await openSocket(query)

  return await new Promise((resolve, reject) => {
    const chunks = []
    const finished = { settled: false }

    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try {
        handle?.close()
      } catch {
        /* already closed */
      }
    }
    const settle = (error) => {
      if (finished.settled) return
      finished.settled = true
      cleanup()
      if (error) reject(error)
      else resolve(Buffer.concat(chunks))
    }
    const onAbort = () => settle(new Error('edge-tts: aborted'))
    const timer = setTimeout(() => settle(new Error('edge-tts: timed out')), timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })

    const handle = new EdgeSocket(socket, {
      onText: (payload) => {
        const separator = payload.indexOf('\r\n\r\n')
        const head = separator >= 0 ? payload.slice(0, separator) : payload
        const path = /Path:([^\r\n]+)/.exec(head)?.[1]
        trace('text frame', path, head)
        if (path === 'turn.end') settle()
        // `response` and `turn.start` carry no audio and need no handling.
      },
      onBinary: (payload) => {
        // The frame is `[2-byte big-endian header length][ASCII header][MP3 bytes]`. There is
        // no blank line between header and payload — searching for one finds nothing, because
        // the frame length already delimits the header. The payload therefore starts exactly
        // `headerLength + 2` bytes in.
        if (payload.length < 2) return
        const headerLength = payload.readUInt16BE(0)
        const start = headerLength + 2
        trace('binary frame', payload.length, 'bytes, headerLength=', headerLength, 'start=', start)
        if (start >= payload.length) return
        const head = payload.subarray(0, start).toString('latin1')
        if (!/Path:\s*audio\b/.test(head)) return
        const audio = payload.subarray(start)
        if (audio.length > 0) chunks.push(audio)
      },
      onError: (error) => {
        trace('socket error', error.message)
        settle(error)
      },
      // A close before `turn.end` means the audio was cut short, so it is reported as a
      // failure and retried rather than returned as a truncated clip.
      onClose: () => {
        trace('socket closed, chunks=', chunks.length, 'settled=', finished.settled)
        settle(new Error('edge-tts: socket closed before turn.end'))
      },
    })

    try {
      handle.sendText(
        `X-Timestamp:${dateToString()}\r\n` +
          'Content-Type:application/json; charset=utf-8\r\n' +
          'Path:speech.config\r\n\r\n' +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: OUTPUT_FORMAT,
                },
              },
            },
          }),
      )
      handle.sendText(
        `X-RequestId:${requestId}\r\n` +
          'Content-Type:application/ssml+xml\r\n' +
          `X-Timestamp:${dateToString()}Z\r\n` +
          'Path:ssml\r\n\r\n' +
          buildSsml({ text: phrase, voice: voiceName, rate, volume, pitch, locale }),
      )
    } catch (error) {
      settle(error)
    }
  })
}

/** Synthesize with one retry, which is what absorbs a rotated token or a clock-skew refusal. */
export async function synthesizeMp3WithRetry(options) {
  try {
    return await synthesizeMp3(options)
  } catch (error) {
    if (options?.signal?.aborted) throw error
    const message = String(error?.message ?? '')
    const transient =
      error?.statusCode === 403 ||
      /refused|timed out|no audio|closed before|ECONNRESET|socket hang up|EPIPE/i.test(message)
    if (!transient) throw error
    return await synthesizeMp3(options)
  }
}

/**
 * The service's live voice catalog. The SKILL's rule applies here too: never guess a voice
 * name, ask for the current list.
 *
 * @param options.localePrefix - keep only voices whose `Locale` starts with this (e.g. `zh-`).
 * @param options.timeoutMs - request ceiling.
 * @returns voice descriptors as the service reports them.
 */
export async function listVoices({ localePrefix = '', timeoutMs = 20_000, signal } = {}) {
  const body = await new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        host: WSS_HOST,
        port: 443,
        path: `${VOICES_PATH}?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`,
        method: 'GET',
        headers: {
          Authority: WSS_HOST,
          'Sec-CH-UA': `" Not;A Brand";v="99", "Microsoft Edge";v="${CHROMIUM_MAJOR}", "Chromium";v="${CHROMIUM_MAJOR}"`,
          'Sec-CH-UA-Mobile': '?0',
          Accept: '*/*',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'Accept-Encoding': 'gzip, deflate, br, zstd',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': USER_AGENT,
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`edge-tts: voice list answered ${response.statusCode}`))
          return
        }
        const parts = []
        response.on('data', (chunk) => parts.push(chunk))
        response.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
      },
    )
    const timer = setTimeout(() => {
      request.destroy()
      reject(new Error('edge-tts: voice list timed out'))
    }, timeoutMs)
    const onAbort = () => {
      request.destroy()
      reject(new Error('edge-tts: aborted'))
    }
    request.on('close', () => clearTimeout(timer))
    signal?.addEventListener('abort', onAbort, { once: true })
    request.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    request.end()
  })

  const voices = JSON.parse(body)
  return localePrefix ? voices.filter((voice) => String(voice.Locale).startsWith(localePrefix)) : voices
}
