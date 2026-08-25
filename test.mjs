// dsh-read-url self-test — zero-dependency, run: node test.mjs
import assert from 'node:assert/strict'
import * as m from './index.js'
import { looksLikeSpa, looksLikeChallenge } from './spa.js'
const { decodeBuffer, extract, smartTruncate, blockMd, inlineMd, decodeTextEntities, raceFirstSuccess, metaRefreshTarget, findNextLink } = m

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('raceFirstSuccess / proxy race logic')
{
  const slow = new Promise((res) => setTimeout(() => res({ error: 'Timeout after 15000ms or cancelled' }), 30))
  const fast = Promise.resolve({ buffer: Buffer.from('ok'), contentType: 'text/html', finalUrl: 'https://x' })
  const out = await raceFirstSuccess([slow, fast])
  assert.equal(out.success, true)
  assert.equal(out.value.buffer.toString(), 'ok')
  passed++
  console.log('  ok - first successful result wins, later failures ignored')
}
{
  const fast = Promise.resolve({ error: 'HTTP 403 Forbidden' })
  const slow = new Promise((res) => setTimeout(() => res({ buffer: Buffer.from('data'), contentType: 'text/html' }), 20))
  const out = await raceFirstSuccess([fast, slow])
  assert.equal(out.success, true)
  assert.equal(out.value.buffer.toString(), 'data')
  passed++
  console.log('  ok - slow success beats fast failure')
}
{
  const out = await raceFirstSuccess([
    Promise.resolve({ error: 'HTTP 403 Forbidden' }),
    Promise.resolve(null),
  ])
  assert.equal(out.success, false)
  assert.equal(out.failures[0].error, 'HTTP 403 Forbidden')
  assert.equal(out.failures[1], null)
  passed++
  console.log('  ok - all-fail collects failures in order')
}
{
  // Empty input must not hang forever (guards a regression to a deadlock).
  const out = await raceFirstSuccess([])
  assert.equal(out.success, false)
  assert.equal(out.failures.length, 0)
  passed++
  console.log('  ok - empty race resolves instead of hanging')
}

console.log('decodeBuffer / GBK charset')
ok('gbk meta charset decodes correctly', () => {
  const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好 in GBK
  const buf = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'utf8'),
    gbkHello,
    Buffer.from('</p></body></html>', 'utf8'),
  ])
  const { text, charset } = decodeBuffer(buf, '')
  assert.equal(charset, 'gbk')
  assert.ok(text.includes('你好'), `expected 你好 in text, got: ${text.slice(0, 80)}`)
})

ok('content-type charset wins', () => {
  const buf = Buffer.from('<html><body><p>hello</p></body></html>')
  const { charset } = decodeBuffer(buf, 'text/html; charset=utf-8')
  assert.equal(charset, 'utf-8')
})

console.log('extract / main content')
const html = `
<html lang="zh-CN"><head>
<title>示例文章 - 测试站</title>
<meta property="og:site_name" content="测试站">
</head>
<body>
<nav><a href="/">首页</a><a href="/about">关于</a></nav>
<header class="site-header"><h1>站点头部</h1></header>
<article>
<h1>文章标题</h1>
<p>第一段内容，讲了一些事情。</p>
<p>第二段内容，继续展开，<a href="https://example.com/ref">参考链接</a>在这里。</p>
<ul><li>要点一</li><li>要点二</li></ul>
<blockquote>引用一句话</blockquote>
<pre><code>const x = 1</code></pre>
</article>
<footer>页脚噪音</footer>
</body></html>`

ok('text mode returns title and clean body', () => {
  const r = extract(html, 'text')
  assert.equal(r.title, '示例文章 - 测试站')
  assert.equal(r.siteName, '测试站')
  assert.equal(r.lang, 'zh-CN')
  assert.ok(r.text.includes('第一段内容'))
  assert.ok(!r.text.includes('站点头部'), 'header noise should be removed')
  assert.ok(!r.text.includes('页脚噪音'), 'footer noise should be removed')
  assert.ok(!r.text.includes('首页'), 'nav links should be removed')
})

ok('markdown mode preserves structure', () => {
  const r = extract(html, 'markdown')
  assert.ok(r.text.includes('# 文章标题'), `expected h1 heading, got: ${r.text.slice(0, 200)}`)
  assert.ok(r.text.includes('[参考链接](https://example.com/ref)'))
  assert.ok(r.text.includes('- 要点一'))
  assert.ok(r.text.includes('> 引用一句话'))
  assert.ok(r.text.includes('```'))
})

console.log('pickMain heuristics')
ok('role=main container with nested divs is not cut short (gnu.org pattern)', () => {
  const nested = `<html><body><div id="wrap"><div id="content" role="main">
<p>第一段正文内容，讲了一些需要被提取的事情。</p>
<div class="inner"><p>嵌套 div 里的第二段内容，非贪婪匹配会在这里截断。</p>
<div class="deep"><p>更深层嵌套的第三段，验证深度计数闭合。</p></div></div>
<p>收尾段落，位于嵌套块之后，只有平衡闭合才能取到。</p>
</div></div><footer>页脚</footer></body></html>`
  const r = extract(nested, 'text')
  assert.ok(r.text.includes('第一段正文内容'), `head text extracted: ${r.text.slice(0, 80)}`)
  assert.ok(r.text.includes('嵌套 div 里的第二段'), `nested text kept: ${r.text.slice(0, 120)}`)
  assert.ok(r.text.includes('更深层嵌套的第三段'), `deeply nested text kept: ${r.text.slice(0, 160)}`)
  assert.ok(r.text.includes('收尾段落'), `text after nested block kept: ${r.text.slice(0, 200)}`)
  assert.ok(!r.text.includes('页脚'), 'footer after balanced close is excluded')
})

ok('tiny <article> falls through to <main> when present (gitlab pattern)', () => {
  const page = `<html><body>
<article><h3>订阅我们的通讯</h3><p>Stay updated.</p></article>
<main><h1>真正的页面标题</h1><p>${'主要内容段落。'.repeat(60)}</p></main>
</body></html>`
  const r = extract(page, 'text')
  assert.ok(r.text.includes('真正的页面标题'), `main content wins: ${r.text.slice(0, 80)}`)
  assert.ok(!r.text.includes('Stay updated'), 'tiny article card is not the main content')
})

ok('tiny <article> is still used when no <main> exists', () => {
  const page = `<html><body>
<article><h1>唯一文章标题</h1><p>虽然短但页面只有这个 article。</p></article>
</body></html>`
  const r = extract(page, 'text')
  assert.ok(r.text.includes('唯一文章标题'), `article kept without main fallback: ${r.text.slice(0, 80)}`)
})

ok('unbalanced role=main div degrades to body path, never returns null', () => {
  const broken = `<html><body><div role="main"><p>打开的 div 从未闭合。</p>
<p>正文第二段继续。</p></body></html>`
  const r = extract(broken, 'text')
  assert.ok(r.text.includes('正文第二段'), `body fallback works: ${r.text.slice(0, 80)}`)
})

console.log('render hints / challenge detection')
ok('byline fallback harvests author/date from meta-less body head', () => {
  const page = `<html><head><title>周刊</title></head><body><main>
<h1>科技爱好者周刊（第 409 期）</h1>
<p>作者：阮一峰</p>
<p>日期：2026年8月21日</p>
<p>${'这里是正文内容，讲了很多事情。'.repeat(80)}</p>
</main></body></html>`
  const r = extract(page, 'text')
  assert.equal(r.author, '阮一峰', `author: ${JSON.stringify(r.author)}`)
  assert.equal(r.published, '2026年8月21日', `published: ${JSON.stringify(r.published)}`)
})

ok('meta tags still win over byline fallback', () => {
  const page = `<html><head>
<meta name="author" content="元数据作者">
<meta property="article:published_time" content="2025-01-01">
</head><body><main><p>作者：正文里的作者</p><p>${'正文。'.repeat(100)}</p></main></body></html>`
  const r = extract(page, 'text')
  assert.equal(r.author, '元数据作者', `author: ${JSON.stringify(r.author)}`)
  assert.equal(r.published, '2025-01-01', `published: ${JSON.stringify(r.published)}`)
})

ok('byline fallback ignores deep-body mentions (600-char window)', () => {
  const page = `<html><body><main><p>${'正常正文段落，与作者无关。'.repeat(60)}</p>
<p>作者：文章中部提到的名字</p></main></body></html>`
  const r = extract(page, 'text')
  assert.equal(r.author, '', `deep mention must not be harvested: ${JSON.stringify(r.author)}`)
})

