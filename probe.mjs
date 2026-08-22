// Adversarial probe: regex backtracking, boundary inputs, memory. NOT a unit test —
// measures behaviour/time on pathological inputs and prints findings.
import {
  extract, blockMd, inlineMd, findNextLink, smartTruncate, compactJson,
  decodeBuffer, decodeTextEntities, raceFirstSuccess, readUrl,
} from './index.js'
const textOnly = (html) => extract(`<body>${html}</body>`, 'text').text
import { looksBinary } from './proxy-fallback.js'

const t = (name, fn) => {
  const start = performance.now()
  try {
    const out = fn()
    const ms = (performance.now() - start).toFixed(1)
    console.log(`PASS ${ms.padStart(8)}ms ${name}${out !== undefined ? ' → ' + String(out).slice(0, 60) : ''}`)
  } catch (e) {
    const ms = (performance.now() - start).toFixed(1)
    console.log(`THROW ${ms.padStart(7)}ms ${name} — ${e.message}`)
  }
}

console.log('=== A. regex-backtracking candidates (each should finish < 300ms) ===')
// quote-alternation inside the md walker's attribute group
const QUOTE_ALT = `<a ${`'"`.repeat(20000)}>x</a>`
t('blockMd 40k quote-alternation attrs', () => blockMd(QUOTE_ALT).length)
t('inlineMd 40k quote-alternation attrs', () => inlineMd(QUOTE_ALT).length)
// unclosed tag with many partial closes: <div> ... </di </d </
const UNCLOSED = `<div>${'<div>'.repeat(10000)}${'</di '.repeat(10000)}`
t('blockMd 10k unclosed nested divs', () => blockMd(UNCLOSED).length)
// a-tag lazy scan with no closing </a>
t('textOnly 200k anchors never closed', () => textOnly(`<a href="/x">${'y'.repeat(200000)}`).length)
// extractLinks: thousands of anchors, some malformed
const MANY_ANCHORS = Array.from({ length: 20000 }, (_, i) => `<a href="/p${i}">t${i}</a>`).join('')
t('extractLinks via findNextLink 20k anchors', () => findNextLink(MANY_ANCHORS, 'https://x.com/'))
// entity decode bombs
t('decodeTextEntities 200k numeric entities', () => decodeTextEntities('&#65;'.repeat(200000)).length)
// table with many rows
const TBL = `<table>${Array.from({ length: 3000 }, (_, i) => `<tr><td>a${i}|b</td><td>c</td></tr>`).join('')}</table>`
t('blockMd 3000-row table', () => blockMd(TBL).length)
// nested lists
const LISTS = `<ul>${'<li><ul><li>'.repeat(2000)}x${'</li></ul></li>'.repeat(2000)}</ul>`
t('blockMd 2000-deep nested lists', () => blockMd(LISTS).length)

console.log('\n=== B. smartTruncate boundaries ===')
t('giant single paragraph, no punctuation', () => smartTruncate('一'.repeat(500000), 6000).text.length)
t('giant single paragraph with punctuation', () => {
  const r = smartTruncate('句子。'.repeat(100000), 6000)
  return `${r.text.length} endsWith:${r.text.slice(-1)} truncated:${r.truncated}`
})
t('offset in middle of giant paragraph continues w/o repeat', () => {
  const para = Array.from({ length: 50000 }, (_, i) => `S${i}。`).join('')
  const a = smartTruncate(para, 6000)
  const b = smartTruncate(para, 6000, a.charsStart + a.text.length)
  return `a:${a.text.slice(0, 10)}… b:${b.text.slice(0, 10)}… overlap:${a.text.slice(-20) === b.text.slice(0, 20)}`
})
t('offset far beyond end', () => JSON.stringify(smartTruncate('abc', 10, 999999)))
t('maxChars 0 / negative / NaN', () => {
  smartTruncate('abcdef', 0)
  smartTruncate('abcdef', -5)
  smartTruncate('abcdef', NaN)
  return 'no throw'
})

console.log('\n=== C. compactJson boundaries ===')
t('deep nesting 5000 levels', () => {
  let v = 'x'
  for (let i = 0; i < 5000; i++) v = { a: v }
  return compactJson(v).slice(0, 30)
})
t('big array 200k numbers', () => compactJson(Array.from({ length: 200000 }, (_, i) => i)).length)
t('long keys', () => compactJson({ ['k'.repeat(5000)]: 'v' }).length)
t('surrogates in values', () => compactJson({ s: '\ud83d\ude00'.repeat(10) }))

console.log('\n=== D. decode/charset adversarial ===')
t('declared charset garbage label', () => decodeBuffer(Buffer.from('<p>hi</p>'), 'text/html; charset=℘-nonsense').charset)
t('utf-16le BOM + junk', () => decodeBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>x</p>')])).charset)
t('looksBinary empty/short', () => `${looksBinary(Buffer.alloc(0))} ${looksBinary(Buffer.from([0x41]))}`)

console.log('\n=== E. extraction edge cases ===')
t('scripty custom tag not eaten as script', () => textOnly('<scripty>keep this</scripty>after').trim())
t('revealEscapedTags: quoted attr entities', () => extract('<body><p>&lt;b&gt;粗体&lt;/b&gt;内容</p></body>', 'text').text)
t('bidi/control chars in text', () => extract('<body><p>te\u202Est\u202cxt</p></body>', 'text').text.length)
t('null byte inside html', () => extract('<body><p>a\u0000b</p></body>', 'text').text.length)

console.log('\n=== F. readUrl arg hardening (e2e, no network needed for rejects) ===')
const noFetchCtx = { get: () => null }
t('url file:// rejected', async () => JSON.stringify(await readUrl({ url: 'file:///etc/passwd' }, noFetchCtx)).slice(0, 60))
t('url ftp:// rejected', async () => JSON.stringify(await readUrl({ url: 'ftp://x.com/f' }, noFetchCtx)).slice(0, 60))
t('url javascript: rejected', async () => JSON.stringify(await readUrl({ url: 'javascript:alert(1)' }, noFetchCtx)).slice(0, 60))
t('url with credentials', async () => JSON.stringify(await readUrl({ url: 'http://u:p@127.0.0.1:1/x' }, noFetchCtx)).slice(0, 80))
t('urls arg wrong types', async () => JSON.stringify(await readUrl({ url: ['a', {}, null] }, noFetchCtx)).slice(0, 60))
t('maxChars "abc" / offset -3 / Infinity', async () => {
  const cfg = { timeoutMs: 500, maxBytes: 65536, maxChars: 6000, maxLinks: 20, cacheTtlMs: 1, cacheMax: 2, spaRender: false, paginate: false, paginateMax: 1, userAgent: 'x' }
  const r = await readUrl({ url: 'http://127.0.0.1:1/instant-refused', maxChars: 'abc', offset: -3 }, noFetchCtx, undefined, cfg)
  return r.error ? 'err-shape ok' : JSON.stringify(r).slice(0, 50)
})

console.log('\n=== G. race semantics recheck ===')
t('race: value without buffer counts as failure', async () => {
  const out = await raceFirstSuccess([Promise.resolve({ error: 'e1' }), Promise.resolve(null)])
  return `success:${out.success} failures:${out.failures.length}`
})
t('race: throwing promise recorded', async () => {
  const out = await raceFirstSuccess([Promise.reject(new Error('boom'))])
  return `success:${out.success} f0:${out.failures[0] && out.failures[0].error}`
})

console.log('\nprobe done')
