import assert from 'node:assert/strict'
import { createServer } from 'node:http'

export async function runExtractionTests(m) {
  let passed = 0
  const check = (name, fn) => {
    fn()
    passed++
    console.log(`  ok - ${name}`)
  }
  console.log('HTML structure / metadata / syndication')
  check('charset attributes accept spaces, unquoted values and mixed case', () => {
    for (const tag of ['<meta charset = "gbk">', '<meta charset=gbk>', '<META CHARSET = GBK>']) {
      const decoded = m.decodeBuffer(Buffer.concat([Buffer.from(tag), Buffer.from('d6d0cec4', 'hex')]), 'text/html')
      assert.equal(decoded.text, tag + '中文')
      assert.equal(decoded.charset, 'gbk')
    }
  })
  check('metadata values and compound attributes cannot declare a charset', () => {
    for (const tag of ['<meta data-charset="gbk">', '<meta name="note" content="charset=gbk">', '<meta data-note="charset=gbk">']) {
      const decoded = m.decodeBuffer(Buffer.from(tag + '你好'), 'text/html')
      assert.equal(decoded.text, tag + '你好')
      assert.equal(decoded.charset, 'utf-8')
    }
  })
  check('legacy charset declarations honor attribute names and either order', () => {
    for (const tag of ['<meta content = "text/html; charset = GB2312" HTTP-EQUIV = Content-Type>', '<meta http-equiv="content-type" content="text/html;charset=gbk">']) {
      const decoded = m.decodeBuffer(Buffer.concat([Buffer.from(tag), Buffer.from('d6d0cec4', 'hex')]), 'text/html')
      assert.equal(decoded.text, tag + '中文')
      assert.equal(decoded.charset, 'gbk')
    }
  })
  check('HTTP charset parameters allow spacing without accepting compound names', () => {
    assert.equal(m.decodeBuffer(Buffer.from('d6d0cec4', 'hex'), 'text/html; CHARSET = "GBK"').text, '中文')
    assert.equal(m.decodeBuffer(Buffer.from('你好'), 'text/html; x-charset=gbk').text, '你好')
  })
  check('HTTP charset takes precedence over HTML metadata', () => {
    const html = '<meta charset=gbk>你好'
    assert.equal(m.decodeBuffer(Buffer.from(html), 'text/html; charset=utf-8').text, html)
  })
  check('custom elements keep their own content and following paragraphs', () => {
    for (const tag of ['script-widget', 'template-card', 'style-panel']) {
      assert.equal(m.extract(`<main><${tag}>WIDGET</${tag}><p>REAL BODY</p></main>`, 'text').text, 'WIDGET\n\nREAL BODY')
    }
    const card = 'CARD CONTENT '.repeat(20)
    assert.ok(m.extract(`<main><article-card>${card}</article-card><p>REAL BODY</p></main>`, 'text').text.endsWith('REAL BODY'))
  })
  check('escaped HTML code remains visible in both output modes', () => {
    const html = '<main><pre><code>&lt;div&gt;Hello&lt;/div&gt;</code></pre></main>'
    for (const mode of ['text', 'markdown']) assert.ok(m.extract(html, mode).text.includes('<div>Hello</div>'))
  })
  check('visible tag examples and compact comparisons survive extraction', () => {
    const r = m.extract('<main><p>The &lt;span&gt; tag and a&lt;b are examples.</p></main>', 'text')
    assert.equal(r.text, 'The <span> tag and a<b are examples.')
  })
  check('nested articles retain the outer tail and adjacent articles', () => {
    const html = '<article><p>START</p><article>INNER</article><p>TAIL</p></article><article>SECOND</article>'
    assert.equal(m.extract(html, 'text').text, 'START\n\nINNER\n\nTAIL\n\nSECOND')
  })
  check('script templates and comments cannot select the main article', () => {
    const fake = `<article>${'FAKE '.repeat(60)}</article>`
    const html = `<script>const template = '${fake}'</script><!--${fake}--><main>REAL BODY</main>`
    assert.equal(m.extract(html, 'text').text, 'REAL BODY')
  })
  check('forum and download class names do not match ad substrings', () => {
    const html = '<main><div class="thread-content">FORUM BODY</div><div class="downloads">PACKAGE DETAILS</div></main>'
    assert.equal(m.extract(html, 'text').text, 'FORUM BODY\n\nPACKAGE DETAILS')
  })
  check('nested advertisement containers are removed completely', () => {
    const html = '<main><div class="ad-slot"><div>INNER AD</div>OUTER AD</div><p>REAL BODY</p></main>'
    assert.equal(m.extract(html, 'text').text, 'REAL BODY')
  })
  check('native noise containers discard long attributes without widening generic matching', () => {
    const long = 'x'.repeat(2200)
    assert.equal(m.extract(`<main><iframe src="https://captcha.example/${long}"></iframe><p>REAL BODY</p></main>`, 'text').text, 'REAL BODY')
    const literal = `<span data-state="${long}">KNOWN BOUNDARY</span>`
    assert.ok(m.extract(`<main>${literal}</main>`, 'text').text.includes('<span'))
  })
  check('large native noise containers are removed in full', () => {
    const image = `<img src="data:image/png;base64,${'A'.repeat(150000)}">`
    assert.equal(m.extract(`<main><header>${image}</header><footer><footer>INNER</footer>${image}</footer><p>REAL BODY</p></main>`, 'text').text, 'REAL BODY')
    assert.equal(m.extract('<main><header>UNCLOSED<p>VISIBLE</p></main>', 'text').text, 'UNCLOSED\n\nVISIBLE')
    for (const empty of ['<svg />', '<svg/>']) {
      assert.equal(m.extract(`<main>${empty}<svg><text>ICON NOISE</text></svg><p>REAL BODY</p></main>`, 'text').text, 'REAL BODY')
    }
  })
  check('highlighted source comments are retained', () => {
    const html = '<main><pre><code><span class="token comment">// explain_value</span></code></pre></main>'
    assert.ok(m.extract(html, 'markdown').text.includes('// explain_value'))
  })
  check('hidden words inside quoted data values are visible', () => {
    const html = '<main><div data-note="hidden">VISIBLE</div><div data-note="style=display:none">ALSO VISIBLE</div></main>'
    assert.equal(m.extract(html, 'text').text, 'VISIBLE\n\nALSO VISIBLE')
  })
  check('unquoted hidden attributes apply to inline and table elements', () => {
    const html = '<main><strong aria-hidden=true>HIDDEN</strong><table><tr hidden><td>HIDDEN ROW</td></tr><tr><td>VISIBLE</td></tr></table></main>'
    assert.equal(m.extract(html, 'text').text, 'VISIBLE')
  })
  check('CSS declaration boundaries distinguish hidden values from text', () => {
    const html = '<main><div style="color:red; display : none !important">HIDDEN</div><div style="--note:display:none">VISIBLE</div></main>'
    assert.equal(m.extract(html, 'text').text, 'VISIBLE')
  })
  check('consent ids are independent of attribute order', () => {
    const html = '<main><div class="box" id="onetrust-banner"><div>CONSENT</div>TAIL</div><p>REAL</p></main>'
    assert.equal(m.extract(html, 'text').text, 'REAL')
  })
  check('meta attributes accept spaces, order and unquoted values', () => {
    const r = m.extract('<head><meta content = "VALID TITLE" property = "og:title"><meta name=author content=Alice></head><main>body</main>', 'text')
    assert.equal(r.title, 'VALID TITLE')
    assert.equal(r.author, 'Alice')
  })
  check('compound meta attribute names cannot impersonate metadata', () => {
    const r = m.extract('<meta data-name="author" data-content="Wrong"><main>body</main>', 'text')
    assert.equal(r.author, '')
  })
  check('publication time takes precedence with datetime before itemprop', () => {
    const html = '<main><time datetime="2026-09-01">updated</time><time datetime="2025-01-02" itemprop="datePublished">published</time></main>'
    assert.equal(m.extract(html, 'text').published, '2025-01-02')
  })

  const ldBody = 'Verified article content with source attribution. '.repeat(8).trim()
  const ldJson = JSON.stringify({ articleBody: ldBody, author: 'Alice', datePublished: '2026-10-01' })
  const ldTag = attrs => `<script ${attrs}>${ldJson}</script>`
  check('JSON-LD accepts spaced and unquoted real type attributes', () => {
    for (const attrs of ['type = "application/ld+json"', 'type=application/ld+json']) {
      const result = m.extract(ldTag(attrs), 'text')
      assert.equal(result.text, ldBody)
      assert.equal(result.author, 'Alice')
      assert.equal(result.published, '2026-10-01')
    }
  })
  check('JSON-LD type values support case, whitespace and quoted attribute delimiters', () => {
    for (const attrs of ['TYPE="APPLICATION/LD+JSON"', 'type=" application/ld+json "', 'data-note="a > b" type="application/ld+json"']) {
      const result = m.extract(ldTag(attrs), 'text')
      assert.equal(result.text, ldBody)
      assert.equal(result.author, 'Alice')
    }
  })
  check('compound type names and quoted lookalikes cannot supply article data', () => {
    for (const attrs of ['data-type="application/ld+json"', 'data-type="application/ld+json" type="application/json"', 'data-note="type=\'application/ld+json\'"', 'type="text/javascript" data-type="application/ld+json"']) {
      const result = m.extract(`<main>Visible body</main>${ldTag(attrs)}`, 'text')
      assert.equal(result.text, 'Visible body')
      assert.equal(result.author, '')
      assert.equal(result.published, '')
    }
  })
  check('real JSON-LD type is independent of surrounding data attributes', () => {
    for (const attrs of ['data-type="application/json" type="application/ld+json"', 'type="application/ld+json" data-type="application/json"']) {
      assert.equal(m.extract(ldTag(attrs), 'text').text, ldBody)
    }
  })
  check('invalid JSON-LD and ordinary script blocks do not hide a later valid block', () => {
    const html = '<script type="application/ld+json">{broken</script><script type="application/json">{"author":"Wrong"}</script>' + ldTag('type = "application/ld+json"')
    const result = m.extract(html, 'text')
    assert.equal(result.author, 'Alice')
    assert.equal(result.text, ldBody)
  })
  check('JSON-LD retains opening-tag and body-size limits', () => {
    const longTag = ldTag(`data-note="${'x'.repeat(1100)}" type="application/ld+json"`)
    const largeBody = `<script type="application/ld+json">${JSON.stringify({ articleBody: 'x'.repeat(100001), author: 'Wrong' })}</script>`
    for (const html of [longTag, largeBody]) {
      const rejected = m.extract(`<main>Visible body</main>${html}`, 'text')
      assert.equal(rejected.text, 'Visible body')
      assert.equal(rejected.author, '')
      const followed = m.extract(html + ldTag('type="application/ld+json"'), 'text')
      assert.equal(followed.author, 'Alice')
      assert.equal(followed.text, ldBody)
    }
  })
  check('JSON-LD recursion remains bounded', () => {
    let node = { author: 'Too deep', articleBody: ldBody }
    for (let i = 0; i < 21; i++) node = { nested: node }
    const result = m.extract(`<main>Visible body</main><script type="application/ld+json">${JSON.stringify(node)}</script>`, 'text')
    assert.equal(result.author, '')
    assert.equal(result.text, 'Visible body')
  })
  check('unclosed and nested script text cannot expose an embedded JSON-LD opener', () => {
    const nested = '<script type="text/plain">' + ldTag('type="application/ld+json"')
    const unclosed = '<script type="application/ld+json">'.repeat(2000)
    for (const html of [nested, unclosed]) {
      const result = m.extract(`<main>Visible body</main>${html}`, 'text')
      assert.equal(result.author, '')
      assert.equal(result.text, 'Visible body')
    }
  })
  check('commented script openers cannot consume the next real JSON-LD block', () => {
    for (const comment of ['<!-- <script src="disabled.js"> -->', '<!-- <script type="application/ld+json">{"author":"Wrong"}</script> -->']) {
      const result = m.extract(comment + ldTag('type="application/ld+json"'), 'text')
      assert.equal(result.author, 'Alice')
      assert.equal(result.text, ldBody)
    }
  })
  check('non-script raw-text containers cannot introduce fake script elements', () => {
    for (const name of ['textarea', 'style', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']) {
      const html = `<${name}><script src="disabled.js"></${name}>` + ldTag('type="application/ld+json"')
      const result = m.extract(html, 'text')
      assert.equal(result.author, 'Alice', name)
      assert.equal(result.text, ldBody, name)
    }
  })
  check('quoted attributes on ordinary tags cannot introduce script elements', () => {
    const html = '<div data-note="<script src=\'disabled.js\'>">Visible body</div>' + ldTag('type="application/ld+json"')
    const result = m.extract(html, 'text')
    assert.equal(result.author, 'Alice')
    assert.equal(result.text, ldBody)
  })
  check('deep author arrays and name objects degrade without recursion errors', () => {
    const values = ['['.repeat(40000) + '"Too deep"' + ']'.repeat(40000), '{"name":'.repeat(4000) + '"Too deep"' + '}'.repeat(4000)]
    for (const author of values) {
      const html = `<script type="application/ld+json">{"author":${author},"datePublished":"2026-10-01","articleBody":"Visible body"}</script>`
      const result = m.extract(html, 'text')
      assert.equal(result.author, '')
      assert.equal(result.published, '2026-10-01')
      assert.equal(result.text, 'Visible body')
    }
  })
  check('deep article-body arrays do not trigger recursive string conversion', () => {
    const body = '['.repeat(40000) + '"Too deep"' + ']'.repeat(40000)
    const html = `<main>Visible body</main><script type="application/ld+json">{"articleBody":${body},"author":"Alice"}</script>`
    const result = m.extract(html, 'text')
    assert.equal(result.author, 'Alice')
    assert.equal(result.text, 'Visible body')
  })
  check('article-body arrays retain strings and omit nontext values', () => {
    const body = ['First paragraph', { note: 'Wrong object' }, 42, null, ['Wrong nested text'], 'Second paragraph']
    const result = m.extract(`<script type="application/ld+json">${JSON.stringify({ articleBody: body })}</script>`, 'text')
    assert.equal(result.text, 'First paragraph\n\nSecond paragraph')
  })

  const ldTools = {}
  let ldHtml = ''
  const ldWeb = { fetch: async ({ url }) => ({ statusCode: 200, url, body: { kind: 'html', content: ldHtml } }) }
  m.apply({ tools: { register: tool => { ldTools[tool.name] = tool } }, effect: () => {}, get: key => key === 'web' ? ldWeb : undefined }, { spaRender: false, paginate: false, cacheTtlMs: 0 })
  ldHtml = ldTag('type = "application/ld+json"')
  const ldArgs = { url: `https://jsonld-fixture.invalid/${Date.now()}/valid`, mode: 'markdown' }
  const ldResult = await ldTools.read_url.execute(ldArgs)
  check('tool execution and rendering preserve JSON-LD body and attribution', () => {
    assert.equal(ldResult.text, ldBody)
    assert.equal(ldResult.author, 'Alice')
    assert.equal(ldResult.published, '2026-10-01')
    const rendered = ldTools.read_url.output.render(ldArgs, ldResult)[0].text
    assert.ok(rendered.includes(ldBody))
    assert.ok(rendered.includes('by Alice'))
    assert.ok(rendered.includes('2026-10-01'))
    assert.ok(rendered.includes('untrusted'))
  })
  ldHtml = '<main>Visible body</main>' + ldTag('data-type="application/ld+json" type="application/json"')
  const inertArgs = { url: `https://jsonld-fixture.invalid/${Date.now()}/inert` }
  const inertResult = await ldTools.read_url.execute(inertArgs)
  check('tool rendering excludes data from a script with an unrelated real type', () => {
    assert.equal(inertResult.text, 'Visible body')
    const rendered = ldTools.read_url.output.render(inertArgs, inertResult)[0].text
    assert.ok(rendered.includes('Visible body'))
    assert.ok(!rendered.includes(ldBody))
    assert.ok(!rendered.includes('Alice'))
    assert.ok(!rendered.includes('2026-10-01'))
  })

  const fixtures = {
    '/atom': '<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><entry><title>Article</title><link rel="self" href="/entry.atom"/><link rel="enclosure" href="/audio.mp3"/><link rel="alternate" href="/article?a=1&amp;b=2"/><summary>Summary</summary></entry></feed>',
    '/base': '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:base="/news/"><atom:title>News</atom:title><atom:entry xml:base="issues/"><atom:title>Issue</atom:title><atom:link href="one"/><atom:summary type="text">Use &lt;code&gt; here</atom:summary></atom:entry></atom:feed>',
    '/rdf': '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>RSS 1</title></channel><item><title>Story</title><link>/article</link><description>Body</description></item></rdf:RDF>',
    '/unsafe': '<feed><title>News</title><entry><title>Safe title</title><link href="javascript:alert(1)"/><summary type="html">&lt;b&gt;Summary&lt;/b&gt;</summary></entry></feed>',
    '/rss-relative': '<rss><channel><title>Feed</title><item><title>One</title><link><![CDATA[/article?a=1&b=2]]></link><description><![CDATA[<b>Summary</b>]]></description></item></channel></rss>',
  }
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/xml; charset=utf-8')
    res.end(fixtures[req.url] || '')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const cfg = { timeoutMs: 2000, maxBytes: 3 * 1024 * 1024, maxChars: 6000, maxLinks: 20, cacheTtlMs: 1, cacheMax: 10, spaRender: false, paginate: false, paginateMax: 1, userAgent: 'test' }
  const read = path => m.readUrl({ url: origin + path, includeLinks: true }, null, undefined, cfg)
  try {
    const atom = await read('/atom')
    check('Atom selects the article link over self and enclosure links', () => {
      assert.equal(atom.mode, 'feed')
      assert.equal(atom.links[0].url, origin + '/article?a=1&b=2')
      assert.ok(!atom.text.includes('/audio.mp3'))
    })
    const base = await read('/base')
    check('namespaced Atom honors inherited xml:base and text constructs', () => {
      assert.equal(base.mode, 'feed')
      assert.equal(base.links[0].url, origin + '/news/issues/one')
      assert.ok(base.text.includes('Use <code> here'))
    })
    const rdf = await read('/rdf')
    check('RSS 1 RDF feeds use the compact feed output', () => {
      assert.equal(rdf.mode, 'feed')
      assert.equal(rdf.feedCount, 1)
      assert.equal(rdf.links[0].url, origin + '/article')
    })
    const unsafe = await read('/unsafe')
    check('feed article URLs reject non-HTTP schemes', () => {
      assert.equal(unsafe.links[0].url, '')
      assert.ok(!unsafe.text.includes('javascript:'))
      assert.ok(unsafe.text.includes('Summary'))
    })
    const rss = await read('/rss-relative')
    check('RSS CDATA links resolve against the feed URL', () => {
      assert.equal(rss.links[0].url, origin + '/article?a=1&b=2')
      assert.equal(rss.links[0].summary, 'Summary')
    })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  return passed
}