ok('byline fallback handles markdown mode link syntax', () => {
  const page = `<html><body><main><p>作者：[阮一峰](https://ruanyifeng.com)</p><p>${'正文。'.repeat(100)}</p></main></body></html>`
  const r = extract(page, 'markdown')
  assert.ok(!r.author.includes(']('), `markdown link syntax must not leak: ${JSON.stringify(r.author)}`)
})

ok('looksLikeChallenge detects Cloudflare interstitials, not real pages', () => {
  const cf = `<html><head><title>Just a moment...</title></head><body>
<div>Verifying you are human. This may take a few seconds.</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`
  assert.ok(looksLikeChallenge(cf), 'cloudflare page detected')
  const real = `<html><head><title>正常文章</title></head><body><main>
<p>正文讨论了网络安全与验证码技术的历史演进。</p></main></body></html>`
  assert.ok(!looksLikeChallenge(real), 'normal prose mentioning verification must not match')
})

console.log('smartTruncate / paragraph alignment')
ok('truncates at paragraph boundary', () => {
  const text = 'aaaa\n\nbbbb\n\ncccc\ndddd'
  const r = smartTruncate(text, 10)
  assert.equal(r.text, 'aaaa\n\nbbbb')
  assert.equal(r.truncated, true)
  assert.equal(r.charsTotal, 21)
})

ok('no truncation when under limit', () => {
  const r = smartTruncate('short', 100)
  assert.equal(r.truncated, false)
  assert.equal(r.text, 'short')
})

ok('hard cut when single paragraph exceeds limit', () => {
  const r = smartTruncate('abcdefghij', 5)
  assert.equal(r.text, 'abcde')
  assert.equal(r.truncated, true)
})

ok('offset continues from paragraph boundary without repeating', () => {
  const text = '一\n\n二二\n\n三三三\n\n四四四四'
  const first = smartTruncate(text, 6)
  assert.equal(first.text, '一\n\n二二')
  assert.equal(first.charsStart, 0)
  const second = smartTruncate(text, 6, first.text.length)
  assert.equal(second.text, '三三三')
  assert.equal(second.charsStart, 5)
  assert.ok(!second.text.includes('一'), 'offset read must not repeat earlier content')
})

ok('offset beyond end returns empty, never repeats the head', () => {
  const r = smartTruncate('一二三四五', 10, 999)
  assert.equal(r.text, '')
  assert.equal(r.charsReturned, 0)
  assert.equal(r.truncated, false)
})

console.log('inline markdown')
ok('escapes special chars in plain text', () => {
  assert.equal(inlineMd('a *b* and `c`'), 'a \\*b\\* and \\`c\\`')
})

ok('table separator row handles escaped pipes', () => {
  const md = blockMd('<table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td><td>2</td></tr></table>')
  const lines = md.trim().split('\n')
  const last = lines[lines.length - 1]
  assert.ok(last.includes('|'), `separator line present: ${last}`)
  assert.ok(!last.includes('\\'), `separator must not carry escaped-pipe backslashes: ${last}`)
})

console.log('noise stripping / hidden containers')
ok('removes entity-escaped style inside textarea (baidu pattern)', () => {
  const html = '<html><head><title>测试</title></head><body><textarea id="s_is_result_css" style="display:none;">&lt;style data-for=&quot;result&quot;&gt;html{font-size:100px}body{color:#333}.foo{color:red}&lt;/style&gt;</textarea><article><h1>真标题</h1><p>真实正文段落。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.text.includes('真标题'), 'real content must survive')
  assert.ok(r.text.includes('真实正文段落'))
  assert.ok(!r.text.includes('font-size'), `CSS noise must be gone, got: ${r.text.slice(0, 200)}`)
  assert.ok(!r.text.includes('color:#333'))
  assert.ok(r.text.length < 200, 'noise-free output must be small')
})

ok('removes HTML comments and decodes entities', () => {
  const html = '<html><head><title>测试</title></head><body><article><h1>标题</h1><!-- 调查 排行 --><p>价格 &nbsp; 与 &quot;质量&quot; 的对比 &amp; 分析</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(!r.text.includes('调查'), 'comment text must be stripped')
  assert.ok(!r.text.includes('-->'), 'comment markers must be stripped')
  assert.ok(r.text.includes('价格 与 "质量" 的对比 & 分析'), `entities must decode, got: ${r.text.slice(-60)}`)
})

ok('prefers bare <main> over whole <body> (doc sites: VitePress/MDN)', () => {
  const html = '<html><head><title>Doc</title></head><body><nav>菜单 本页目录 赞助位</nav><main><h1>正文标题</h1><p>文档真实内容段落。</p></main><footer>版权</footer></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.text.includes('正文标题'), 'main content must survive')
  assert.ok(r.text.includes('文档真实内容段落'))
  assert.ok(!r.text.includes('菜单'), `top nav must be excluded, got: ${r.text.slice(0, 120)}`)
  assert.ok(!r.text.includes('赞助位'), 'outline noise must be excluded')
})

ok('aggregates multiple article blocks (blog homepage pattern)', () => {
  const html = '<html><head><title>博客园</title></head><body><nav>导航</nav>' +
    '<article class="post-item"><h1>文章A</h1><p>内容A内容A内容A</p></article>' +
    '<article class="post-item"><h1>文章B</h1><p>内容B内容B内容B</p></article>' +
    '<footer>页脚</footer></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.text.includes('文章A'), 'first article must be present')
  assert.ok(r.text.includes('文章B'), 'second article must be present')
  assert.ok(!r.text.includes('导航'), 'nav must be stripped')
  assert.ok(!r.text.includes('页脚'), 'footer must be stripped')
})

ok('markdown mode also strips hidden style containers', () => {
  const html = '<html><head><title>测试</title></head><body><textarea>&lt;style&gt;.x{display:none}&lt;/style&gt;</textarea><article><h1>标题</h1><p>正文</p></article></body></html>'
  const r = extract(html, 'markdown')
  assert.ok(r.text.includes('# 标题'))
  assert.ok(!r.text.includes('display:none'))
  assert.ok(!r.text.includes('.x{'))
})

console.log('entities / extended named decoding')
ok('decodes extended named entities (dashes, quotes, symbols)', () => {
  assert.equal(decodeTextEntities('A &mdash; B &hellip; &copy; 2026'), 'A — B … © 2026')
  assert.equal(decodeTextEntities('&ldquo;引号&rdquo; &ensp;&ensp; &middot;'), '“引号”    ·')
  assert.equal(decodeTextEntities('100&deg;C &plusmn; 5 &times; 3 &divide; 2'), '100°C ± 5 × 3 ÷ 2')
  assert.equal(decodeTextEntities('&sup2; &frac12; &euro;99 &yen;100'), '² ½ €99 ¥100')
  assert.equal(decodeTextEntities('&ndash;&rsquo;&lsquo;&raquo;&laquo;'), '–\u2019\u2018»«')
  assert.equal(decodeTextEntities('no entities here'), 'no entities here')
  assert.equal(decodeTextEntities('&unknownxyz;'), '&unknownxyz;')
})

console.log('config / tool registration')
ok('apply merges config and registers both tools', () => {
  const tools = []
  const fakeCtx = {
    tools: { register: (t) => tools.push(t) },
    effect: () => {},
    get: () => undefined,
  }
  m.apply(fakeCtx, { maxChars: 8000, maxLinks: 5, timeoutMs: 9000 })
  const names = tools.map((t) => t.name)
  assert.ok(names.includes('read_url'), `expected read_url, got ${names.join(',')}`)
  assert.ok(names.includes('read_url_links'), `expected read_url_links, got ${names.join(',')}`)
  assert.ok(names.includes('read_url_batch'), `expected read_url_batch, got ${names.join(',')}`)
  const read = tools.find((t) => t.name === 'read_url')
  assert.ok(read.parameters.properties.maxChars.description.includes('default from plugin config'), 'read_url maxChars description must stay static (KV-cache friendly)')
  assert.ok(!read.parameters.properties.maxChars.description.includes('8000'), 'no dynamic config value should leak into schema')
  const links = tools.find((t) => t.name === 'read_url_links')
  assert.ok(links.parameters.properties.limit.description.includes('default from plugin config'))
  assert.ok(!links.parameters.properties.limit.description.includes('default 5'))
})

