/**
 * Offline tests for the read-aloud queue. These run without DSH and without the speech
 * service: synthesis is a stub, so the cursor contract, the pruning window, and the failure
 * path are all exercised deterministically.
 */
import { createFeedStore } from '../lib/feed.js'

let failures = 0
function check(label, condition, detail = '') {
  if (!condition) failures += 1
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

const calls = []
const store = createFeedStore({
  synthesize: async ({ text }) => {
    calls.push(text)
    if (text.includes('炸')) throw new Error('boom')
    return Buffer.from(`mp3:${text}`, 'utf8')
  },
  maxPerRequest: 2,
})

// --- streaming in: phrases appear as the text arrives -------------------------------
check('an unseen session has cursor 0', store.cursor('s1') === 0, String(store.cursor('s1')))
store.push('s1', '第一句话在这里。第二句话')
check('one phrase ready so far', store.cursor('s1') === 1, String(store.cursor('s1')))
store.push('s1', '也在这里。')
check('two phrases queued', store.cursor('s1') === 2, String(store.cursor('s1')))

// --- since = -1 is a "start from now" handshake -------------------------------------
const handshake = await store.tail('s1', -1)
check('since=-1 returns nothing', handshake.items.length === 0, JSON.stringify(handshake))
check('since=-1 reports the live cursor', handshake.next === 2, String(handshake.next))

// --- pulling after the cursor returns audio ----------------------------------------
const first = await store.tail('s1', 0)
check('a cold pull returns one synthesized phrase', first.items.length === 1, String(first.items.length))
check('cursor advanced to 1', first.next === 1, String(first.next))
check('audio is base64 of the stub', Buffer.from(first.items[0].audio, 'base64').toString('utf8') === 'mp3:第一句话在这里。')
const second = await store.tail('s1', first.next)
check('the next pull continues the queue', second.items.length === 1 && second.next === 2, JSON.stringify(second).slice(0, 120))
check('synthesis called once per phrase', calls.length === 2, calls.join(' / '))

// --- cached audio is not synthesized twice -----------------------------------------
await store.tail('s1', 0)
check('cached audio reused', calls.length === 2, String(calls.length))

// --- a failed phrase is reported, not retried forever -------------------------------
store.push('s1', '这句会炸掉。')
const failure = await store.tail('s1', 2)
check('failure yields a null audio item', failure.items.length === 1 && failure.items[0].audio === null, JSON.stringify(failure))
check('failure advances the cursor', failure.next === 3, String(failure.next))
await store.tail('s1', 2)
check('failure is not retried', calls.filter((text) => text.includes('炸')).length === 1)

// --- flush speaks the tail without a terminator -------------------------------------
store.push('s2', '没有标点的一句话')
check('nothing ready before flush', store.cursor('s2') === 0, String(store.cursor('s2')))
store.flush('s2')
check('flush releases the tail', store.cursor('s2') === 1, String(store.cursor('s2')))

// --- one fresh synthesis per pull, so the first sound is not held hostage ------------
store.push('s3', '这是第一段完整的句子。这是第二段完整的句子。这是第三段完整的句子。这是第四段完整的句子。这是第五段完整的句子。')
const burst = await store.tail('s3', 0, 8)
check('first pull synthesizes exactly one phrase', burst.items.length === 1, String(burst.items.length))
check('and reports only it as the cursor', burst.next === 1, String(burst.next))

// --- once cached, a pull returns the full ceiling at once ---------------------------
for (let round = 0; round < 4; round += 1) await store.tail('s3', 0, 8)
const warm = await store.tail('s3', 0, 8)
check('a warm pull admits all five', warm.items.length === 5, String(warm.items.length))
const capped = await store.tail('s3', 0, 3)
check('an explicit limit caps a warm pull', capped.items.length === 3, String(capped.items.length))

// --- an unknown session is inert ----------------------------------------------------
const unknown = await store.tail('nope', 0)
check('unknown session returns empty', unknown.items.length === 0 && unknown.next === 0, JSON.stringify(unknown))

// --- forgetting a session -----------------------------------------------------------
store.forget('s3')
check('forget drops the feed', (await store.tail('s3', 0)).items.length === 0)
check('only the live feeds remain', store.size === 2, String(store.size))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
