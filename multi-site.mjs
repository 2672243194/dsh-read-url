// multi-site.mjs — real-world multi-site verification for dsh-read-url
// 29-site sweep: Chinese portals / SPA / encoding / anti-bot / static /
// type-block (PDF/PNG) / 404 / redirect / DNS-failure / overseas sites.
// Checks extraction quality, charset detection, noise filtering, SPA
// rendering, continuation, batch and site-crawl.
// Run: node multi-site.mjs
import * as m from './index.js'

const SITES = [
  ['bilibili-rank', 'https://www.bilibili.com/v/popular/rank/all'],
  ['xiaoheihe (SPA)', 'https://www.xiaoheihe.cn/'],
  ['juejin (SPA)', 'https://juejin.cn/'],
  ['zhihu (login-wall)', 'https://www.zhihu.com/'],
  ['weibo (login-wall)', 'https://weibo.com/'],
  ['csdn', 'https://www.csdn.net/'],
  ['cnblogs (multi-article)', 'https://www.cnblogs.com/'],
  ['sina-news', 'https://news.sina.com.cn/'],
  ['qq-news', 'https://news.qq.com/'],
  ['163-news', 'https://news.163.com/'],
  ['douban', 'https://www.douban.com/'],
  ['baidu (anti-bot)', 'https://www.baidu.com/'],
  ['ruanyifeng (static)', 'https://www.ruanyifeng.com/blog/'],
  ['example.com (static)', 'https://example.com/'],
  ['mdn (static doc)', 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript'],
  ['wikipedia-zh (geo/anti-bot)', 'https://zh.wikipedia.org/wiki/JavaScript'],
  ['w3c (403 for chrome UA)', 'https://www.w3.org/TR/'],
  ['github (net/tls boundary)', 'https://github.com/'],
  ['sohu', 'https://www.sohu.com/'],
  ['ifeng', 'https://www.ifeng.com/'],
  ['sspai (SPA)', 'https://sspai.com/'],
  ['v2ex (proxy-fallback)', 'https://www.v2ex.com/'],
  ['bbc-zh (proxy-fallback)', 'https://www.bbc.com/zhongwen/simp'],
  ['wikipedia-en (net-boundary)', 'https://en.wikipedia.org/wiki/JavaScript'],
  ['pdf-sample (type block, net-boundary)', 'https://www.africau.edu/images/default/sample.pdf'],
  ['httpbin-png (type block, net-boundary)', 'https://httpbin.org/image/png'],
  ['httpbin-404 (net-boundary)', 'https://httpbin.org/status/404'],
  ['httpbin-redirect (net-boundary)', 'https://httpbin.org/redirect/3'],
  ['dns-fail (ENOTFOUND expected)', 'https://nonexistent-domain-xyz123.com/'],
]

const tools = []
m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
const read = tools.find((t) => t.name === 'read_url')
const batchTool = tools.find((t) => t.name === 'read_url_batch')
const siteTool = tools.find((t) => t.name === 'read_url_site')

function short(s, n = 70) {
  if (s === undefined) return 'undefined'
  s = String(s)
  return s.length > n ? s.slice(0, n) + '…' : s
}

function noiseCheck(text) {
  if (!text) return false
  const t = text.slice(0, 2000)
  return /font-size|font-family|margin:|padding:|\.css|\{\s*[a-z-]+:/i.test(t) || /<[a-z/!]/.test(t)
}

console.log(`=== dsh-read-url multi-site verification (${SITES.length} sites) ===\n`)

let okC = 0
let thinC = 0
let errC = 0
const results = []
for (let i = 0; i < SITES.length; i++) {
  const [label, url] = SITES[i]
  process.stdout.write(`[${String(i + 1).padStart(2, '/')}${SITES.length}] ${label} … `)
  const t0 = Date.now()
  let r
  try {
    r = await read.execute({ url, maxChars: 800 })
  } catch (e) {
    console.log(`THREW (${Date.now() - t0}ms): ${short(e.message, 80)}`)
    results.push({ label, status: 'THREW', detail: e.message })
    continue
  }
  const ms = Date.now() - t0
  if (r.error) {
    console.log(`ERR  (${ms}ms): ${short(r.error, 80)}`)
    results.push({ label, status: 'ERR', detail: r.error })
    errC++
    continue
  }
  const len = r.text ? r.text.length : 0
  const noisy = noiseCheck(r.text)
  const flags = [r.charset ? `charset=${r.charset}` : '', r.rendered ? 'SPA-rendered' : '', r.cached ? 'cached' : '', noisy ? 'NOISE!' : ''].filter(Boolean).join(' ')
  if (len >= 200 && !noisy) {
    console.log(`OK   (${ms}ms) ${len}字符 ${flags}`)
    results.push({ label, status: 'OK', chars: len, flags })
    okC++
  } else if (len > 0) {
    console.log(`THIN (${ms}ms) ${len}字符 ${flags} | ${short(r.text, 40)}`)
    results.push({ label, status: 'THIN', chars: len, flags, detail: short(r.text, 60) })
    thinC++
  } else {
    console.log(`EMPTY(${ms}ms) ${flags} ${r.spaHint ? '| ' + short(r.spaHint, 60) : ''}`)
    results.push({ label, status: 'EMPTY', flags, detail: r.spaHint || '' })
    thinC++
  }
  await new Promise((r2) => setTimeout(r2, 400))
}

console.log(`\n=== summary: ${okC} OK / ${thinC} THIN+EMPTY / ${errC} ERR / ${results.filter((x) => x.status === 'THREW').length} THREW ===`)
for (const r of results) {
  console.log(`  ${r.status.padEnd(6)} | ${r.label} | ${r.detail || (r.chars ? `${r.chars}字符` : '')} ${r.flags || ''}`.trimEnd())
}

// ---- continuation (offset) on a long page ----
console.log('\n=== offset continuation (sina news, 800+800) ===')
const cont = await read.execute({ url: 'https://news.sina.com.cn/', maxChars: 800, offset: 800 })
if (cont.error) console.log('  cont ERR:', short(cont.error))
else console.log(`  chars ${cont.charsStart}+${cont.charsReturned}/${cont.charsTotal}${cont.cached ? ' cached' : ''} | ${short(cont.text, 40)}`)

// ---- batch (4 urls, mixed success/failure) ----
console.log('\n=== batch (4 urls) ===')
const bt = await batchTool.execute({ urls: ['https://example.com/', 'https://www.ruanyifeng.com/blog/', 'https://zh.wikipedia.org/wiki/JavaScript', 'https://www.w3.org/TR/'], maxChars: 500 })
console.log(`  ${bt.succeeded}/${bt.total} ok; failures: ${(bt.pages || []).filter((p) => p.error).map((p) => short(p.error, 50)).join(' | ') || 'none'}`)

// ---- site crawl (ruanyifeng, maxPages 5, depth 1) ----
console.log('\n=== site crawl (ruanyifeng, maxPages=5 depth=1) ===')
const st = await siteTool.execute({ url: 'https://www.ruanyifeng.com/blog/', maxPages: 5, maxDepth: 1 })
console.log(`  ${st.succeeded}/${st.total} pages${st.failed ? `, ${st.failed} failed` : ''}`)
for (const p of (st.pages || []).slice(0, 5)) console.log(`  [${p.depth}] ${short(p.title, 30)} (${p.chars}字符)`)

await m.closeBrowser().catch(() => {})
process.exit(0)
