import assert from 'node:assert/strict'
import http from 'node:http'

export async function runCrawlTests(m) {
  let passed = 0
  const hits = []
  const article = (title, links = '') => `<html><head><title>${title}</title></head><body><article><p>${title} ${'Readable article content. '.repeat(24)}</p></article>${links}</body></html>`
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    const u = new URL(req.url, 'http://fixture.test')
    res.setHeader('content-type', 'text/html; charset=utf-8')
    if (u.pathname === '/article-one') return res.end(article('ARTICLE_ONE', '<a href="/article-two">下一篇</a>'))
    if (u.pathname === '/article-two') return res.end(article('UNRELATED_ARTICLE_TWO'))
    if (u.pathname === '/links') return res.end(article('LINKS', '<a href="/story?id=7&amp;page=2">Story</a><a href="/story?id=7&#38;page=2">Duplicate</a><a href="/raw?id=7&copy=2">Raw query</a><a href="/once?q=&amp;amp;">Once</a>'))
    if (u.pathname === '/base-links') return res.end('<html><head><base href="/base&#47;"></head><body><a href="child?x=1&amp;y=2">Child</a></body></html>')
    if (u.pathname === '/entity-one') return res.end(article('ENTITY_ONE', '<a href="/entity-two?id=7&amp;page=2">下一页</a>'))
    if (u.pathname === '/entity-two') return res.end(article(u.searchParams.get('page') === '2' ? 'CORRECT_SECOND_PAGE' : 'WRONG_QUERY_PAGE'))
    if (u.pathname === '/budget') return res.end(article('BUDGET', Array.from({ length: 5 }, (_, i) => `<a href="/missing-${i}">Missing ${i}</a>`).join('') + '<a href="/success">Success</a>'))
    if (u.pathname === '/success') return res.end(article('SUCCESS'))
    if (u.pathname === '/redirect-root') return res.end(article('ROOT', '<a href="/outside-hop">External</a><a href="/outside-meta">Meta</a>'))
    if (u.pathname === '/outside-hop') {
      res.writeHead(302, { location: `http://localhost:${server.address().port}/outside` })
      return res.end()
    }
    if (u.pathname === '/outside-meta') return res.end(`<html><head><meta http-equiv="refresh" content="0;url=http://localhost:${server.address().port}/outside"></head><body>Redirecting</body></html>`)
    if (u.pathname === '/outside') return res.end(article('FOREIGN_HOST_CONTENT'))
    if (u.pathname === '/canonical-entry') {
      res.writeHead(302, { location: `http://localhost:${server.address().port}/canonical-root` })
      return res.end()
    }
    if (u.pathname === '/canonical-root') return res.end(article('CANONICAL_ROOT', '<a href="/canonical-child">Child</a>'))
    if (u.pathname === '/canonical-child') return res.end(article('CANONICAL_CHILD', '<a href="/canonical-root#top">Root</a>'))
    if (u.pathname === '/aliases') return res.end(article('ALIASES', '<a href="/alias">Alias</a><a href="/target">Target</a>'))
    if (u.pathname === '/alias') {
      res.writeHead(302, { location: '/target' })
      return res.end()
    }
    if (u.pathname === '/target') return res.end(article('TARGET'))
    res.writeHead(404)
    res.end('Not found')
  })
  await new Promise((resolve) => server.listen(0, resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const registered = {}
  m.apply({ tools: { register: (tool) => { registered[tool.name] = tool } }, effect: () => {}, get: () => undefined }, { spaRender: false })
  try {
    assert.equal(m.findNextLink('<a href="/next">下一篇</a>', base), null)
    assert.equal(m.findNextLink('<a href="/next">下一页 ›</a>', base), `${base}/next`)
    passed++

    const articleResult = await registered.read_url.execute({ url: `${base}/article-one`, maxChars: 20000 })
    assert.ok(articleResult.text.includes('ARTICLE_ONE'))
    assert.ok(!articleResult.text.includes('UNRELATED_ARTICLE_TWO'))
    assert.equal(articleResult.paginated, undefined)
    passed++

    const linksResult = await registered.read_url_links.execute({ url: `${base}/links` })
    assert.equal(linksResult.count, 3)
    assert.equal(linksResult.links[0].url, `${base}/story?id=7&page=2`)
    passed++
    assert.equal(linksResult.links[1].url, `${base}/raw?id=7&copy=2`)
    assert.equal(linksResult.links[2].url, `${base}/once?q=&amp;`)
    passed++

    const baseResult = await registered.read_url_links.execute({ url: `${base}/base-links` })
    assert.equal(baseResult.links[0].url, `${base}/base/child?x=1&y=2`)
    passed++

    assert.equal(m.findNextLink('<link rel="next" href="/next?id=7&amp;page=2">', base), `${base}/next?id=7&page=2`)
    assert.equal(m.findNextLink('<a href="/next?id=7&#x26;page=2">Next</a>', base), `${base}/next?id=7&page=2`)
    passed++

    const paginated = await registered.read_url.execute({ url: `${base}/entity-one`, maxChars: 20000 })
    assert.equal(paginated.paginated, 2)
    assert.ok(paginated.text.includes('CORRECT_SECOND_PAGE'))
    assert.ok(!paginated.text.includes('WRONG_QUERY_PAGE'))
    passed++

    hits.length = 0
    const budget = await registered.read_url_site.execute({ url: `${base}/budget`, maxPages: 2, maxDepth: 1 })
    assert.equal(budget.total, 2)
    assert.equal(budget.succeeded, 1)
    assert.equal(budget.failed, 1)
    assert.deepEqual(hits, ['/budget', '/missing-0'])
    passed++

    hits.length = 0
    const fractional = await registered.read_url_site.execute({ url: `${base}/budget`, maxPages: 2.9, maxDepth: 1 })
    assert.equal(fractional.total, 2)
    assert.equal(hits.length, 2)
    passed++

    const redirects = await registered.read_url_site.execute({ url: `${base}/redirect-root`, maxPages: 5, maxDepth: 1, includeContent: true })
    assert.equal(redirects.host, '127.0.0.1')
    assert.equal(redirects.succeeded, 1)
    assert.equal(redirects.failed, 2)
    assert.ok(redirects.failures.every((failure) => failure.error.includes('outside the site')))
    assert.ok(!JSON.stringify(redirects.pages).includes('FOREIGN_HOST_CONTENT'))
    passed++

    const canonical = await registered.read_url_site.execute({ url: `${base}/canonical-entry`, maxPages: 5, maxDepth: 2 })
    assert.equal(canonical.host, 'localhost')
    assert.deepEqual(canonical.pages.map((page) => new URL(page.url).pathname), ['/canonical-root', '/canonical-child'])
    passed++

    const aliases = await registered.read_url_site.execute({ url: `${base}/aliases`, maxPages: 5, maxDepth: 1 })
    assert.equal(aliases.succeeded, 2)
    assert.deepEqual(aliases.pages.map((page) => new URL(page.url).pathname), ['/aliases', '/target'])
    passed++

    const seamTools = {}
    const seamCalls = []
    const seam = { fetch: async ({ url }) => {
      seamCalls.push(url)
      const path = new URL(url).pathname
      const content = path === '/seam-shell'
        ? '<html><head><meta http-equiv="refresh" content="0;url=/seam-target"></head><body>Redirecting</body></html>'
        : path === '/seam-root'
          ? article('SEAM_ROOT', '<a href="/seam-shell">Shell</a>')
          : article('SEAM_TARGET', '<a href="/seam-leaf">Leaf</a>')
      return { statusCode: 200, body: { kind: 'html', content }, url }
    } }
    m.apply({ tools: { register: (tool) => { seamTools[tool.name] = tool } }, effect: () => {}, get: () => seam }, { spaRender: false })
    hits.length = 0
    const seamLinks = await seamTools.read_url_links.execute({ url: `${base}/seam-shell` })
    assert.equal(seamLinks.links[0].url, `${base}/seam-leaf`)
    assert.deepEqual(seamCalls.map((url) => new URL(url).pathname), ['/seam-shell', '/seam-target'])
    assert.equal(hits.length, 0)
    passed++

    seamCalls.length = 0
    const seamSite = await seamTools.read_url_site.execute({ url: `${base}/seam-root`, maxPages: 2, maxDepth: 1 })
    assert.deepEqual(seamSite.pages.map((page) => new URL(page.url).pathname), ['/seam-root', '/seam-target'])
    assert.deepEqual(seamCalls.map((url) => new URL(url).pathname), ['/seam-root', '/seam-shell', '/seam-target'])
    assert.equal(hits.length, 0)
    passed++

    const refusedTools = {}
    m.apply({ tools: { register: (tool) => { refusedTools[tool.name] = tool } }, effect: () => {}, get: () => ({ fetch: async () => { throw new Error('Provider refused') } }) }, { spaRender: false })
    const refusedLinks = await refusedTools.read_url_links.execute({ url: `${base}/success` })
    const refusedSite = await refusedTools.read_url_site.execute({ url: `${base}/success` })
    assert.ok(refusedLinks.error.includes('Provider refused'))
    assert.equal(refusedSite.succeeded, 0)
    assert.equal(refusedSite.failed, 1)
    assert.ok(refusedSite.failures[0].error.includes('Provider refused'))
    assert.equal(hits.length, 0)
    passed++
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  return passed
}
