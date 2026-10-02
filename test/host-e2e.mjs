/**
 * End-to-end test of the host half without installing it.
 *
 * A fake Cordis context captures the event listeners and the route the plugin registers, then
 * the test plays the part of the harness: it streams a model answer through the listener and
 * calls the route the way the browser half would. Synthesis is the real thing, so a passing
 * run proves the whole host path — event shape, phrase cutting, Edge TTS, the fence, and the
 * cursor contract.
 */
import { apply } from '../lib/index.js'

let failures = 0
function check(label, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// ------------------------------------------------------------------ a fake Cordis context

const listeners = new Map()
const routes = new Map()

/**
 * A session log holding one finished answer, as `Session.snapshotEvents()` would return it.
 * The text lives in the compact stream, which is the shape the host actually reads.
 */
const SAVED_MESSAGE_ID = 'message-saved-1'
const SAVED_TEXT = '这是更早之前的一条回答。它也应该能被点开朗读。'
const fakeSession = {
  snapshotEvents: () => [
    { type: 'turn/start', seq: 1, data: { turn: 0 } },
    {
      type: 'assistant/message',
      seq: 2,
      data: {
        turn: 0,
        step: 0,
        message: { id: SAVED_MESSAGE_ID, role: 'assistant', content: [{ type: 'text', text: SAVED_TEXT }] },
        stream: [
          { type: 'reasoning-chunks', time0: 0, index: 0, dt: [], texts: ['不该念的思考'] },
          { type: 'text-chunks', time0: 1, index: 1, dt: [], texts: [SAVED_TEXT] },
        ],
      },
    },
  ],
}

const ctx = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
    return () => {}
  },
  get(name) {
    if (name !== 'sessions') return undefined
    return { get: (id) => (id === 'session-under-test' ? fakeSession : undefined) }
  },
  inject(deps, callback) {
    check('host injects only webServer', deps.length === 1 && deps[0] === 'webServer', deps.join(','))
    callback({
      webServer: {
        register(route) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
      connection: { requestRejection: () => 403 },
    })
  },
}

apply(ctx, undefined)

check('listens on agent/assistant-stream', listeners.has('agent/assistant-stream'))
check('listens on agent/disposed', listeners.has('agent/disposed'))
check(
  'registered both read routes',
  routes.has('/dsh-tts/tail') && routes.has('/dsh-tts/message'),
  [...routes.keys()].join(','),
)

// ------------------------------------------------------------------ drive a model answer

const stream = listeners.get('agent/assistant-stream')[0]
const agent = { id: 'session-under-test' }

function frames(text, chunkSize = 9) {
  for (let index = 0; index < text.length; index += chunkSize) {
    stream({ agent, frame: { type: 'chunk', chunk: { type: 'text-delta', text: text.slice(index, index + chunkSize) } } })
  }
  stream({ agent, frame: { type: 'end' } })
}

frames(
  '好的，我来检查一下这个配置。**第一步**是先读 `settings.json`，里面有：\n' +
    '```json\n{"hidden": "这段代码不该被念出来"}\n```\n' +
    '然后我把它改成新的值。请问这样可以吗？',
)
// Reasoning and tool calls must never be spoken.
stream({ agent, frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '这是思考过程，不该被朗读。' } } })
stream({ agent, frame: { type: 'chunk', chunk: { type: 'tool-call-delta', id: 't1', name: 'read', argumentsDelta: '{"path":"x"}' } } })

// ------------------------------------------------------------------ call the route

function callRoute(url, headers = {}, path = '/dsh-tts/tail') {
  return new Promise((resolve) => {
    const chunks = []
    let status = 0
    const res = {
      writeHead(code) {
        status = code
      },
      end(body) {
        if (body !== undefined) chunks.push(Buffer.from(body))
        resolve({ status, body: Buffer.concat(chunks).toString('utf8') })
      },
      on() {},
      removeListener() {},
    }
    routes.get(path).handler(
      { method: 'GET', url, headers: { host: 'dsh-app', origin: 'dsh-app://app', ...headers } },
      res,
    )
  })
}

const handshake = JSON.parse((await callRoute('/dsh-tts/tail?session=session-under-test&since=-1')).body)
check('handshake reports a cursor', handshake.ok === true && handshake.next > 0, JSON.stringify(handshake).slice(0, 120))
check('handshake carries the voice', handshake.voice === 'zh-CN-XiaoyiNeural', String(handshake.voice))
check('handshake returns no audio', handshake.items.length === 0)

// A listener that just opened starts at the handshake cursor, so ask from there minus the
// phrases already queued: since=0 is "everything so far", which is what a fresh page does.
const first = JSON.parse((await callRoute('/dsh-tts/tail?session=session-under-test&since=0')).body)
check('first pull returns one phrase', first.items.length === 1, JSON.stringify(first.items.map((i) => i.text)))
check('first pull did synthesize audio', typeof first.items[0].audio === 'string' && first.items[0].audio.length > 1000)
if (first.items[0]?.audio) {
  const mp3 = Buffer.from(first.items[0].audio, 'base64')
  check('audio is a real MP3 frame', mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0, `${mp3.length} bytes, ${mp3[0].toString(16)}${mp3[1].toString(16)}`)
}