ok('pipeline timeout budgets cover the configured worst case and scale with cfg', () => {
  const run = (config) => {
    const tools = []
    m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, config)
    return Object.fromEntries(tools.map((t) => [t.name, t]))
  }
  const by = run({})
  // default cfg.timeoutMs=15s, paginateMax=3: (3+1) fetches + SPA render (30s goto + 10s poll)
  assert.ok(by.read_url.timeoutMs >= 105000, `read_url budget ${by.read_url.timeoutMs} must cover 4 fetches + 40s render`)
  assert.ok(by.read_url_links.timeoutMs >= 60000, `read_url_links budget ${by.read_url_links.timeoutMs} must cover render fallback`)
  // worst chain: 3 concurrency waves of (fetch + render)
  assert.ok(by.read_url_batch.timeoutMs >= 180000, `read_url_batch budget ${by.read_url_batch.timeoutMs} must cover 3 waves`)
  // crawl: 25 waves of paired fetches
  assert.ok(by.read_url_site.timeoutMs >= 375000, `read_url_site budget ${by.read_url_site.timeoutMs} must cover crawl waves`)
  // budgets scale with a longer configured fetch timeout (never clamp it)
  const big = run({ timeoutMs: 60000 })
  assert.ok(big.read_url.timeoutMs >= 285000, `read_url budget ${big.read_url.timeoutMs} must scale with timeoutMs=60s`)
  assert.ok(big.read_url_batch.timeoutMs >= 315000, `read_url_batch budget ${big.read_url_batch.timeoutMs} must scale with timeoutMs=60s`)
  // and clamp instead of exploding on a runaway value
  const capped = run({ timeoutMs: 999999 })
  assert.ok(capped.read_url.timeoutMs <= 525000, `timeoutMs clamped before budget math, got ${capped.read_url.timeoutMs}`)
  // pagination disabled: budget drops back to single-fetch + render
  const nopage = run({ paginate: false })
  assert.ok(nopage.read_url.timeoutMs <= 60000, `paginate:false budget ${nopage.read_url.timeoutMs} must not carry pagination pages`)
})

ok('all four tools declare isConcurrencySafe for parallel fan-out', () => {
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
  const names = ['read_url', 'read_url_links', 'read_url_batch', 'read_url_site']
  for (const n of names) {
    const t = tools.find((t) => t.name === n)
    assert.ok(t, `tool ${n} registered`)
    assert.equal(typeof t.isConcurrencySafe, 'function', `${n} must declare isConcurrencySafe`)
    assert.equal(t.isConcurrencySafe({}), true, `${n}.isConcurrencySafe must return exactly true`)
  }
})

{
  // top-level await block (not the sync ok() wrapper): async assertions must
  // actually block the runner or failures would be swallowed.
  const http = await import('node:http')
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(`<html><body><main><h1>并发页</h1>${'<p>并发正文段落，验证共享缓存与提取器在交叠调用下不串扰。</p>'.repeat(60)}</main></body></html>`)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}/`
  const ctx = { tools: { register: () => {} }, effect: () => {}, get: () => undefined }
  m.apply(ctx, {})
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => m.readUrl({ url: `${base}?v=${i}`, maxChars: 2000 }, ctx, undefined, undefined)),
  )
  server.close()
  for (const r of results) {
    assert.ok(!r.error, `concurrent read ok: ${JSON.stringify(r).slice(0, 80)}`)
    assert.ok(r.text.includes('并发正文段落'), `body extracted: ${(r.text || '').slice(0, 60)}`)
    assert.ok(r.text.includes('并发页'), `title in block: ${(r.text || '').slice(0, 60)}`)
  }
  // overlapping misses may double-fetch the same URL — harmless; but every
  // result must carry its OWN body, never another call's data.
  assert.ok(hits >= 6, `all distinct URLs fetched: ${hits}`)
  passed++
  console.log('  ok - concurrent read_url calls share state safely (cache race smoke)')
}

ok('cordis.patch.yml numeric strings are coerced and clamped, not concatenated', () => {
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, { timeoutMs: '25000', maxChars: '8000' })
  const read = tools.find((t) => t.name === 'read_url')
  // '25000' as a string would make the budget '2500045000'; coerced it is 25000*4+45000
  assert.equal(read.timeoutMs, 145000, `string '25000' must not concatenate into the budget, got ${read.timeoutMs}`)
  assert.equal(typeof read.timeoutMs, 'number')
})

ok('tool descriptions stay compact & static (KV-cache friendly)', () => {
  const tools = []
  const fakeCtx = { tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }
  m.apply(fakeCtx, {})
  let total = 0
  for (const t of tools) {
    assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name} has description`)
    assert.ok(!t.description.includes('${'), `${t.name} description must be static (no dynamic values)`)
    total += t.description.length
  }
  assert.ok(total < 1150, `4 descriptions total ${total} chars (budget 1150)`)
})

ok('parameter schemas stay compact (fixed per-call cost)', () => {
  const tools = []
  const fakeCtx = { tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }
  m.apply(fakeCtx, {})
  let schemaTotal = 0
  for (const t of tools) {
    schemaTotal += JSON.stringify(t.parameters).length
  }
  assert.ok(schemaTotal < 2000, `4 parameter schemas total ${schemaTotal} chars (budget 2000)`)
})

{
  // Strict cordis hosts throw on ctx.get for non-injected services (seen with
  // 'settings' in the wild): the web seam must degrade to direct fetch, and the
  // tool must return an error object instead of propagating the throw.
  const boomCtx = {
    tools: { register: () => {} },
    effect: () => {},
    get: () => { throw new Error('cannot get property "web" without inject') },
  }
  const r = await m.readUrl({ url: 'https://no-such-host-dsh-test.invalid/x', maxChars: 500 }, boomCtx)
  assert.ok(r && typeof r.error === 'string', `must return {error} instead of throwing: ${JSON.stringify(r)}`)
  passed++
  console.log('  ok - throwing web seam (strict host) degrades to direct fetch')
}

{
  // robustness: tools must never throw on missing/empty args (defensive)
  const tools = []
  const fakeCtx = { tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }
  m.apply(fakeCtx, {})
  let allSafe = true
  for (const t of tools) {
    try { await t.execute(undefined, {}) } catch { allSafe = false }
    try { await t.execute(null, {}) } catch { allSafe = false }
  }
  assert.ok(allSafe, 'all tools tolerate undefined/null args without throwing')
  passed++
  console.log('  ok - tools tolerate missing/empty args without throwing')
}

console.log('SPA detection')
ok('detects script-heavy SPA skeleton', () => {
  const spa = '<html><head></head><body><div id="app"></div>' + '<script src="/a.js"></script>'.repeat(8) + '</body></html>'
  assert.equal(looksLikeSpa(spa), true)
})

ok('threshold: 5 scripts needed, 4 is not SPA', () => {
  assert.equal(looksLikeSpa('<script src="/a.js"></script>'.repeat(4)), false)
  assert.equal(looksLikeSpa('<script src="/a.js"></script>'.repeat(5)), true)
  assert.equal(looksLikeSpa('no scripts here'), false)
})

ok('does not flag normal pages as SPA', () => {
  const normal = '<html><body><article><h1>Title</h1><p>Body text.</p></article><script src="/s.js"></script></body></html>'
  assert.equal(looksLikeSpa(normal), false)
})

{
  // SPA page with no playwright render path available (render fails / missing):
  // must degrade with a hint, never crash. Uses top-level await so the assertion
  // is guaranteed to run before the process exits.
  const html = '<html><head><title>SPA Test</title></head><body><div id="app"></div>' + '<script src="/x.js"></script>'.repeat(8) + '</body></html>'
  const fakeSeam = { fetch: async (u) => ({ content: html, url: u }) }
  const fakeCtx = { get: (k) => (k === 'web' ? fakeSeam : undefined) }
  const r = await m.readUrl({ url: 'https://spa.example.com', maxChars: 500 }, fakeCtx)
  assert.ok(!r.error, 'must not throw')
  assert.ok(r.spaHint || !r.text, `should carry spaHint or empty text, got hint=${r.spaHint}`)
  passed++
  console.log('  ok - readUrl on SPA page degrades gracefully with hint')
}

