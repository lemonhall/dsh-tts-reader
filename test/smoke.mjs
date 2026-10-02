/**
 * Standalone smoke test for the two host-side modules, runnable with `node test/smoke.mjs`
 * outside DSH. It answers three questions the plugin depends on: does the phrase buffer cut
 * Markdown into speakable pieces, does the voice catalog really contain the configured voice,
 * and does a synthesized phrase arrive as decodable MP3.
 */
import { writeFileSync } from 'node:fs'
import { createSpeechBuffer } from '../lib/speech-text.js'
import { derivedVoiceName, listVoices, resolveVoiceName, synthesizeMp3WithRetry, splitForRequests } from '../lib/edge-tts.js'

let failures = 0

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures += 1
  console.log(`[${mark}] ${label}${detail ? ' — ' + detail : ''}`)
}

// ---------------------------------------------------------------- phrase buffer

const SAMPLE = [
  '# 标题：一次测试\n',
  '\n',
  '这段话里**有加粗**、`inline code`、和一个[链接](https://example.com)。它应该被念出来。\n',
  '\n',
  '```js\n',
  'const hidden = "代码块不该被念出来";\n',
  'console.log(hidden)\n',
  '```\n',
  '\n',
  '| 项目 | 数值 |\n',
  '|---|---|\n',
  '| 余额 | 12.34 |\n',
  '\n',
  '还有一句带问号的话吗？最后一句没有标点',
].join('')

// Feed it in awkward slices so a mid-marker split is exercised.
const buffer = createSpeechBuffer()
const spoken = []
for (let index = 0; index < SAMPLE.length; index += 7) {
  spoken.push(...buffer.push(SAMPLE.slice(index, index + 7)))
}
spoken.push(...buffer.flush())

const joined = spoken.join(' ~ ')
console.log('phrases:', JSON.stringify(spoken, null, 0))
check('produced phrases', spoken.length >= 4, `${spoken.length} phrases`)
check('code block dropped', !joined.includes('hidden') && !joined.includes('console.log'))
check('markers stripped', !/[*`#|]/.test(joined), joined)
check('link text kept', joined.includes('链接'), joined)
check('table rule dropped', !joined.includes('---'))
check('longest phrase within limit', spoken.every((phrase) => phrase.length <= 160))
check('no empty phrases', spoken.every((phrase) => phrase.trim().length > 0))
check('voice name derived from short name', derivedVoiceName('zh-CN-XiaoyiNeural') === 'Microsoft Server Speech Text to Speech Voice (zh-CN, XiaoyiNeural)', derivedVoiceName('zh-CN-liaoning-XiaobeiNeural'))

const split = splitForRequests('甲'.repeat(5000), 1800)
check('request splitting caps bytes', split.every((piece) => Buffer.byteLength(piece, 'utf8') <= 1800), `${split.length} pieces`)

// ---------------------------------------------------------------- live service

const VOICE = process.env.TTS_VOICE ?? 'zh-CN-XiaoyiNeural'

console.log('\n-- live service --')
try {
  const voices = await listVoices({ localePrefix: 'zh-' })
  const match = voices.find((voice) => voice.ShortName === VOICE)
  check(`voice catalog contains ${VOICE}`, Boolean(match), match ? match.Gender + '/' + match.Locale : 'not found')
  check(
    'catalog Name agrees with the offline derivation',
    match ? (await resolveVoiceName(VOICE)) === match.Name : false,
    match ? match.Name : '',
  )
  console.log('zh voices:', voices.map((voice) => voice.ShortName).join(', '))
} catch (error) {
  check('voice catalog reachable', false, error.message)
}

try {
  const started = Date.now()
  const mp3 = await synthesizeMp3WithRetry({
    text: '你好，柠檬叔，我是小艺。这是一次朗读连通性测试。',
    voice: VOICE,
  })
  const first = Date.now() - started
  const header = mp3.subarray(0, 3).toString('latin1')
  const looksMp3 = mp3.length > 512 && (header === 'ID3' || (mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0))
  check('synthesis returned MP3', looksMp3, `${mp3.length} bytes, first3=${JSON.stringify(header)}`)
  writeFileSync(new URL('./out-xiaoyi.mp3', import.meta.url), mp3)
  console.log(`synthesized in ${first} ms -> test/out-xiaoyi.mp3`)
} catch (error) {
  check('synthesis works', false, error.stack ?? String(error))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