// ------------------------------------------------------------------ drain and inspect

const spoken = [...first.items.map((item) => item.text)]
let cursor = first.next
for (let round = 0; round < 12; round += 1) {
  const page = JSON.parse((await callRoute(`/dsh-tts/tail?session=session-under-test&since=${cursor}`)).body)
  if (page.items.length === 0) break
  for (const item of page.items) spoken.push(item.text)
  cursor = page.next
}

const transcript = spoken.join(' ~ ')
console.log('spoken:', transcript)
check('spoke the readable prose', transcript.includes('我来检查一下这个配置'))
check('stripped the fenced code block', !transcript.includes('hidden'), transcript)
check('inlined the code span as words', transcript.includes('settings.json'), transcript)
check('never spoke reasoning', !transcript.includes('思考过程'))
check('never spoke tool arguments', !transcript.includes('path'))
check('drained to the end', (await callRoute(`/dsh-tts/tail?session=session-under-test&since=${cursor}`)).body.includes('"items":[]'))
check('every phrase got audio', spoken.length >= 4, `${spoken.length} phrases`)

// ------------------------------------------------------------------ the per-answer route

const messageUrl = (since) =>
  `/dsh-tts/message?session=session-under-test&id=${SAVED_MESSAGE_ID}&since=${since}`
const messageRoute = '/dsh-tts/message'

const messageHandshake = JSON.parse((await callRoute(messageUrl(-1), {}, messageRoute)).body)
check('message handshake reports a cursor', messageHandshake.ok === true && messageHandshake.next > 0, JSON.stringify(messageHandshake))
check('message handshake returns no audio', messageHandshake.items.length === 0)

const messageFirst = JSON.parse((await callRoute(messageUrl(0), {}, messageRoute)).body)
check('message pull returns one phrase', messageFirst.items.length === 1, JSON.stringify(messageFirst.items.map((i) => i.text)))
check('message pull did synthesize audio', typeof messageFirst.items[0]?.audio === 'string' && messageFirst.items[0].audio.length > 1000)
check('message pull is not yet done', messageFirst.done === false, String(messageFirst.done))

const messageSpoken = [messageFirst.items[0].text]
let messageCursor = messageFirst.next
let messageDone = false
for (let round = 0; round < 8; round += 1) {
  const page = JSON.parse((await callRoute(messageUrl(messageCursor), {}, messageRoute)).body)
  for (const item of page.items) messageSpoken.push(item.text)
  messageCursor = page.next
  if (page.done === true) {
    messageDone = true
    break
  }
}
const savedTranscript = messageSpoken.join(' ~ ')
console.log('per-answer spoken:', savedTranscript)
check('the whole saved answer is read', savedTranscript.includes('这是更早之前的一条回答') && savedTranscript.includes('它也应该能被点开朗读'))
check('reasoning is not read from the log', !savedTranscript.includes('不该念的思考'))
check('the queue reports completion', messageDone)

const unknownMessage = await callRoute(
  '/dsh-tts/message?session=session-under-test&id=no-such-message&since=0',
  {},
  messageRoute,
)
check('an unresolvable message is a 404', unknownMessage.status === 404, String(unknownMessage.status))
const unknownSession = await callRoute('/dsh-tts/message?session=nope&id=x&since=0', {}, messageRoute)
check('an unknown session is a 404', unknownSession.status === 404, String(unknownSession.status))
const missingId = await callRoute('/dsh-tts/message?session=session-under-test&since=0', {}, messageRoute)
check('a missing id is a 400', missingId.status === 400, String(missingId.status))
const crossSiteMessage = await callRoute(messageUrl(0), { 'sec-fetch-site': 'cross-site' }, messageRoute)
check('the per-answer route is fenced too', crossSiteMessage.status === 403, String(crossSiteMessage.status))

// ------------------------------------------------------------------ fence behaviour

const noSession = await callRoute('/dsh-tts/tail?since=0')
check('a missing session is rejected', noSession.status === 400, String(noSession.status))
const crossSite = await callRoute('/dsh-tts/tail?session=x&since=0', { 'sec-fetch-site': 'cross-site' })
check('a cross-site request is refused', crossSite.status === 403, String(crossSite.status))
const foreignHost = await callRoute('/dsh-tts/tail?session=x&since=0', {
  host: 'evil.example.com',
  origin: 'https://evil.example.com',
})
check('a foreign origin is refused', foreignHost.status === 403, String(foreignHost.status))
const post = await new Promise((resolve) => {
  const res = { writeHead: (c) => resolve(c), end: () => {}, on() {}, removeListener() {} }
  routes.get('/dsh-tts/tail').handler({ method: 'POST', url: '/dsh-tts/tail?session=x', headers: { host: 'dsh-app' } }, res)
})
check('a POST is refused', post === 405, String(post))

// ------------------------------------------------------------------ dispose

check('route is live before dispose', routes.has('/dsh-tts/tail'))
for (const dispose of listeners.get('dispose') ?? []) dispose()
check('dispose unregisters the route', !routes.has('/dsh-tts/tail'), [...routes.keys()].join(','))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
