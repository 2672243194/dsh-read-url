import assert from 'node:assert/strict'
import http from 'node:http'

export async function runDirectOriginTests(m) {
  let passed = 0, serial = 0
  const handlers = new Map(), hits = [], providerCalls = []
  const servers = Array.from({ length: 2 }, () => http.createServer((req, res) => {
    const url = `http://${req.headers.host}${req.url}`
    hits.push(url)
    const handler = handlers.get(url)
    if (!handler) { res.writeHead(404); res.end('Missing fixture'); return }
    handler(req, res)
  }))
  await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  const [a, b] = servers.map(server => `http://127.0.0.1:${server.address().port}`)
  const cfg = {
    timeoutMs: 1000, maxBytes: 3 * 1024 * 1024, maxChars: 6000,
    maxLinks: 20, cacheTtlMs: 300000, cacheMax: 32, spaRender: false,
    paginate: false, paginateMax: 3, userAgent: 'direct-origin-test', directFetchOrigins: [a],
  }
  const article = text => `<html><body><article><p>${text} ${'Readable fixture body. '.repeat(30)}</p></article></body></html>`
  const add = (origin, handler) => {
    const url = `${origin}/direct-${++serial}`
    handlers.set(url, handler)
    return url
  }
  const html = (text, origin = a) => add(origin, (_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(text)
  })
  const redirect = (target, status = 302, origin = a) => add(origin, (_req, res) => {
    res.writeHead(status, { location: target }); res.end()
  })
  const refresh = (target, text = 'STATIC_SHELL') => html(`<html><head><meta http-equiv="refresh" content="0;url=${target}"></head><body><article>${text}</article></body></html>`)
  const response = (url, content = article('PROVIDER_BODY')) => ({ url, statusCode: 200, body: { kind: 'html', content } })
  const context = (provider = async () => { throw Object.assign(new Error('Policy blocked'), { code: 'WEB_URL_BLOCKED' }) }) => ({
    get: () => ({ fetch: async ({ url }, signal) => { providerCalls.push(url); return provider(url, signal) } }),
  })
  const read = (url, extra = {}, ctx = context(), signal) => m.readUrl({ url, maxChars: 20000 }, ctx, signal, { ...cfg, ...extra })
  const tools = (extra = {}, ctx = context()) => {
    const registered = {}
    m.apply({ ...ctx, tools: { register: tool => { registered[tool.name] = tool } }, effect: () => {} }, { ...cfg, ...extra })
    return registered
  }
  const check = async (name, run) => {
    hits.length = 0; providerCalls.length = 0
    await run(); passed++; console.log(`  ok - ${name}`)
  }
  console.log('Explicit direct origins (local HTTP fixtures)')
  try {
    await check('empty origins preserve provider policy and HTTP failures without local requests', async () => {
      for (const provider of [undefined, async url => ({ ...response(url), statusCode: 503 })]) {
        const url = html(article('MUST_NOT_READ'))
        const out = await read(url, { directFetchOrigins: [] }, context(provider))
        assert.ok(out.error)
      }
      assert.equal(providerCalls.length, 2); assert.equal(hits.length, 0)
    })

    await check('an explicit origin selects direct HTML and JSON retrieval before the provider', async () => {
      const page = html(article('DIRECT_BODY'))
      const direct = await read(page)
      assert.equal(direct.error, undefined)
      assert.match(direct.text, /DIRECT_BODY/)
      const json = add(a, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"answer":42}') })
      const out = await read(json)
      assert.equal(out.mode, 'json'); assert.equal(out.text, '{"answer":42}')
      assert.deepEqual(hits, [page, json]); assert.equal(providerCalls.length, 0)
    })

    await check('origin matching includes scheme, port and complete hostname', async () => {
      const url = html(article('NORMALIZED_ORIGIN'))
      assert.match((await read(url, { directFetchOrigins: [a.toUpperCase() + '/'] })).text, /NORMALIZED_ORIGIN/)
      const ctx = context(async request => response(request))
      const outside = [html(article('FOREIGN_PORT'), b), url.replace('http:', 'https:'), url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', '127.0.0.1.invalid')]
      for (const request of outside) assert.match((await read(request, {}, ctx)).text, /PROVIDER_BODY/)
      assert.deepEqual(hits, [url]); assert.deepEqual(providerCalls, outside)
    })

    await check('invalid origin configuration fails closed at apply and programmatic read', async () => {
      const invalid = [null, a, {}, [null], [1], ['*'], ['https://*.example.com'], ['file:///tmp'], [`${a}/path`], [`${a}?x=1`], [`${a}#part`], [`http://user:pass@127.0.0.1:${servers[0].address().port}`], Array(33).fill(a), [`http://${'a'.repeat(2049)}.invalid`]]
      for (const directFetchOrigins of invalid) {
        assert.throws(() => tools({ directFetchOrigins }))
        const out = await read(`${a}/invalid-${++serial}`, { directFetchOrigins })
        assert.ok(out.error, `Invalid configuration was accepted: ${JSON.stringify(directFetchOrigins).slice(0, 120)}`)
      }
      assert.equal(hits.length, 0); assert.equal(providerCalls.length, 0)
    })

    await check('HTTP redirects follow relative locations and explicitly listed alternate origins', async () => {
      const end = html(article('REDIRECT_TARGET'), b)
      const cross = redirect(end, 307)
      const start = redirect(new URL(cross).pathname, 301)
      const out = await read(start, { directFetchOrigins: [a, b] })
      assert.match(out.text, /REDIRECT_TARGET/); assert.equal(out.url, end)
      assert.deepEqual(hits, [start, cross, end]); assert.equal(providerCalls.length, 0)
    })

    await check('HTTP redirects never contact an unlisted origin', async () => {
      const end = html(article('FORBIDDEN_TARGET'), b), start = redirect(end)
      assert.ok((await read(start)).error)
      assert.deepEqual(hits, [start]); assert.equal(providerCalls.length, 0)
    })

    await check('credentials and non-HTTP redirect targets are rejected before request', async () => {
      const protectedUrl = html(article('CREDENTIAL_TARGET'))
      const credentials = protectedUrl.replace('http://', 'http://user:pass@')
      assert.ok((await read(credentials)).error)
      assert.equal(hits.length, 0)
      for (const target of [credentials, 'file:///tmp/fixture', 'ftp://127.0.0.1/fixture', 'data:text/plain,fixture']) {
        const start = redirect(target)
        const before = hits.length
        assert.ok((await read(start)).error); assert.equal(hits.length, before + 1)
      }
      assert.equal(providerCalls.length, 0)
    })

    await check('HTTP redirect loops and chains exceeding five hops remain bounded', async () => {
      let loop
      loop = add(a, (_req, res) => { res.writeHead(302, { location: loop }); res.end() })
      assert.ok((await read(loop)).error); assert.deepEqual(hits, [loop])
      hits.length = 0
      const end = html(article('UNREACHABLE_END'))
      let start = end
      for (let i = 0; i < 7; i++) start = redirect(start)
      assert.ok((await read(start)).error); assert.ok(hits.length <= 6); assert.ok(!hits.includes(end))
    })

    await check('missing redirect locations and unsuccessful HTTP statuses are errors', async () => {
      for (const status of [302, 304, 403, 500]) {
        const url = add(a, (_req, res) => { res.writeHead(status); res.end('Unavailable') })
        assert.ok((await read(url)).error)
      }
      assert.equal(hits.length, 4); assert.equal(providerCalls.length, 0)
    })

    await check('meta refresh follows listed origins and preserves static content at its boundary', async () => {
      const end = html(article('REFRESH_TARGET'), b), start = refresh(end)
      const blocked = await read(start)
      assert.match(blocked.text, /STATIC_SHELL/); assert.ok(!blocked.text.includes('REFRESH_TARGET'))
      assert.deepEqual(hits, [start]); assert.equal(providerCalls.length, 0)
      hits.length = 0
      const allowed = await read(start, { directFetchOrigins: [a, b] })
      assert.match(allowed.text, /REFRESH_TARGET/); assert.deepEqual(hits, [start, end])
    })

    await check('provider-to-direct refresh keeps the direct boundary through subsequent hops', async () => {
      const end = html(article('FORBIDDEN_AFTER_REFRESH'), b), middle = refresh(end, 'DIRECT_REFRESH_SHELL')
      const start = `https://provider-fixture.invalid/${++serial}`
      const ctx = context(async request => response(request, `<meta http-equiv="refresh" content="0;url=${middle}"><article>PROVIDER_SHELL</article>`))
      const out = await read(start, {}, ctx)
      assert.match(out.text, /DIRECT_REFRESH_SHELL/); assert.ok(!out.text.includes('FORBIDDEN_AFTER_REFRESH'))
      assert.deepEqual(providerCalls, [start]); assert.deepEqual(hits, [middle])
    })

    await check('pagination keeps listed continuations and rejects a different unlisted port', async () => {
      const end = html(article('SECOND_PAGE'), b)
      const first = html(article('FIRST_PAGE') + `<a rel="next" href="${end}">Next</a>`)
      const blocked = await read(first, { paginate: true })
      assert.match(blocked.text, /FIRST_PAGE/); assert.ok(!blocked.text.includes('SECOND_PAGE'))
      assert.deepEqual(hits, [first]); assert.equal(providerCalls.length, 0)
      hits.length = 0
      const allowed = await read(first, { paginate: true, directFetchOrigins: [a, b] })
      assert.equal(allowed.paginated, 2); assert.match(allowed.text, /SECOND_PAGE/)
      assert.deepEqual(hits, [first, end])
    })

    await check('link scanning follows the same direct refresh restriction', async () => {
      const end = html(article('FOREIGN_LINKS') + '<a href="/target">Target</a>', b)
      const start = refresh(end)
      const blocked = await tools().read_url_links.execute({ url: start })
      assert.equal(blocked.url, start); assert.equal(blocked.count, 0)
      assert.deepEqual(hits, [start]); assert.equal(providerCalls.length, 0)
      hits.length = 0
      const allowed = await tools({ directFetchOrigins: [a, b] }).read_url_links.execute({ url: start })
      assert.equal(allowed.url, end); assert.equal(allowed.links[0].url, `${b}/target`)
      assert.deepEqual(hits, [start, end])
    })

    await check('batch reads select independent routes and isolate a blocked redirect', async () => {
      const first = html(article('BATCH_DIRECT')), foreign = html(article('BATCH_FOREIGN'), b), blocked = redirect(foreign)
      const normal = `https://provider-fixture.invalid/batch-${++serial}`
      const ctx = context(async request => response(request, article('BATCH_PROVIDER')))
      const out = await tools({}, ctx).read_url_batch.execute({ urls: [first, blocked, normal] })
      assert.equal(out.succeeded, 2); assert.equal(out.failed, 1)
      assert.match(out.pages[0].text, /BATCH_DIRECT/); assert.ok(out.pages[1].error); assert.match(out.pages[2].text, /BATCH_PROVIDER/)
      assert.deepEqual([...hits].sort(), [first, blocked].sort()); assert.deepEqual(providerCalls, [normal])
    })

    await check('crawl propagates direct restrictions to links with another port', async () => {
      const foreign = html(article('CRAWL_FOREIGN'), b), child = html(article('CRAWL_CHILD'))
      const start = html(article('CRAWL_ROOT') + `<a href="${child}">Child</a><a href="${foreign}">Foreign port</a>`)
      const out = await tools().read_url_site.execute({ url: start, maxPages: 5, maxDepth: 2, includeContent: true })
      assert.equal(out.succeeded, 2); assert.ok(!JSON.stringify(out.pages).includes('CRAWL_FOREIGN'))
      assert.deepEqual([...hits].sort(), [start, child].sort()); assert.equal(providerCalls.length, 0)
    })

    await check('crawl preserves a blocked meta-refresh hint in structured and rendered output', async () => {
      const foreign = html(article('CRAWL_FORBIDDEN_REFRESH'), b)
      const start = refresh(foreign, 'CRAWL_STATIC_SHELL')
      const tool = tools().read_url_site
      const out = await tool.execute({ url: start, maxPages: 2, maxDepth: 1, includeContent: true })
      assert.equal(out.succeeded, 1); assert.equal(out.failed, 0)
      assert.match(out.pages[0].text, /CRAWL_STATIC_SHELL/)
      assert.match(out.pages[0].spaHint, /outside directFetchOrigins/)
      const rendered = tool.output.render({}, out).map(block => block.text || '').join('\n')
      assert.match(rendered, /outside directFetchOrigins/)
      assert.ok(!rendered.includes('CRAWL_FORBIDDEN_REFRESH'))
      assert.deepEqual(hits, [start]); assert.equal(providerCalls.length, 0)
    })

    await check('crawl route state remains independent across provider and direct sibling branches', async () => {
      const direct = html(article('CRAWL_DIRECT_BRANCH')), start = `${b}/provider-root-${++serial}`, sibling = `${b}/provider-child-${++serial}`
      const ctx = context(async request => response(request, request === start
        ? article('PROVIDER_ROOT') + `<a href="${direct}">Direct branch</a><a href="${sibling}">Provider branch</a>`
        : article('PROVIDER_CHILD')))
      const out = await tools({}, ctx).read_url_site.execute({ url: start, maxPages: 5, maxDepth: 1, includeContent: true })
      assert.equal(out.succeeded, 3); assert.equal(out.failed, 0)
      assert.deepEqual(hits, [direct]); assert.deepEqual([...providerCalls].sort(), [start, sibling].sort())
    })

    await check('cache entries distinguish provider and direct successes and policy failures', async () => {
      const url = html(article('CACHE_DIRECT')), ctx = context(async request => response(request, article('CACHE_PROVIDER')))
      assert.match((await read(url, { directFetchOrigins: [] }, ctx)).text, /CACHE_PROVIDER/)
      assert.match((await read(url, {}, ctx)).text, /CACHE_DIRECT/)
      const providerHit = await read(url, { directFetchOrigins: [] }, ctx)
      assert.match(providerHit.text, /CACHE_PROVIDER/); assert.equal(providerHit.cached, true)
      const failureUrl = html(article('CACHE_RECOVERED'))
      assert.ok((await read(failureUrl, { directFetchOrigins: [] })).error)
      assert.match((await read(failureUrl)).text, /CACHE_RECOVERED/)
      const cachedFailure = await read(failureUrl, { directFetchOrigins: [] })
      assert.ok(cachedFailure.error); assert.equal(cachedFailure.cached, true)
      assert.deepEqual(hits, [url, failureUrl]); assert.equal(providerCalls.length, 2)
    })

    await check('cache identity includes the whole origin list and canonicalizes ordering', async () => {
      const end = html(article('CACHE_FINAL'), b), middle = refresh(end, 'CACHE_RESTRICTED')
      const start = `https://provider-fixture.invalid/cache-${++serial}`
      const ctx = context(async request => response(request, `<meta http-equiv="refresh" content="0;url=${middle}"><article>Provider shell</article>`))
      assert.match((await read(start, {}, ctx)).text, /CACHE_RESTRICTED/)
      assert.match((await read(start, { directFetchOrigins: [a, b] }, ctx)).text, /CACHE_FINAL/)
      const equivalent = await read(start, { directFetchOrigins: [b, a.toUpperCase() + '/', a] }, ctx)
      assert.equal(equivalent.cached, true); assert.match(equivalent.text, /CACHE_FINAL/)
      assert.deepEqual(hits, [middle, middle, end]); assert.deepEqual(providerCalls, [start, start])
    })

    await check('pre-cancelled and in-flight cancelled direct reads do not poison cache', async () => {
      const pre = new AbortController(); pre.abort()
      const fast = html(article('CANCEL_RECOVERED'))
      assert.equal((await read(fast, {}, context(), pre.signal)).error, 'cancelled')
      assert.equal(hits.length, 0)
      assert.match((await read(fast)).text, /CANCEL_RECOVERED/)
      let entered
      const ready = new Promise(resolve => { entered = resolve })
      const slow = add(a, (_req, _res) => { entered() })
      const controller = new AbortController()
      const pending = read(slow, {}, context(), controller.signal)
      await ready; controller.abort()
      assert.equal((await pending).error, 'cancelled')
      handlers.set(slow, (_req, res) => { res.setHeader('content-type', 'text/html'); res.end(article('CANCEL_RETRIED')) })
      const retried = await read(slow)
      assert.match(retried.text, /CANCEL_RETRIED/); assert.ok(!retried.cached)
    })

    await check('direct retrieval enforces timeout and cumulative body byte limits', async () => {
      const slow = add(a, () => {})
      const started = Date.now()
      assert.ok((await read(slow, { timeoutMs: 80 })).error)
      assert.ok(Date.now() - started < 1500)
      const oversized = add(a, (_req, res) => {
        res.setHeader('content-type', 'text/plain'); res.write('x'.repeat(100)); res.end('y'.repeat(100))
      })
      assert.match((await read(oversized, { maxBytes: 128 })).error, /exceeds|bytes/i)
      assert.equal(providerCalls.length, 0)
    })

    await check('direct Retry-After retries once inside the same route boundary', async () => {
      let calls = 0
      const url = add(a, (_req, res) => {
        if (++calls === 1) { res.writeHead(503, { 'retry-after': '0' }); res.end(); return }
        res.setHeader('content-type', 'text/html'); res.end(article('RETRY_RECOVERED'))
      })
      assert.match((await read(url)).text, /RETRY_RECOVERED/); assert.equal(calls, 2)
      let limited = 0
      const always = add(a, (_req, res) => { limited++; res.writeHead(429, { 'retry-after': '0' }); res.end() })
      assert.ok((await read(always)).error); assert.equal(limited, 2)
      assert.equal(providerCalls.length, 0)
    })
  } finally {
    servers.forEach(server => server.closeAllConnections())
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  }
  return passed
}
