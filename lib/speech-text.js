/**
 * Turn a streaming Markdown answer into short, speakable phrases.
 *
 * The model's output is written for the eye: fenced code, tables, link syntax, emphasis
 * markers. Read aloud verbatim it is noise, so this module (a) drops what cannot be spoken,
 * (b) unfolds what only looks like punctuation, and (c) cuts the result into phrases short
 * enough to synthesize one at a time — which is what makes playback start while the answer
 * is still being written.
 *
 * The buffer is incremental on purpose: `push` is fed raw model deltas of arbitrary
 * alignment and returns only the phrases that became complete, keeping the tail for later.
 */

/** Phrases shorter than this are merged forward, so the voice does not clip single words. */
const MIN_PHRASE_CHARS = 4
/** A phrase longer than this is cut at a clause break, or failing that, hard-cut. */
const MAX_PHRASE_CHARS = 150
/** How far back to search for a clause break when a phrase must be cut. */
const CLAUSE_WINDOW = 60

/** Sentence-final punctuation, in both scripts. A newline also ends a phrase. */
const HARD_ENDS = new Set(['。', '！', '？', '!', '?', '…', '\n', '．'])
/** Weak punctuation: only ends a phrase once enough of it has accumulated. */
const SOFT_ENDS = new Set(['；', ';', '，', ',', '、', '：', ':'])
/** Weak punctuation length threshold — below this the clause keeps growing. */
const SOFT_END_MIN = 14