{
  const html = '<html><head><title>SPA</title></head><body><div id="app"></div>' + '<script src="/x.js"></script>'.repeat(8) + '</body></html>'
  const fakeSeam = { fetch: async (u) => ({ content: html, url: u }) }
  const fakeCtx = { tools: { register: () => {} }, effect: () => {}, get: (k) => (k === 'web' ? fakeSeam : undefined) }
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: fakeCtx.get }, {})
  const linksTool = tools.find((t) => t.name === 'read_url_links')
  const r = await linksTool.execute({ url: 'https://spa.example.com' })
  assert.ok(!r.error, 'must not throw when render unavailable')
  assert.equal(r.count, 0, 'static SPA skeleton has no links; fallback hint path taken')
  passed++
  console.log('  ok - read_url_links on SPA page falls back to static links')
}

{
  // extractLinks dedupe: repeated URLs (nav bars) must collapse to one entry
  const html = '<html><body><a href="/page1">一</a><a href="/page1">二</a><a href="/page1">三</a><a href="/page2">四</a><a href="/page2">五</a></body></html>'
  const fakeSeam = { fetch: async (u) => ({ content: html, url: u }) }
  const fakeCtx = { tools: { register: () => {} }, effect: () => {}, get: (k) => (k === 'web' ? fakeSeam : undefined) }
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: fakeCtx.get }, {})
  const linksTool = tools.find((t) => t.name === 'read_url_links')
  const r = await linksTool.execute({ url: 'https://dup.example.com' })
  assert.equal(r.count, 2, `duplicate URLs must be deduped, got ${r.count}`)
  assert.ok(r.links.every((l) => l.url.includes('page1') || l.url.includes('page2')))
  passed++
  console.log('  ok - read_url_links dedupes repeated URLs')
}

console.log('read_url_batch (local server, real fetch)')
{
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/a') res.end('<html><head><title>页面A</title></head><body><article><h1>A</h1><p>这是页面 A 的正文内容。</p></article></body></html>')
    else if (req.url === '/b') res.end('<html><head><title>页面B</title></head><body><article><h1>B</h1><p>这是页面 B 的正文内容，有第二段补充。</p></article></body></html>')
    else {
      res.statusCode = 404
      res.end('<html><body>not found</body></html>')
    }
  })
  await new Promise((r) => server.listen(18095, r))
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
  const batch = tools.find((t) => t.name === 'read_url_batch')
  assert.ok(batch, 'read_url_batch tool registered')
  assert.ok(batch.parameters.required.includes('urls'), 'urls is required')
  const base = 'http://127.0.0.1:18095'

  // NOTE: these run as top-level awaits (not inside sync ok()) so server.close()
  // happens only after all assertions have actually executed.
  {
    const r = await batch.execute({ urls: [`${base}/a`, `${base}/b`, `${base}/missing`], maxChars: 500 })
    assert.equal(r.total, 3)
    assert.equal(r.succeeded, 2)
    assert.equal(r.failed, 1)
    const pa = r.pages[0]
    assert.ok(!pa.error && pa.title === '页面A' && pa.text.includes('页面 A 的正文'), `page A ok: ${JSON.stringify(pa).slice(0, 80)}`)
    assert.ok(!r.pages[1].error && r.pages[1].title === '页面B')
    const pe = r.pages[2]
    assert.ok(pe.error && pe.url.includes('/missing'), '404 page isolated with error')
    const text = batch.output.render(null, r)[0].text
    assert.ok(text.includes('读取 2/3 页成功'), `render summary: ${text.slice(0, 60)}`)
    assert.ok(text.includes('[失败]'), 'render marks failures')
    assert.ok(text.includes('--- 页面A'), 'render marks each page')
    passed++
    console.log('  ok - parallel read with per-page error isolation')
  }

  {
    const r2 = await batch.execute({ urls: [`${base}/a`, `${base}/b`], maxChars: 500 })
    assert.equal(r2.succeeded, 2)
    assert.ok(r2.pages.every((p) => p.cached === true), `all cached: ${JSON.stringify(r2.pages.map((p) => p.cached))}`)
    passed++
    console.log('  ok - batch reuses readUrl session cache')
  }

  {
    const many = Array.from({ length: 15 }, (_, i) => `${base}/a`)
    const r = await batch.execute({ urls: many, maxChars: 300 })
    assert.equal(r.total, 10, 'only first 10 URLs are read')
    passed++
    console.log('  ok - caps url list at 10')
  }

  {
    // Error caching: a failing URL must be served from cache on repeat (30s TTL),
    // so the model never loops re-fetching a broken URL. Use a fresh path so the
    // earlier batch test (which already fetched /missing) doesn't pre-warm it.
    const bad = `${base}/missing2`
    const e1 = await m.readUrl({ url: bad, maxChars: 300 }, undefined, undefined, undefined)
    assert.ok(e1.error, 'first hit errors')
    assert.ok(!e1.cached, 'first hit is not cached')
    const e2 = await m.readUrl({ url: bad, maxChars: 300 }, undefined, undefined, undefined)
    assert.ok(e2.error && e2.cached === true, `repeat hit served from cache: ${JSON.stringify(e2)}`)
    passed++
    console.log('  ok - failed URLs are served from error cache (no re-fetch loop)')
  }

  server.close()
}

console.log('read_url_site (local multi-page site, real fetch)')
{
  // Small local site: / links to /a, /b and an external + noise links;
  // /a links deeper to /c; /broken 404s. Tests scope/dedup/noise/max/depth.
  const http = await import('node:http')
  const page = (title, body, extra = '') =>
    `<html><head><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p>${extra}</body></html>`
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/') res.end(page('首页', '站点入口页。', '<a href="/a">去A</a> <a href="/b">去B</a> <a href="https://external.com/x">站外</a> <a href="/login">登录(噪音)</a> <a href="/logo.png">图片(噪音)</a>'))
    else if (req.url === '/a') res.end(page('页面A', 'A 的内容。', '<a href="/c">去C</a> <a href="/">回首页</a>'))
    else if (req.url === '/b') res.end(page('页面B', 'B 的内容。', '<a href="/">回首页</a>'))
    else if (req.url === '/c') res.end(page('页面C', 'C 的内容，在深度2。', '<a href="/b">去B</a>'))
    else if (req.url === '/login') res.end(page('登录', '登录页'))
    else { res.statusCode = 404; res.end('<html><body>not found</body></html>') }
  })
  await new Promise((r) => server.listen(18096, r))
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
  const site = tools.find((t) => t.name === 'read_url_site')
  assert.ok(site, 'read_url_site tool registered')
  const base = 'http://127.0.0.1:18096'

  {
    // Default: maxPages 15, depth 2. Discovers /, /a, /b, /c; skips external,
    // /login (noise), /logo.png (noise); /broken is not linked so never hit.
    const r = await site.execute({ url: `${base}/`, includeContent: true })
    assert.equal(r.error, undefined, `no error: ${JSON.stringify(r).slice(0, 120)}`)
    const urls = r.pages.map((p) => p.url)
    assert.ok(urls.includes(`${base}/`), `entry crawled: ${urls.join(',')}`)
    assert.ok(urls.includes(`${base}/a`) && urls.includes(`${base}/b`), 'siblings crawled')
    assert.ok(urls.includes(`${base}/c`), 'depth-2 page crawled')
    assert.ok(!urls.some((u) => u.includes('external.com')), 'external link not followed')
    assert.ok(!urls.some((u) => u.includes('/login')), 'auth noise path skipped')
    assert.ok(!urls.some((u) => u.includes('.png')), 'asset noise skipped')
    assert.equal(r.failed, 0)
    const pageC = r.pages.find((p) => p.url.endsWith('/c'))
    assert.equal(pageC.depth, 2)
    const home = r.pages.find((p) => p.url === `${base}/`)
    assert.ok(home.text && home.text.length > 0, 'includeContent attaches summary')
    const text = site.output.render(null, r)[0].text
    assert.ok(text.includes('爬取 4/4 页'), `render summary: ${text.slice(0, 40)}`)
    assert.ok(text.includes('[2] 页面C'), 'render shows depth')
    passed++
    console.log('  ok - site crawl: scope/dedup/noise/depth/includeContent/render')
  }

  {
    // maxPages cap: force a tiny cap so the crawl stops early.
    const r = await site.execute({ url: `${base}/`, maxPages: 2 })
    assert.ok(r.succeeded <= 2, `capped at maxPages: ${r.succeeded}`)
    assert.equal(r.total, r.succeeded, 'no failures in capped run')
    passed++
    console.log('  ok - site crawl honors maxPages')
  }

  {
    // maxDepth=1: entry + direct links only, no /c.
    const r = await site.execute({ url: `${base}/`, maxDepth: 1 })
    assert.ok(!r.pages.some((p) => p.url.endsWith('/c')), 'depth cap stops at 1')
    assert.ok(r.pages.some((p) => p.url.endsWith('/b')), 'direct links crawled')
    passed++
    console.log('  ok - site crawl honors maxDepth')
  }

  {
    // Failure isolation: entry that 404s is recorded, not fatal.
    const r = await site.execute({ url: `${base}/broken`, maxPages: 5 })
    assert.equal(r.succeeded, 0)
    assert.equal(r.failed, 1)
    assert.ok(r.failures[0].url.endsWith('/broken'), 'failure recorded with url')
    passed++
    console.log('  ok - site crawl isolates failures')
  }

  server.close()
}

