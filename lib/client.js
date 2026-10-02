/**
 * Browser half of dsh-tts-reader.
 *
 * It does two things: it keeps a speaker toggle in the composer's tool row, and it plays the
 * phrases the host half synthesizes.
 *
 * Playback is Web Audio rather than `<audio>` chained by `ended`, because phrases are handed
 * over one at a time and an element swap leaves an audible gap between them. Decoding each
 * phrase and scheduling it at the previous one's end time makes the answer run continuously.
 *
 * Polling is what drives synthesis: nothing is spoken until this half asks, so a session with
 * no listener costs nothing. The cursor comes from the handshake (`since=-1`), which means a
 * page reload resumes at the next phrase instead of replaying everything said since launch.
 *
 * Module shape mirrors `@deepseek-ai/dsh-client-ui-brand-official`: the loader wraps the
 * factory, which exports `apply` and `inject`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-tts-reader',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const ROUTE = '/dsh-tts/tail'
    const MESSAGE_ROUTE = '/dsh-tts/message'
    /** How often to ask for the next phrase while enabled. */
    const POLL_MS = 400
    /** Backoff after repeated transport failures. */
    const ERROR_BACKOFF_MS = 4000
    const STORAGE_KEY = 'dsh-tts-reader.enabled'

    // ---------------------------------------------------------------- observable state

    const listeners = new Set()
    let snapshot = {
      enabled: readStoredEnabled(),
      speaking: false,
      sessionId: null,
      voice: '',
      error: '',
      /** Queue key of the finished answer being read on demand, or null. */
      manualKey: null,
    }

    function readStoredEnabled() {
      try {
        // Default ON: the whole point of the plugin is that the answer is read without asking.
        return window.localStorage.getItem(STORAGE_KEY) !== '0'
      } catch {
        return true
      }
    }

    function emit(patch) {
      let changed = false
      for (const key of Object.keys(patch)) {
        if (snapshot[key] !== patch[key]) changed = true
      }
      if (!changed) return
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) {
        try {
          listener()
        } catch {
          /* a subscriber must not break playback */
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    // ---------------------------------------------------------------- audio

    let audioContext = null
    let output = null
    /** Wall-clock time on the audio clock where the next phrase may start. */
    let nextStartAt = 0
    const liveSources = new Set()
    let armedUnlock = false

    function ensureContext() {
      if (audioContext !== null) return audioContext
      const Ctor = window.AudioContext || window.webkitAudioContext
      if (typeof Ctor !== 'function') return null
      try {
        audioContext = new Ctor()
        output = audioContext.createGain()
        output.gain.value = 1
        output.connect(audioContext.destination)
      } catch {
        audioContext = null
      }
      return audioContext
    }

    /**
     * Make sure the context is allowed to make sound. Chromium starts it suspended until the
     * page has seen a gesture; if that is still pending, the first gesture anywhere finishes
     * the job so nothing queued is lost.
     *
     * @returns whether audio can be scheduled right now.
     */
    async function unlockAudio() {
      const context = ensureContext()
      if (context === null) return false
      if (context.state === 'running') return true
      try {
        await context.resume()
      } catch {
        /* fall through to the gesture */
      }
      if (context.state === 'running') return true

      if (armedUnlock) return false
      armedUnlock = true
      await new Promise((resolve) => {
        const finish = () => {
          document.removeEventListener('pointerdown', finish, true)
          document.removeEventListener('keydown', finish, true)
          armedUnlock = false
          context.resume().then(resolve, resolve)
        }
        document.addEventListener('pointerdown', finish, true)
        document.addEventListener('keydown', finish, true)
      })
      return context.state === 'running'
    }

    function base64ToArrayBuffer(base64) {
      const binary = window.atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes.buffer
    }

    /**
     * Decode one phrase and schedule it directly after whatever is already queued.
     *
     * @param item - `{ seq, text, audio }` as the host served it.
     * @returns whether it was scheduled.
     */
    async function playItem(item) {
      if (typeof item.audio !== 'string' || item.audio.length === 0) return true
      const context = ensureContext()
      if (context === null) return true
      if (!(await unlockAudio())) return false

      let buffer
      try {
        buffer = await context.decodeAudioData(base64ToArrayBuffer(item.audio))
      } catch {
        return true // an undecodable phrase is skipped rather than retried forever
      }

      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(output)
      const startAt = Math.max(context.currentTime + 0.02, nextStartAt)
      source.start(startAt)
      nextStartAt = startAt + buffer.duration
      liveSources.add(source)
      emit({ speaking: true })
      source.onended = () => {
        liveSources.delete(source)
        if (liveSources.size === 0) emit({ speaking: false })
      }
      return true
    }

    function stopSpeaking() {
      for (const source of liveSources) {
        try {
          source.stop()
        } catch {
          /* already stopped */
        }
      }
      liveSources.clear()
      nextStartAt = 0
      emit({ speaking: false })
    }

    // ---------------------------------------------------------------- polling

    let sessionId = null
    /** Last sequence number already scheduled; -1 asks the host for a fresh start. */
    let cursor = -1
    let timer = null
    let failures = 0
    let polling = false

    function schedule(delay) {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      // An explicit "read this answer" request owns the speakers until it finishes.
      if (!snapshot.enabled || sessionId === null || manual !== null) return
      timer = window.setTimeout(() => {
        timer = null
        void poll()
      }, delay)
    }

    async function poll() {
      if (polling || !snapshot.enabled || sessionId === null || manual !== null) return
      polling = true
      const requested = sessionId
      let delay = POLL_MS

      try {
        const response = await fetch(
          `${ROUTE}?session=${encodeURIComponent(requested)}&since=${cursor}`,
          { headers: { accept: 'application/json' }, cache: 'no-store' },
        )
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data = await response.json()
        failures = 0
        if (data && typeof data.voice === 'string' && data.voice !== snapshot.voice) emit({ voice: data.voice })
        if (snapshot.error !== '') emit({ error: '' })

        // The session may have changed while this request was in flight.
        if (sessionId !== requested || manual !== null) return

        const items = Array.isArray(data?.items) ? data.items : []
        let delivered = true
        for (const item of items) {
          if (!(await playItem(item))) {
            delivered = false
            break
          }
        }
        // Advance only over phrases that actually reached the queue, so a blocked autoplay
        // policy delays speech instead of dropping it.
        if (delivered && Number.isFinite(Number(data?.next))) cursor = Number(data.next)
        if (items.length > 0 && delivered) delay = 0
      } catch (error) {
        failures += 1
        emit({ error: String((error && error.message) || error) })
        delay = failures > 2 ? ERROR_BACKOFF_MS : POLL_MS
      } finally {
        polling = false
        schedule(delay)
      }
    }

    /**
     * Point playback at one session. Switching sessions stops the old audio and re-handshakes,
     * so the new session is read from its next phrase rather than from its history.
     *
     * @param id - the session the visible composer belongs to.
     */
    function attach(id) {
      if (typeof id !== 'string' || id.length === 0) return
      if (sessionId === id) return
      sessionId = id
      cursor = -1
      stopManual()
      stopSpeaking()
      emit({ sessionId: id })
      schedule(0)
    }

    // ---------------------------------------------------------------- on-demand playback

    /**
     * Reading one finished answer is a second, independent queue. While it runs the live
     * channel is suspended and re-handshakes afterwards, so finishing an old answer resumes at
     * the next new phrase instead of replaying what was missed.
     */
    let manual = null

    function manualKeyOf(sessionId, messageId) {
      return `${sessionId}\u0000${messageId}`
    }

    /**
     * Start (or restart) reading one finished answer.
     *
     * @param targetSessionId - the session the message belongs to.
     * @param messageId - the durable message id from the action row.
     */
    function startManual(targetSessionId, messageId) {
      if (typeof targetSessionId !== 'string' || typeof messageId !== 'string') return
      if (targetSessionId.length === 0 || messageId.length === 0) return

      stopManual()
      stopSpeaking()
      const key = manualKeyOf(targetSessionId, messageId)
      manual = { key, sessionId: targetSessionId, messageId, cursor: -1, timer: null, polling: false }
      emit({ manualKey: key, error: '' })

      // Suspend the live channel while an explicit request owns the speakers.
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
      manualTick()
    }

    /**
     * Stop reading on demand and hand the speakers back to the live channel.
     *
     * @param options.resume - whether to resume live playback (default true).
     */
    function stopManual({ resume = true } = {}) {
      if (manual === null) return
      if (manual.timer !== null) window.clearTimeout(manual.timer)
      manual = null
      stopSpeaking()
      emit({ manualKey: null })
      if (resume) {
        cursor = -1 // resume at the next phrase, not at whatever was missed
        schedule(0)
      }
    }

    async function manualTick() {
      if (manual === null) return
      const state = manual
      state.timer = null
      if (state.polling) return
      state.polling = true
      let delay = POLL_MS

      try {
        const url =
          `${MESSAGE_ROUTE}?session=${encodeURIComponent(state.sessionId)}` +
          `&id=${encodeURIComponent(state.messageId)}&since=${state.cursor}`
        const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
        const data = await response.json().catch(() => null)
        if (manual !== state) return // superseded while in flight

        if (!response.ok) {
          emit({ error: String(data?.error ?? `HTTP ${response.status}`) })
          // A message this process cannot resolve is reported once and abandoned.
          if (response.status === 404) {
            stopManual()
            return
          }
          throw new Error(String(data?.error ?? `HTTP ${response.status}`))
        }
        if (typeof data?.voice === 'string' && data.voice !== snapshot.voice) emit({ voice: data.voice })
        if (snapshot.error !== '') emit({ error: '' })

        const items = Array.isArray(data?.items) ? data.items : []
        let delivered = true
        for (const item of items) {
          if (!(await playItem(item))) {
            delivered = false
            break
          }
        }
        if (manual !== state) return
        if (delivered && Number.isFinite(Number(data?.next))) state.cursor = Number(data.next)

        if (delivered && data?.done === true) {
          // Hold the finished state briefly so the button does not flicker back mid-sentence.
          const finished = state
          window.setTimeout(() => {
            if (manual === finished) stopManual()
          }, 600)
          return
        }
        if (items.length > 0 && delivered) delay = 0
      } catch (error) {
        emit({ error: String((error && error.message) || error) })
        delay = ERROR_BACKOFF_MS
      } finally {
        state.polling = false
        if (manual === state && state.timer === null) state.timer = window.setTimeout(manualTick, delay)
      }
    }

    function setEnabled(value) {
      const enabled = Boolean(value)
      try {
        window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
      } catch {
        /* private mode */
      }
      if (!enabled) {
        stopManual({ resume: false })
        stopSpeaking()
      } else cursor = -1 // resume at the next phrase, not at whatever was missed
      emit({ enabled })
      if (enabled) schedule(0)
      else if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    // ---------------------------------------------------------------- the control

    /**
     * A short, human name for the configured voice: `zh-CN-XiaoyiNeural` is what the config
     * says, "小艺" is what the user calls it.
     *
     * @param shortName - the voice's `ShortName` as the host reported it.
     * @returns something worth putting in a tooltip.
     */
    function friendlyVoice(shortName) {
      const name = String(shortName ?? '')
      if (name.length === 0) return '小艺'
      const tail = name.split('-').pop() || name
      const known = { XiaoyiNeural: '小艺', XiaoxiaoNeural: '晓晓', YunjianNeural: '云健', YunxiNeural: '云希' }
      return known[tail] ?? tail.replace(/Neural$/, '')
    }

    /**
     * The speaker glyph in one of three states.
     *
     * @param props.mode - `off` (crossed out), `idle` (quiet speaker), `speaking` (sound waves).
     */
    function SpeakerIcon({ mode }) {
      const stroke =
        mode === 'speaking'
          ? 'var(--dsw-alias-brand-primary)'
          : mode === 'idle'
            ? 'var(--dsw-alias-label-secondary)'
            : 'var(--dsw-alias-state-idle-primary)'
      const common = {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke,
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }
      if (mode === 'off') {
        return h(
          'svg',
          common,
          h('path', { d: 'M2.5 6h2l3-2.5v9L4.5 10h-2z' }),
          h('path', { d: 'M10.5 6.2l3.4 3.6M13.9 6.2l-3.4 3.6' }),
        )
      }
      return h(
        'svg',
        common,
        h('path', { d: 'M2.5 6h2l3-2.5v9L4.5 10h-2z' }),
        mode === 'speaking'
          ? h('path', { d: 'M10.2 5.4a4 4 0 010 5.2M12.4 3.6a7 7 0 010 8.8' })
          : h('path', { d: 'M10.4 5.8a3.4 3.4 0 010 4.4' }),
      )
    }

    /** The three animated bars shown beside a button whose audio is playing. */
    function Waves() {
      return h('span', { className: 'dshtts-waves', 'aria-hidden': true }, h('i'), h('i'), h('i'))
    }

    const CSS = `
.dshtts-wrap { display: inline-flex; align-items: center; gap: 2px; }
.dshtts-button {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: none; border-radius: 6px;
  background: transparent; color: inherit; cursor: pointer; line-height: 0;
}
.dshtts-button:hover { background: var(--dsw-alias-bg-layer-2); }
.dshtts-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
/* The message action row is denser than the composer tool row; match its scale. */
.dshtts-button.is-inline { width: 22px; height: 22px; border-radius: 5px; }
.dshtts-button.is-inline svg { width: 14px; height: 14px; }
.dshtts-button.is-inline + .dshtts-waves { height: 8px; }
.dshtts-waves { display: inline-flex; align-items: flex-end; gap: 2px; height: 10px; margin-left: 1px; }
.dshtts-waves i { display: block; width: 2px; border-radius: 1px; background: var(--dsw-alias-brand-primary);
  animation: dshtts-bounce 900ms ease-in-out infinite; }
.dshtts-waves i:nth-child(1) { height: 4px; animation-delay: 0ms; }
.dshtts-waves i:nth-child(2) { height: 9px; animation-delay: 140ms; }
.dshtts-waves i:nth-child(3) { height: 6px; animation-delay: 280ms; }
@keyframes dshtts-bounce { 0%, 100% { transform: scaleY(.45); } 50% { transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) { .dshtts-waves i { animation: none; } }
`

    /** Subscribe a component to the player's observable state. */
    function usePlayerState() {
      const [state, setState] = React.useState(() => ({ ...snapshot }))
      React.useEffect(() => {
        const sync = () => setState({ ...snapshot })
        sync()
        return subscribe(sync)
      }, [])
      return state
    }

    /** The composer tool-row control: one speaker, click to read aloud or stay quiet. */
    function SpeakerToggle(props) {
      const sessionIdProp = props && props.sessionId
      const state = usePlayerState()

      React.useEffect(() => {
        attach(sessionIdProp)
      }, [sessionIdProp])

      const voice = friendlyVoice(state.voice)
      const title = state.error
        ? `朗读出错：${state.error}（点击关闭）`
        : state.enabled
          ? `正在用${voice}的声音朗读回答（点击关闭）`
          : '朗读已关闭（点击开启）'

      return h(
        'div',
        { className: 'dshtts-wrap' },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className:
              'dshtts-button' + (state.enabled ? ' is-on' : '') + (state.speaking && state.manualKey === null ? ' is-speaking' : ''),
            title,
            'aria-label': title,
            'aria-pressed': state.enabled,
            onClick: () => setEnabled(!state.enabled),
          },
          h(SpeakerIcon, { mode: state.enabled ? (state.speaking ? 'speaking' : 'idle') : 'off' }),
        ),
        state.speaking && state.manualKey === null ? h(Waves) : null,
      )
    }

    /**
     * The per-answer control in an assistant message's action row: read this answer, or stop it.
     *
     * @param props.messageId - the durable message id, supplied by the action row.
     * @param props.sessionId - the session the message belongs to.
     */
    function MessageSpeakButton(props) {
      const messageId = props && props.messageId
      const sessionIdProp = props && props.sessionId
      const state = usePlayerState()

      const usable = typeof messageId === 'string' && messageId.length > 0 && typeof sessionIdProp === 'string'
      const key = usable ? manualKeyOf(sessionIdProp, messageId) : null
      const playing = key !== null && state.manualKey === key
      const title = playing ? '停止朗读这条回答' : '朗读这条回答'

      return h(
        'div',
        { className: 'dshtts-wrap' },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'dshtts-button is-inline' + (playing ? ' is-on is-speaking' : ''),
            title,
            'aria-label': title,
            'aria-pressed': playing,
            disabled: !usable,
            onClick: () => {
              if (!usable) return
              if (playing) stopManual()
              else startManual(sessionIdProp, messageId)
            },
          },
          h(SpeakerIcon, { mode: playing ? 'speaking' : 'idle' }),
        ),
        playing ? h(Waves) : null,
      )
    }

    /** The slot service is all this half needs. */
    const inject = ['slots']

    function apply(ctx) {
      // One toggle beside the composer, for the whole session.
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          { name: 'conversation.input.right', id: 'dsh-tts-reader', order: 40, label: '朗读' },
          SpeakerToggle,
        ),
      )
      // One button per finished answer, in the row that already holds 复制 / 点赞 / 用量.
      ctx.slots.inject('conversation.chat.assistant-actions', () =>
        ctx.slots.register(
          { name: 'conversation.chat.assistant-actions', id: 'dsh-tts-reader-message', order: 60, label: '朗读' },
          MessageSpeakButton,
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
