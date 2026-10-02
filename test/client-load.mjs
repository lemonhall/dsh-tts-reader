/**
 * Offline load test for the browser half.
 *
 * A static Client half is not an ES module for the page: it calls
 * `window.__ModuleLoader__.load({ id, factory })` at load time and the loader hands the
 * factory a `require`. This reproduces that contract in Node, runs the factory, calls `apply`
 * against a fake slot service, and renders the component with a React stub — which is enough
 * to catch a broken wrapper, a wrong slot key, and a value referenced before it is defined.
 */
import { pathToFileURL } from 'node:url'

let failures = 0
function check(label, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// ------------------------------------------------------------------ the page environment

const storage = new Map()
let loaded = null

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (handle) => clearTimeout(handle),
}
globalThis.document = { addEventListener() {}, removeEventListener() {} }
globalThis.fetch = async () => {
  throw new Error('offline')
}

const reactCalls = []
const React = {
  createElement(type, props, ...children) {
    reactCalls.push(type)
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(effect) {
    // Deliberately not run: the effect opens a network poll, and this test is about loading.
    void effect
  },
}

await import(pathToFileURL('E:/development/dsh-tts-reader/lib/client.js').href)

check('registered one loader entry', loaded !== null && typeof loaded.factory === 'function')
check('entry id is the package name', loaded?.id === 'dsh-tts-reader', String(loaded?.id))

const exports = loaded.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require(${specifier})`)
})

check('exports inject', Array.isArray(exports.inject) && exports.inject.join(',') === 'slots', String(exports.inject))
check('exports apply', typeof exports.apply === 'function')

// ------------------------------------------------------------------ slot registration

const registrations = new Map()
const injectKeys = []
const ctx = {
  slots: {
    inject(key, callback) {
      injectKeys.push(key)
      return callback()
    },
    register(options, component) {
      registrations.set(options.id, { options, component })
      return () => {}
    },
  },
}
exports.apply(ctx)

check(
  'injects into the composer row and the message action row',
  injectKeys.join(',') === 'conversation.input.right,conversation.chat.assistant-actions',
  injectKeys.join(','),
)
check('registers two cells', registrations.size === 2, [...registrations.keys()].join(','))

const composer = registrations.get('dsh-tts-reader')
const perMessage = registrations.get('dsh-tts-reader-message')
check('composer cell id is namespaced', Boolean(composer), String(composer?.options?.id))
check('composer cell names its slot', composer?.options?.name === 'conversation.input.right')
check('message cell names the action row', perMessage?.options?.name === 'conversation.chat.assistant-actions')
check('components are functions', typeof composer?.component === 'function' && typeof perMessage?.component === 'function')

// ------------------------------------------------------------------ rendering

/** Expand function elements the way React would, and collect the element types seen. */
function render(element) {
  const seen = []
  ;(function walk(node) {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (typeof node.type === 'function') {
      walk(node.type(node.props))
      return
    }
    seen.push(node.type)
    for (const child of node.children ?? []) walk(child)
  })(element)
  return seen
}

function findButton(element) {
  return (function find(node) {
    if (node === null || node === undefined || typeof node !== 'object') return null
    if (typeof node.type === 'function') return find(node.type(node.props))
    if (node.type === 'button') return node
    for (const child of node.children ?? []) {
      const hit = find(child)
      if (hit) return hit
    }
    return null
  })(element)
}

const composerTree = composer.component({ sessionId: 'session-abc' })
const composerTypes = render(composerTree)
console.log('composer element types:', composerTypes.join(', '))
check('composer renders a style element', composerTypes.includes('style'))
check('composer renders an svg icon', composerTypes.includes('svg'))

const composerButton = findButton(composerTree)
check('composer button is a real control', composerButton?.props?.type === 'button')
check('composer default state is on', composerButton?.props?.['aria-pressed'] === true, String(composerButton?.props?.['aria-pressed']))
check(
  'composer button explains itself',
  typeof composerButton?.props?.title === 'string' && composerButton.props.title.length > 0,
  composerButton?.props?.title,
)

const messageTree = perMessage.component({ sessionId: 'session-abc', messageId: 'message-xyz' })
const messageTypes = render(messageTree)
console.log('message element types:', messageTypes.join(', '))
check('message button renders an svg icon', messageTypes.includes('svg'))

const messageButton = findButton(messageTree)
check('message button is a real control', messageButton?.props?.type === 'button')
check('message button starts idle', messageButton?.props?.['aria-pressed'] === false, String(messageButton?.props?.['aria-pressed']))
check('message button is enabled when it has an id', messageButton?.props?.disabled === false)
check('message button labels the action', messageButton?.props?.title === '朗读这条回答', messageButton?.props?.title)
check('message button is the denser inline size', String(messageButton?.props?.className).includes('is-inline'))

const bareTree = perMessage.component({ sessionId: 'session-abc' })
check('message button disables itself without an id', findButton(bareTree)?.props?.disabled === true)

// ------------------------------------------------------------------ the stored preference

storage.set('dsh-tts-reader.enabled', '0')
loaded = null
await import(`${pathToFileURL('E:/development/dsh-tts-reader/lib/client.js').href}?off=1`)
const offExports = loaded.factory((specifier) => (specifier === 'react' ? React : null))
const offRegistrations = new Map()
offExports.apply({
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => {
      offRegistrations.set(options.id, component)
    },
  },
})
const offButton = findButton(offRegistrations.get('dsh-tts-reader')({ sessionId: 's' }))
check('a stored "off" is honoured', offButton?.props?.['aria-pressed'] === false, String(offButton?.props?.['aria-pressed']))
const offMessageButton = findButton(offRegistrations.get('dsh-tts-reader-message')({ sessionId: 's', messageId: 'm' }))
check(
  'the per-answer button still works while the live channel is off',
  offMessageButton?.props?.disabled === false && offMessageButton?.props?.['aria-pressed'] === false,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