console.log('charset / encoding')
ok('UTF-16LE BOM detected and decoded', () => {
  const body = '<html><body><p>你好世界</p></body></html>'
  const utf16 = Buffer.from('\ufeff' + body, 'utf16le')
  const { text, charset } = decodeBuffer(utf16, '')
  assert.equal(charset, 'utf-16le')
  assert.ok(text.includes('你好世界'), `decoded text: ${text.slice(0, 60)}`)
})

ok('Shift-JIS meta charset decodes Japanese', () => {
  // こんにちは in Shift-JIS bytes + a Shift_JIS meta declaration
  const sjis = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd])
  const buf = Buffer.concat([
    Buffer.from('<html><head><meta charset="Shift_JIS"></head><body><p>', 'latin1'),
    sjis,
    Buffer.from('</p></body></html>', 'latin1'),
  ])
  const { text, charset } = decodeBuffer(buf, '')
  assert.equal(charset, 'shift_jis')
  assert.ok(text.includes('こんにちは'), `decoded text: ${text.slice(0, 60)}`)
})

console.log('text-density fallback (body path)')
ok('densityFilter drops link-dominated segments, keeps prose', () => {
  const html =
    '<div><a href="/n1">新闻一</a> <a href="/n2">新闻二</a> <a href="/n3">新闻三</a></div>' +
    '<div><a href="/h1">热门推荐一</a> <a href="/h2">热门推荐二</a></div>' +
    '<p>这是正文的第一段，包含足够多的文字来表明它是正文内容。</p>' +
    '<p>这是正文的第二段，同样有实实在在的文字密度。</p>'
  const out = m.densityFilter(html)
  assert.ok(out.includes('正文的第一段'), 'prose paragraphs survive')
  assert.ok(out.includes('正文第二段') || out.includes('正文的第二段'), 'second paragraph survives')
  assert.ok(!out.includes('热门推荐'), `link widget dropped, got: ${out.slice(0, 120)}`)
  assert.ok(!out.includes('新闻一'), 'nav links dropped')
})

ok('article/main pages bypass densityFilter (no behavior change)', () => {
  const html = '<html><body><article><p>正文文字在这里。</p><ul><li><a href="/x">相关链接一</a></li></ul></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.text.includes('正文文字'), 'article content survives')
})

console.log('pagination')
ok('findNextLink: rel=next wins', () => {
  const html = '<html><body><a href="/p2" rel="next">go on</a></body></html>'
  assert.equal(m.findNextLink(html, 'https://x.com/p1'), 'https://x.com/p2')
})

ok('findNextLink: 下一页 text anchor matched, relative resolved', () => {
  const html = '<html><body><a href="?page=2">下一页</a></body></html>'
  assert.equal(m.findNextLink(html, 'https://x.com/p1'), 'https://x.com/p1?page=2')
})

ok('findNextLink: ordinary links never match', () => {
  const html = '<html><body><a href="/about">关于下一页主题的讨论</a><a href="/next-level">高级</a></body></html>'
  assert.equal(m.findNextLink(html, 'https://x.com/'), null)
})

console.log('truncation / compact render / pagination variants')
ok('smartTruncate: oversized paragraph degrades to sentence alignment, not hard slice', () => {
  // One huge paragraph after offset 0 — must cut at a sentence boundary.
  const sentences = Array.from({ length: 30 }, (_, i) => `这是第${i}句话。`).join('')
  const r = smartTruncate(sentences, 33)
  assert.ok(r.text.endsWith('。'), `sentence-aligned cut: ...${r.text.slice(-12)}`)
  assert.ok(r.text.length <= 33, `within budget: ${r.text.length}`)
})

ok('smartTruncate: sentence fallback still terminates on a single giant sentence', () => {
  const r = smartTruncate('一'.repeat(100), 10)
  assert.equal(r.text.length, 10)
})

ok('compactJson: no indentation, long string values clipped with marker', () => {
  const out = m.compactJson({ a: 1, html: 'x'.repeat(2000), list: [{ b: 'ok' }] })
  assert.ok(!out.includes('\n'), 'single-line render')
  assert.ok(out.includes('…[+500 chars]'), 'clip marker present')
  assert.ok(out.includes('"b":"ok"'), 'nested values kept')
})

ok('compactJson: short JSON passes through unchanged', () => {
  assert.equal(m.compactJson({ a: [1, 2] }), '{"a":[1,2]}')
})

console.log('adversarial input handling')
ok('extract: pathological unclosed-tag pages stay bounded', () => {
  // Bounded scanning keeps pathological inputs well inside the tool budget.
  const t0 = Date.now()
  const r = m.extract(`<body>${'<div>'.repeat(10000)}</body>`, 'text')
  const ms = Date.now() - t0
  assert.ok(ms < 900, `pathological divs finished in ${ms}ms`)
  assert.ok(typeof r.text === 'string')
})

ok('extract: img/style/article bombs stay bounded', () => {
  const t0 = Date.now()
  m.extract('<img'.repeat(10000) + '<p>x</p>', 'markdown')
  m.extract('<style'.repeat(10000) + '<p>x</p>', 'text')
  m.extract('<article'.repeat(10000) + '<p>x</p>', 'text')
  const ms = Date.now() - t0
  assert.ok(ms < 3000, `three bombs finished in ${ms}ms`)
})

ok('prose "a < b" survives entity decoding', () => {
  const r = m.extract('<body><p>x &lt; y 且 a &lt; b 结尾</p></body>', 'text')
  assert.ok(r.text.includes('x < y'), `kept: ${r.text}`)
})

ok('compactJson: extreme nesting degrades instead of crashing', () => {
  let v = 'x'
  for (let i = 0; i < 5000; i++) v = { a: v }
  const out = m.compactJson(v)
  assert.ok(typeof out === 'string' && out.length > 0)
})


ok('findNextLink: arrow-wrapped and traditional variants matched', () => {
  assert.equal(m.findNextLink('<a href="/n1">下一页 ›</a>', 'https://x.com/a'), 'https://x.com/n1')
  assert.equal(m.findNextLink('<a href="/n2">Next »</a>', 'https://x.com/a'), 'https://x.com/n2')
  assert.equal(m.findNextLink('<a href="/n3">下一頁</a>', 'https://x.com/a'), 'https://x.com/n3')
})


{
  // e2e: 3-page article auto-joined, plus cap enforcement.
  const http = await import('node:http')
  const page = (n, next) =>
    `<html><head><title>长文（${n}/3）</title></head><body><p>第${n}页的正文内容。${'内容填充。'.repeat(30)}</p>${next ? `<a href="/pg${next}">下一页</a>` : ''}</body></html>`
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/pg1') res.end(page(1, 2))
    else if (req.url === '/pg2') res.end(page(2, 3))
    else if (req.url === '/pg3') res.end(page(3, null))
    else { res.statusCode = 404; res.end('x') }
  })
  await new Promise((r) => server.listen(18097, r))
  const base = 'http://127.0.0.1:18097'
  {
    const r = await m.readUrl({ url: `${base}/pg1`, maxChars: 20000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `no error: ${JSON.stringify(r).slice(0, 100)}`)
    assert.equal(r.paginated, 3, `3 pages joined, got paginated=${r.paginated}`)
    assert.ok(r.text.includes('第1页的正文'), 'page 1 content present')
    assert.ok(r.text.includes('第2页的正文'), 'page 2 content present')
    assert.ok(r.text.includes('第3页的正文'), 'page 3 content present')
    passed++
    console.log('  ok - auto-pagination joins 3 pages into one body')
  }
  {
    // paginateMax=2: only one continuation page followed.
    const r2 = await m.readUrl({ url: `${base}/pg2`, maxChars: 20000 }, undefined, undefined, { paginateMax: 2, timeoutMs: 15000, maxBytes: 3145728, maxChars: 6000, maxLinks: 20, cacheTtlMs: 300000, cacheMax: 32, spaRender: false, userAgent: 'ua', paginate: true })
    assert.equal(r2.paginated, 2, `capped at 2 pages, got ${r2.paginated}`)
    assert.ok(r2.text.includes('第2页') && r2.text.includes('第3页'), 'both fetched pages present')
    passed++
    console.log('  ok - paginateMax caps the chain')
  }
  {
    // paginate:false: single page, no following.
    const r3 = await m.readUrl({ url: `${base}/pg3`, maxChars: 20000 }, undefined, undefined, { paginate: false, timeoutMs: 15000, maxBytes: 3145728, maxChars: 6000, maxLinks: 20, cacheTtlMs: 300000, cacheMax: 32, spaRender: false, userAgent: 'ua', paginateMax: 3 })
    assert.equal(r3.paginated, undefined, 'no pagination when disabled')
    passed++
    console.log('  ok - paginate:false disables following')
  }
  server.close()
}

