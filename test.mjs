// dsh-read-url self-test — zero-dependency, run: node test.mjs
import assert from 'node:assert/strict'
import * as m from './index.js'
import { looksLikeSpa } from './spa.js'
const { decodeBuffer, extract, smartTruncate, blockMd, inlineMd, decodeTextEntities, raceFirstSuccess } = m

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
ok('all-fail collects failures in order', async () => {
  const out = await raceFirstSuccess([
    Promise.resolve({ error: 'HTTP 403 Forbidden' }),
    Promise.resolve(null),
  ])
  assert.equal(out.success, false)
  assert.equal(out.failures[0].error, 'HTTP 403 Forbidden')
  assert.equal(out.failures[1], null)
})

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

console.log(`\n${passed} assertions passed`)
// All assertions are synchronous or top-level awaited; reaching here means every
// one passed, so force a clean exit (avoids environment-specific exit-code noise).
process.exit(0)
