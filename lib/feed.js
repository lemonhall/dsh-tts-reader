/**
 * The read-aloud queue, kept free of DSH and of the speech service so it can be tested on
 * its own.
 *
 * One feed per session collects the model's streamed text, turns it into phrases, and holds
 * them in sequence order. The browser half pulls phrases with a cursor and gets the audio
 * bytes with them; synthesis happens on demand, which is what stops a session nobody is
 * listening to from spending anything on the speech service.
 */

import { createSpeechBuffer, clampPhrase } from './speech-text.js'

/** Phrases kept per session before the oldest are dropped. */
const MAX_PHRASES = 400
/** A feed untouched for this long is forgotten on the next look-up. */
const FEED_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Create the feed store.
 *
 * @param options.synthesize - `async ({ text, seq, sessionId }) => Buffer`, the only effect.
 * @param options.maxPerRequest - ceiling on phrases returned (and synthesized) per pull.
 * @param options.log - sink for synthesis failures; defaults to a no-op.
 * @returns the store used by the host half.
 */
export function createFeedStore({ synthesize, maxPerRequest = 3, maxNewPerPull = 1, log = () => {} } = {}) {
  /** @type {Map<string, {buffer: ReturnType<typeof createSpeechBuffer>, items: Array<{seq: number, text: string, audio: Buffer|null, failed: boolean}>, firstSeq: number, nextSeq: number, touchedAt: number}>} */
  const feeds = new Map()

  function prune(now = Date.now()) {
    for (const [sessionId, feed] of feeds) {
      if (now - feed.touchedAt > FEED_TTL_MS) feeds.delete(sessionId)
    }
  }

  function ensure(sessionId) {
    let feed = feeds.get(sessionId)
    if (feed === undefined) {
      feed = { buffer: createSpeechBuffer(), items: [], firstSeq: 1, nextSeq: 1, touchedAt: Date.now() }
      feeds.set(sessionId, feed)
    }
    if (feeds.size > 64) prune()
    return feed
  }

  /** Append one already-speakable phrase, splitting it when the service needs it split. */
  function enqueue(feed, phrase) {
    for (const piece of clampPhrase(phrase)) {
      feed.items.push({ seq: feed.nextSeq, text: piece, audio: null, failed: false })
      feed.nextSeq += 1
    }
    while (feed.items.length > MAX_PHRASES) {
      feed.items.shift()
      feed.firstSeq += 1
    }
    feed.touchedAt = Date.now()
  }

  return {
    /**
     * Feed streamed model text into a session's queue.
     *
     * @param sessionId - the session the text belongs to.
     * @param delta - freshly streamed characters.
     * @returns how many phrases became ready.
     */
    push(sessionId, delta) {
      const feed = ensure(sessionId)
      const phrases = feed.buffer.push(delta)
      for (const phrase of phrases) enqueue(feed, phrase)
      return phrases.length
    },

    /**
     * Close the current text block and queue whatever is still held back.
     *
     * @param sessionId - the session whose block ended.
     * @returns how many phrases became ready.
     */
    flush(sessionId) {
      const feed = feeds.get(sessionId)
      if (feed === undefined) return 0
      const phrases = feed.buffer.flush()
      for (const phrase of phrases) enqueue(feed, phrase)
      return phrases.length
    },

    /**
     * The cursor a freshly connected listener should start from, so a page reload does not
     * replay everything said since the application started.
     *
     * @param sessionId - the session being listened to.
     * @returns the sequence number the next phrase will take.
     */
    cursor(sessionId) {
      return (feeds.get(sessionId)?.nextSeq ?? 1) - 1
    },

    /**
     * Pull phrases after `since`, synthesizing the audio for any that lack it.
     *
     * @param sessionId - the session to read.
     * @param since - last sequence number the caller already has; `-1` means "start now".
     * @param limit - phrase ceiling for this pull.
     * @param signal - aborts the synthesis calls.
     * @returns `{ next, items }` where each item is `{ seq, text, audio }` and `audio` is a
     *   base64 MP3 (or null when that phrase could not be synthesized).
     */
    async tail(sessionId, since, limit = maxPerRequest, signal) {
      prune()
      const feed = feeds.get(sessionId)
      if (feed === undefined) return { next: 0, items: [] }
      feed.touchedAt = Date.now()

      let from = Number.isFinite(since) ? Math.trunc(since) : -1
      if (from < 0) return { next: feed.nextSeq - 1, items: [] }
      // A caller that fell behind the pruning window resumes at the oldest phrase still held.
      if (from + 1 < feed.firstSeq) from = feed.firstSeq - 1

      const ceiling = Math.max(1, Math.min(Number(limit) || maxPerRequest, 8))
      const wanted = feed.items.filter((item) => item.seq > from).slice(0, ceiling)
      const items = []
      let fresh = 0

      for (const item of wanted) {
        if (item.audio === null && !item.failed) {
          // At most `maxNewPerPull` fresh syntheses per pull. A listener that is behind
          // otherwise waits for the whole batch before hearing anything, which is the
          // difference between first sound at ~1 s and first sound at ~3 s; the next pull,
          // issued while this one plays, catches up.
          if (fresh >= maxNewPerPull) break
          fresh += 1
          try {
            item.audio = await synthesize({ text: item.text, seq: item.seq, sessionId, signal })
          } catch (error) {
            item.failed = true
            log(`synthesis failed for ${sessionId}#${item.seq}: ${error?.message ?? error}`)
          }
        }
        items.push({
          seq: item.seq,
          text: item.text,
          audio: item.audio === null ? null : item.audio.toString('base64'),
        })
      }

      const last = items.length > 0 ? items[items.length - 1].seq : from
      return { next: last, items }
    },

    /** Drop one session's feed. */
    forget(sessionId) {
      feeds.delete(sessionId)
    },

    /** Number of feeds currently held; for tests and diagnostics. */
    get size() {
      return feeds.size
    },
  }
}