console.log('JSON / RSS / retry')
{
  const http = await import('node:http')
  let retryHits = 0
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>示例订阅源</title>` +
    `<item><title>文章一</title><link>https://example.com/1</link><description>第一篇的摘要内容。</description></item>` +
    `<item><title>文章二</title><link>https://example.com/2</link><description>第二篇的摘要内容。</description></item>` +
    `</channel></rss>`
  const server = http.createServer((req, res) => {
    if (req.url === '/api') {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ name: 'dsh-read-url', version: '1.0.0', tools: ['read_url'] }))
    } else if (req.url === '/feed') {
      res.setHeader('content-type', 'application/rss+xml')
      res.end(rss)
    } else if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml')
      res.end('<?xml version="1.0"?><urlset><url><loc>https://x.com/</loc></url></urlset>')
    } else if (req.url === '/ratelimited') {
      retryHits++
      if (retryHits === 1) {
        res.statusCode = 429
        res.setHeader('retry-after', '0')
        res.end('slow down')
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end('<html><head><title>重试成功</title></head><body><p>重试之后的正文。</p></body></html>')
      }
    } else { res.statusCode = 404; res.end('x') }
  })
  await new Promise((r) => server.listen(18098, r))
  const base = 'http://127.0.0.1:18098'
  {
    const r = await m.readUrl({ url: `${base}/api`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `json read ok: ${JSON.stringify(r).slice(0, 80)}`)
    assert.equal(r.mode, 'json')
    assert.ok(r.text.includes('"dsh-read-url"'), `pretty json body, got: ${r.text.slice(0, 80)}`)
    passed++
    console.log('  ok - JSON API URL rendered compact')
  }
  {
    const r = await m.readUrl({ url: `${base}/feed`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `feed read ok: ${JSON.stringify(r).slice(0, 80)}`)
    assert.equal(r.feedCount, 2)
    assert.ok(r.title.includes('示例订阅源'), `feed title: ${r.title}`)
    assert.ok(r.text.includes('文章一 — https://example.com/1'), `feed items listed: ${r.text.slice(0, 100)}`)
    passed++
    console.log('  ok - RSS feed parsed into entry list')
  }
  {
    const r = await m.readUrl({ url: `${base}/sitemap.xml`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(r.error && r.error.includes('sitemap'), `sitemap rejected: ${JSON.stringify(r).slice(0, 80)}`)
    passed++
    console.log('  ok - XML sitemap rejected with clear reason')
  }
  {
    const r = await m.readUrl({ url: `${base}/ratelimited`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `retry succeeded: ${JSON.stringify(r).slice(0, 80)}`)
    assert.ok(r.text.includes('重试之后的正文'), 'body from the second attempt')
    assert.ok(retryHits >= 2, `server was hit ${retryHits} times (retry happened)`)
    passed++
    console.log('  ok - 429 with Retry-After retried once and succeeded')
  }
  server.close()
}

console.log('markdown / metadata')
ok('markdown mode emits image alt text', () => {
  const html = '<html><body><article><p>图解如下：</p><img src="/chart.png" alt="架构图：三层结构"><img src="/spacer.gif" alt=""></article></body></html>'
  const r = extract(html, 'markdown')
  assert.ok(r.text.includes('![架构图：三层结构](/chart.png)'), `img alt kept: ${r.text.slice(0, 100)}`)
  assert.ok(!r.text.includes('spacer.gif'), 'decorative empty-alt image dropped')
})

ok('markdown code fence carries language hint', () => {
  const html = '<html><body><article><pre><code class="language-python">print(1)</code></pre></article></body></html>'
  const r = extract(html, 'markdown')
  assert.ok(r.text.includes('```python'), `language fence: ${r.text.slice(0, 80)}`)
})

ok('extract harvests published/author metadata', () => {
  const html = '<html><head><title>T</title>' +
    '<meta property="article:published_time" content="2026-08-21T10:00:00Z">' +
    '<meta name="author" content="张三"></head>' +
    '<body><article><p>正文段落。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.equal(r.published, '2026-08-21T10:00:00Z')
  assert.equal(r.author, '张三')
})

ok('empty body falls back to og:description instead of nothing', () => {
  const html = '<html><head><title>登录墙页</title><meta property="og:description" content="这篇文章的导语摘要，需要登录后阅读全文。"></head><body><div id="app"></div></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.text.includes('导语摘要'), `description fallback: ${r.text.slice(0, 60)}`)
})

console.log('feed / binary sniff')
{
  // Feed descriptions double-escape HTML; one strip-then-decode pass
  // leaves literal tags in the rendered text.
  const http = await import('node:http')
  const rss2 = `<?xml version="1.0"?><rss version="2.0"><channel><title>双转义源</title>` +
    `<item><title>带双转义描述的条目</title><link>https://example.com/d</link>` +
    `<description>摘要开头内容。&lt;a href=&#34;https://example.com/d&#34; target=&#34;_blank&#34;&gt;查看全文&lt;/a&gt;</description></item>` +
    `</channel></rss>`
  const server = http.createServer((req, res) => {
    if (req.url === '/feed2') {
      res.setHeader('content-type', 'application/rss+xml')
      res.end(rss2)
    } else if (req.url === '/bin') {
      // No content-type header on purpose: the type gate has nothing to test,
      // only the binary sniff can keep the PDF out of the HTML pipeline.
      res.end(Buffer.concat([Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'), Buffer.alloc(600, 0)]))
    } else if (req.url === '/noheader-html') {
      // No content-type but a text body: must still be read as HTML.
      res.end('<html><head><title>无头页</title></head><body><article><p>没有 content-type 头的普通 HTML 正文。</p></article></body></html>')
    } else { res.statusCode = 404; res.end('x') }
  })
  await new Promise((r) => server.listen(18099, r))
  const base = 'http://127.0.0.1:18099'
  {
    const r = await m.readUrl({ url: `${base}/feed2`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `feed2 read ok: ${JSON.stringify(r).slice(0, 80)}`)
    assert.ok(r.text.includes('查看全文'), `decoded text visible: ${r.text.slice(0, 100)}`)
    assert.ok(!r.text.includes('<a href'), `no literal tags in feed text: ${r.text.slice(0, 100)}`)
    passed++
    console.log('  ok - double-escaped feed description renders without literal tags')
  }
  {
    const r = await m.readUrl({ url: `${base}/bin`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(r.error && r.error.includes('binary'), `headerless binary rejected: ${JSON.stringify(r).slice(0, 120)}`)
    passed++
    console.log('  ok - headerless binary body rejected by sniff (no mojibake pipeline)')
  }
  {
    const r = await m.readUrl({ url: `${base}/noheader-html`, maxChars: 5000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `headerless html read ok: ${JSON.stringify(r).slice(0, 80)}`)
    assert.ok(r.text.includes('普通 HTML 正文'), `body extracted: ${r.text.slice(0, 60)}`)
    passed++
    console.log('  ok - headerless text body still read as HTML')
  }
  server.close()
}

{
  const { looksBinary } = await import('./proxy-fallback.js')
  ok('looksBinary: PDF with NUL bytes detected', () => {
    assert.equal(looksBinary(Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0)])), true)
  })
  ok('looksBinary: plain ASCII/HTML not binary', () => {
    assert.equal(looksBinary(Buffer.from('<html><body>hello world 你好</body></html>')), false)
  })
  ok('looksBinary: UTF-8 CJK text not binary', () => {
    assert.equal(looksBinary(Buffer.from('你好世界，这是正文内容。'.repeat(10))), false)
  })
  ok('looksBinary: empty buffer not binary', () => {
    assert.equal(looksBinary(Buffer.alloc(0)), false)
  })
}

ok('og:description with double-escaped tags yields clean text', () => {
  const html = '<html><head><title>墙页</title>' +
    '<meta property="og:description" content="&lt;b&gt;加粗&lt;/b&gt;的导语摘要，需登录阅读。"></head>' +
    '<body><div id="app"></div></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.text.includes('导语摘要'), `description kept: ${r.text.slice(0, 60)}`)
  assert.ok(!r.text.includes('<b>'), `no literal tags: ${r.text.slice(0, 60)}`)
})

console.log('v1.3.0: control-char entities / JSON-LD / base href / meta-refresh')
ok('&#0; and C0/C1 controls decode to space, not control chars', () => {
  assert.equal(decodeTextEntities('a&#0;b'), 'a b')
  assert.equal(decodeTextEntities('a&#127;b'), 'a b')
  assert.equal(decodeTextEntities('a&#x1F;b'), 'a b')
  assert.equal(decodeTextEntities('a&#x9F;b'), 'a b')
  assert.equal(decodeTextEntities('a&#8;b'), 'a b')
  assert.equal(decodeTextEntities('a&#14;b'), 'a b')
})
ok('\\t\\n\\r entities preserved as whitespace', () => {
  assert.equal(decodeTextEntities('a&#9;b'), 'a\tb')
  assert.equal(decodeTextEntities('a&#10;b'), 'a\nb')
  assert.equal(decodeTextEntities('a&#13;b'), 'a\rb')
})
ok('lone surrogate entity decodes to U+FFFD', () => {
  assert.equal(decodeTextEntities('a&#xD800;b'), 'a\uFFFDb')
  assert.equal(decodeTextEntities('a&#55296;b'), 'a\uFFFDb')
  assert.equal(decodeTextEntities('a&#xDFFF;b'), 'a\uFFFDb')
})
ok('extract: NUL entity never reaches body text', () => {
  const r = extract('<html><body><article><p>正文&#0;内容</p></article></body></html>', 'text')
  assert.ok(!r.text.includes('\u0000'), `no NUL in output: ${JSON.stringify(r.text)}`)
  assert.ok(r.text.includes('正文 内容'), `control replaced with space: ${JSON.stringify(r.text)}`)
})
ok('extract: markdown mode keeps entity line breaks', () => {
  const r = extract('<html><body><article><p>第一行&#10;第二行</p></article></body></html>', 'markdown')
  assert.ok(r.text.includes('第一行\n第二行') || r.text.includes('第一行 第二行'), `md line structure: ${JSON.stringify(r.text)}`)
})
ok('json-ld datePublished/author harvested (object author)', () => {
  const html = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2026-08-24T10:30:00+08:00","author":{"@type":"Person","name":"张三"}}</script></head><body><article><p>正文内容段落。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.published.startsWith('2026-08-24'), `published: ${r.published}`)
  assert.equal(r.author, '张三')
})
ok('json-ld @graph and string author handled', () => {
  const html = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"某站"},{"@type":"BlogPosting","datePublished":"2025-03-01","author":"李四"}]}</script></head><body><article><p>正文。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.published.startsWith('2025-03-01'), `published: ${r.published}`)
  assert.equal(r.author, '李四')
})
ok('json-ld broken JSON tolerated, byline fallback still works', () => {
  const html = '<html><head><script type="application/ld+json">{invalid json</script></head><body><article><p>作者：王五 日期：2026年1月2日 正文内容。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.equal(r.author, '王五', `byline author: ${r.author}`)
  assert.equal(r.published, '2026年1月2日')
})
ok('explicit article meta beats json-ld date', () => {
  const html = '<html><head><meta property="article:published_time" content="2020-01-01T00:00:00Z"><script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-08-24"}</script></head><body><article><p>正文。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.published.startsWith('2020-01-01'), `article meta wins: ${r.published}`)
})
ok('json-ld date beats generic meta date stamp', () => {
  const html = '<html><head><meta name="date" content="2020-06-06"><script type="application/ld+json">{"@type":"Article","datePublished":"2026-08-24T09:00:00+08:00"}</script></head><body><article><p>正文。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.published.startsWith('2026-08-24'), `json-ld wins over generic date: ${r.published}`)
})
ok('metaRefreshTarget: standard 0;url=...', () => {
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="0;url=https://a.com/x">', 'https://s.com/'), 'https://a.com/x')
})
ok('metaRefreshTarget: relative target resolved against document URL', () => {
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="0; url=/real">', 'https://s.com/entry'), 'https://s.com/real')
})
ok('metaRefreshTarget: attribute order and case insensitive', () => {
  assert.equal(metaRefreshTarget('<META CONTENT="0; url=https://a.com" HTTP-EQUIV="REFRESH">', 'https://s.com/'), 'https://a.com/')
})
ok('metaRefreshTarget: quoted url part', () => {
  assert.equal(metaRefreshTarget(`<meta http-equiv="refresh" content="0;url='https://a.com/q'">`, 'https://s.com/'), 'https://a.com/q')
})
ok('metaRefreshTarget: bare timed refresh without url -> null', () => {
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="5">', 'https://s.com/'), null)
})
ok('metaRefreshTarget: timed refresh with url -> null (keep the page)', () => {
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="30; url=https://a.com">', 'https://s.com/'), null)
})
ok('metaRefreshTarget: javascript: refused', () => {
  assert.equal(metaRefreshTarget('<meta http-equiv="refresh" content="0; url=javascript:alert(1)">', 'https://s.com/'), null)
})
ok('metaRefreshTarget: base href influences relative target', () => {
  const html = '<head><base href="https://cdn.example.com/sub/"></head><meta http-equiv="refresh" content="0;url=go.html">'
  assert.equal(metaRefreshTarget(html, 'https://s.com/entry'), 'https://cdn.example.com/sub/go.html')
})
ok('metaRefreshTarget: no refresh meta -> null', () => {
  assert.equal(metaRefreshTarget('<html><body><p>plain</p></body></html>', 'https://s.com/'), null)
})

{
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/base') res.end('<html><head><base href="http://127.0.0.1:18097/sub/"></head><body><article><p>框架页正文。</p></article><a href="page2.html">下一页</a></body></html>')
    else if (req.url === '/nobase') res.end('<html><head></head><body><article><p>无 base 页正文。</p></article><a href="page2.html">下一页</a></body></html>')
    else if (req.url === '/relbase') res.end('<html><head><base href="/sub/"></head><body><article><p>相对 base 正文。</p></article><a href="x.html">链接</a></body></html>')
    else { res.statusCode = 404; res.end('<html><body>not found</body></html>') }
  })
  await new Promise((r) => server.listen(18097, r))
  const base = 'http://127.0.0.1:18097'
  {
    const r = await m.readUrl({ url: `${base}/base`, includeLinks: true, maxChars: 2000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `base page read ok: ${JSON.stringify(r).slice(0, 80)}`)
    const next = (r.links || []).find((l) => l.title.includes('下一页'))
    assert.ok(next, `next link found: ${JSON.stringify(r.links)}`)
    assert.equal(next.url, 'http://127.0.0.1:18097/sub/page2.html', `resolved against base href: ${next.url}`)
    passed++
    console.log('  ok - extractLinks resolves relative hrefs against base href')
  }
  {
    const r = await m.readUrl({ url: `${base}/nobase`, includeLinks: true, maxChars: 2000 }, undefined, undefined, undefined)
    const next = (r.links || []).find((l) => l.title.includes('下一页'))
    assert.equal(next.url, `${base}/page2.html`, `no base -> document URL: ${next.url}`)
    passed++
    console.log('  ok - without base href links resolve against document URL')
  }
  {
    const r = await m.readUrl({ url: `${base}/relbase`, includeLinks: true, maxChars: 2000 }, undefined, undefined, undefined)
    const l = (r.links || []).find((x) => x.title.includes('链接'))
    assert.equal(l.url, 'http://127.0.0.1:18097/sub/x.html', `relative base resolved against document host: ${l.url}`)
    passed++
    console.log('  ok - relative base href resolves against document host')
  }
  server.close()
}

{
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/shell') res.end('<html><head><meta http-equiv="refresh" content="0;url=/real"></head><body>跳转中…</body></html>')
    else if (req.url === '/real') res.end('<html><head><title>真实页</title></head><body><article><p>这是壳页后面的真实正文内容。</p></article></body></html>')
    else if (req.url === '/hop1') res.end('<html><head><meta http-equiv="refresh" content="0; url=/hop2"></head><body>hop1</body></html>')
    else if (req.url === '/hop2') res.end('<html><head><meta http-equiv="refresh" content="0;url=/real"></head><body>hop2</body></html>')
    else if (req.url === '/loop') res.end('<html><head><meta http-equiv="refresh" content="0;url=/loop2"></head><body>loop1</body></html>')
    else if (req.url === '/loop2') res.end('<html><head><meta http-equiv="refresh" content="0;url=/loop"></head><body>loop2</body></html>')
    else if (req.url === '/deadend') res.end('<html><head><meta http-equiv="refresh" content="0;url=/missing404"></head><body>跳板页自身内容。</body></html>')
    else { res.statusCode = 404; res.end('<html><body>not found</body></html>') }
  })
  await new Promise((r) => server.listen(18098, r))
  const base = 'http://127.0.0.1:18098'
  {
    const r = await m.readUrl({ url: `${base}/shell`, maxChars: 2000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `no error: ${JSON.stringify(r).slice(0, 100)}`)
    assert.equal(r.url, `${base}/real`, `finalUrl reflects target: ${r.url}`)
    assert.ok(r.text.includes('真实正文'), `followed body: ${r.text.slice(0, 60)}`)
    passed++
    console.log('  ok - readUrl follows meta-refresh shell to real page')
  }
  {
    const r = await m.readUrl({ url: `${base}/hop1`, maxChars: 2000 }, undefined, undefined, undefined)
    assert.ok(!r.error)
    assert.equal(r.url, `${base}/real`)
    assert.ok(r.text.includes('真实正文'), '2-hop chain followed')
    passed++
    console.log('  ok - readUrl follows 2-hop meta-refresh chain')
  }
  {
    const r = await m.readUrl({ url: `${base}/loop`, maxChars: 2000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `loop terminates without error: ${JSON.stringify(r).slice(0, 80)}`)
    assert.ok(r.url === `${base}/loop` || r.url === `${base}/loop2`, `bounded url: ${r.url}`)
    passed++
    console.log('  ok - meta-refresh loop terminates (bounded)')
  }
  {
    // fail-open: a 404 target keeps the shell's own HTML and does not error.
    const r = await m.readUrl({ url: `${base}/deadend`, maxChars: 2000 }, undefined, undefined, undefined)
    assert.ok(!r.error, `fail-open no error: ${JSON.stringify(r).slice(0, 100)}`)
    assert.ok(r.text.includes('跳板页自身内容'), `shell text kept: ${r.text.slice(0, 60)}`)
    passed++
    console.log('  ok - meta-refresh follow fails open (shell text kept)')
  }
  server.close()
}

console.log('v1.3.1: robustness (meta attr order / charset equiv / json-ld size / markdown parens / crawl noise)')
ok('extractMeta: content before property/name (attribute order insensitive)', () => {
  const html = '<html><head><meta content="2025-05-05" property="article:published_time"><meta content="作者甲" name="author"></head><body><article><p>正文。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.equal(r.published, '2025-05-05', `published: ${r.published}`)
  assert.equal(r.author, '作者甲')
})
ok('extractMeta: content value containing single quotes (description fallback)', () => {
  const html = `<html><head><meta property="og:description" content="他说'你好'，这是摘要。"></head><body><div id="app"></div></body></html>`
  const r = extract(html, 'text')
  assert.ok(r.text.includes("他说'你好'"), `quoted content kept: ${JSON.stringify(r.text)}`)
})
ok('og:title / site_name attribute order insensitive', () => {
  const html = '<html><head><meta content="颠倒站" property="og:site_name"><meta content="颠倒标题" property="og:title"></head><body><article><p>正文。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.equal(r.siteName, '颠倒站')
  assert.equal(r.title, '颠倒标题')
})
ok('decodeBuffer: legacy meta http-equiv Content-Type charset', () => {
  const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好 in GBK
  const buf = Buffer.concat([
    Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head><body><p>', 'utf8'),
    gbkHello,
    Buffer.from('</p></body></html>', 'utf8'),
  ])
  const { text, charset } = decodeBuffer(buf, '')
  assert.equal(charset, 'gbk', `charset: ${charset}`)
  assert.ok(text.includes('你好'), `decoded: ${text.slice(0, 80)}`)
})
ok('json-ld block larger than 20k chars still harvested', () => {
  const filler = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ '@type': 'ListItem', position: i + 1, name: `item ${i} with a longer descriptive payload` })))
  const html = `<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":${filler},"mainEntity":{"@type":"Article","datePublished":"2026-08-25","author":{"@type":"Person","name":"大块作者"}}}</script></head><body><article><p>正文。</p></article></body></html>`
  assert.ok(html.length > 20000, `block is large: ${html.length}`)
  const r = extract(html, 'text')
  assert.ok(r.published.startsWith('2026-08-25'), `published: ${r.published}`)
  assert.equal(r.author, '大块作者')
})
ok('json-ld nested mainEntity (ItemList → mainEntity → Article)', () => {
  const html = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"name":"x"}],"mainEntity":{"@type":"Article","datePublished":"2026-07-01","author":{"@type":"Person","name":"嵌套作者"}}}</script></head><body><article><p>正文。</p></article></body></html>'
  const r = extract(html, 'text')
  assert.ok(r.published.startsWith('2026-07-01'), `published: ${r.published}`)
  assert.equal(r.author, '嵌套作者')
})
ok('markdown link href parens percent-encoded', () => {
  const md = blockMd('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a></p>')
  assert.ok(md.includes('[Foo](https://en.wikipedia.org/wiki/Foo_%28bar%29)'), `md: ${md}`)
})