const FENCE = /^\s*(?:```|~~~)/
const TABLE_RULE = /^\s*\|?[\s:|-]+\|?\s*$/
const RULE = /^\s*(?:[-*_])\s*(?:[-*_]\s*){2,}$/

/**
 * Rewrite one already-complete line of Markdown into spoken words.
 *
 * @param line - one source line, without its newline.
 * @returns the speakable remainder, or an empty string when the line carries nothing to say.
 */
function speakableLine(line) {
  let text = line

  // A table's own rule row (|---|---|) and a horizontal rule carry no words.
  if (RULE.test(text)) return ''
  if (TABLE_RULE.test(text) && text.includes('-')) return ''

  text = text.replace(/<[^>\n]{1,200}>/g, ' ')
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/^\s{0,3}#{1,6}\s+/, '')
  text = text.replace(/^\s{0,3}>\s?/, '')
  text = text.replace(/^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+/, '')

  // Table cells become clauses; the pipes themselves are punctuation for the eye only.
  if (text.includes('|')) text = text.replace(/\s*\|\s*/g, '，').replace(/^，+|，+$/g, '')

  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')
  text = text.replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2')
  text = text.replace(/~~(.*?)~~/g, '$1')
  text = text.replace(/`([^`]*)`/g, '$1')
  // A bare URL is unlistenable; the words around it already say what it is.
  text = text.replace(/https?:\/\/\S+/g, ' 链接 ')
  // Whatever formatting punctuation survived has no sound.
  text = text.replace(/[*_`~]/g, '')

  return text.replace(/\s+/g, ' ').trim()
}

/**
 * A streaming Markdown-to-phrase buffer.
 *
 * @returns `push(delta)` for new model text and `flush()` for the end of a text block, both
 *   returning an array of ready-to-speak phrases.
 */
export function createSpeechBuffer() {
  /** Raw characters of the current, not-yet-terminated line. */
  let line = ''
  /** Whether the cursor sits inside a fenced code block. */
  let inFence = false
  /** Cleaned text that is complete in Markdown terms but not yet a whole phrase. */
  let pending = ''
  /** Phrases held back to satisfy {@link MIN_PHRASE_CHARS}. */
  let carried = ''

  /** Fold one finished line into `pending`. */
  function consumeLine(source) {
    if (FENCE.test(source)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const speakable = speakableLine(source)
    if (speakable.length > 0) pending += speakable + '\n'
  }

  /** Cut every complete phrase out of `pending`, oldest first. */
  function drain() {
    const phrases = []

    for (;;) {
      let cut = -1
      for (let index = 0; index < pending.length; index += 1) {
        const char = pending[index]
        if (HARD_ENDS.has(char)) {
          cut = index + 1
          break
        }
        if (SOFT_ENDS.has(char) && index + 1 >= SOFT_END_MIN) {
          cut = index + 1
          break
        }
      }

      if (cut < 0) {
        // No terminator yet: only a phrase that has grown too long is cut early, and then
        // only at a clause boundary so the voice does not stop mid-word.
        if (pending.length <= MAX_PHRASE_CHARS) break
        cut = MAX_PHRASE_CHARS
        const window = pending.slice(Math.max(0, cut - CLAUSE_WINDOW), cut)
        for (let index = window.length - 1; index >= 0; index -= 1) {
          if (SOFT_ENDS.has(window[index]) || window[index] === ' ') {
            cut = Math.max(0, cut - CLAUSE_WINDOW) + index + 1
            break
          }
        }
      }

      const phrase = (carried + pending.slice(0, cut)).replace(/\s+/g, ' ').trim()
      pending = pending.slice(cut)
      carried = ''

      if (phrase.length === 0) continue
      if (phrase.length < MIN_PHRASE_CHARS) {
        carried = phrase
        continue
      }
      phrases.push(phrase)
    }

    return phrases
  }

  return {
    /**
     * Feed raw model text.
     *
     * @param delta - the newly streamed characters.
     * @returns every phrase that is now complete.
     */
    push(delta) {
      if (typeof delta !== 'string' || delta.length === 0) return []
      line += delta
      const phrases = []

      // Consume whole lines first, then decide whether the partial line already contains a
      // finished phrase — that is what lets an unbroken paragraph start speaking early.
      for (;;) {
        const breakAt = line.indexOf('\n')
        if (breakAt < 0) break
        consumeLine(line.slice(0, breakAt))
        line = line.slice(breakAt + 1)
        phrases.push(...drain())
      }

      if (!inFence) {
        const lastHard = Math.max(
          line.lastIndexOf('。'),
          line.lastIndexOf('！'),
          line.lastIndexOf('？'),
          line.lastIndexOf('!'),
          line.lastIndexOf('?'),
          line.lastIndexOf('…'),
        )
        if (lastHard >= 0) {
          consumeLine(line.slice(0, lastHard + 1))
          line = line.slice(lastHard + 1)
          phrases.push(...drain())
        } else if (line.length > MAX_PHRASE_CHARS) {
          consumeLine(line)
          line = ''
          phrases.push(...drain())
        }
      }

      return phrases
    },

    /**
     * Close the current text block: speak the trailing partial line and the held-back tail.
     *
     * @returns the final phrases of this block.
     */
    flush() {
      if (line.length > 0) {
        consumeLine(line)
        line = ''
      }
      // A text block that ended inside an unclosed fence says nothing more.
      inFence = false
      const phrases = drain()
      const tail = (carried + pending).replace(/\s+/g, ' ').trim()
      carried = ''
      pending = ''
      if (tail.length > 0) phrases.push(tail)
      return phrases
    },
  }
}

/**
 * Split one phrase into pieces the speech service will accept in a single request.
 *
 * @param phrase - a speakable phrase.
 * @param limit - maximum characters per piece.
 * @returns one or more non-empty pieces.
 */
export function clampPhrase(phrase, limit = MAX_PHRASE_CHARS) {
  const text = String(phrase).trim()
  if (text.length <= limit) return text.length > 0 ? [text] : []
  const pieces = []
  let rest = text
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = limit
    for (let index = window.length - 1; index >= limit - CLAUSE_WINDOW; index -= 1) {
      if (SOFT_ENDS.has(window[index]) || window[index] === ' ') {
        cut = index + 1
        break
      }
    }
    pieces.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim().length > 0) pieces.push(rest.trim())
  return pieces.filter((piece) => piece.length > 0)
}
