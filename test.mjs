// dsh-read-url self-test — zero-dependency, run: node test.mjs
import assert from 'node:assert/strict'
import * as m from './index.js'
import { looksLikeSpa } from './spa.js'
const { decodeBuffer, extract, smartTruncate, blockMd, inlineMd } = m

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
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

console.log('SPA detection')
ok('detects script-heavy SPA skeleton', () => {
  const spa = '<html><head></head><body><div id="app"></div>' + '<script src="/a.js"></script>'.repeat(8) + '</body></html>'
  assert.equal(looksLikeSpa(spa), true)
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

console.log(`\n${passed} assertions passed`)
// All assertions are synchronous or top-level awaited; reaching here means every
// one passed, so force a clean exit (avoids environment-specific exit-code noise).
process.exit(0)