{
  const http = await import('node:http')
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (req.url === '/stream') res.end('<html><head><title>流页</title></head><body><article><p>页面正文。</p></article><a href="/stream.m3u8">直播流</a> <a href="/page2.html">下一页</a></body></html>')
    else if (req.url === '/page2.html') res.end('<html><head><title>第二页</title></head><body><article><p>第二页正文。</p></article></body></html>')
    else if (req.url === '/bigattr') res.end('<html><head><title>超长属性页</title></head><body><article><p>正常正文段落。</p></article><a href="/ok">正常链接</a> <a ' + 'x'.repeat(300000) + ' href="/big">超长属性链接</a></body></html>')
    else { res.statusCode = 404; res.end('<html><body>not found</body></html>') }
  })
  await new Promise((r) => server.listen(18099, r))
  const base = 'http://127.0.0.1:18099'
  {
    const tools = []
    m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
    const site = tools.find((t) => t.name === 'read_url_site')
    const r = await site.execute({ url: `${base}/stream` })
    const urls = r.pages.map((p) => p.url)
    assert.ok(!urls.some((u) => u.includes('.m3u8')), `m3u8 excluded: ${urls.join(',')}`)
    assert.ok(urls.some((u) => u.includes('page2.html')), `page2 crawled: ${urls.join(',')}`)
    passed++
    console.log('  ok - crawl skips m3u8 stream URLs (noise)')
  }
  {
    // Bounded-attribute extractLinks: a 300k-char attribute must not crash or
    // hang link extraction; the well-formed link is still found, and the
    // oversized one is skipped (never scanned beyond the 1000-char bound).
    const t0 = Date.now()
    const r = await m.readUrl({ url: `${base}/bigattr`, includeLinks: true, maxChars: 2000 }, undefined, undefined, undefined)
    const elapsed = Date.now() - t0
    assert.ok(!r.error, `no error: ${JSON.stringify(r).slice(0, 80)}`)
    assert.ok(elapsed < 3000, `bounded time: ${elapsed}ms`)
    const urls = (r.links || []).map((l) => l.url)
    assert.ok(urls.includes(`${base}/ok`), `normal link kept: ${JSON.stringify(urls)}`)
    assert.ok(!urls.some((u) => u.includes('/big')), `oversized-attr link skipped: ${JSON.stringify(urls)}`)
    passed++
    console.log(`  ok - oversized-attribute anchor bounded (${elapsed}ms), normal link intact`)
  }
  server.close()
}

console.log(`\n${passed} assertions passed`)
// All assertions are synchronous or top-level awaited; reaching here means every
// one passed, so force a clean exit (avoids environment-specific exit-code noise).
process.exit(0)
