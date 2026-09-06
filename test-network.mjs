import assert from 'node:assert/strict'
import { isFetchableContentType, looksBinary } from './proxy-fallback.js'

export async function runNetworkTests(m) {
  let passed = 0
  let serial = 0
  const cfg = {
    timeoutMs: 500, maxBytes: 3 * 1024 * 1024, maxChars: 6000,
    maxLinks: 20, cacheTtlMs: 300000, cacheMax: 32,
    spaRender: false, paginate: false, paginateMax: 3, userAgent: 'network-test',
  }
  const url = () => `https://network-fixture.invalid/${Date.now()}-${++serial}`
  const result = (requestUrl, content, kind = 'html', extra = {}) => ({
    url: requestUrl, statusCode: 200, body: { kind, content }, truncated: false, ...extra,
  })
  const ctx = (fetch) => ({ get: (key) => key === 'web' ? { fetch } : undefined })
  const check = async (name, run) => {
    await run()
    passed++
    console.log(`  ok - ${name}`)
  }
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error('Unexpected direct fetch') }
    await check('web seam uses the official request, signal and result contract', async () => {
      const requested = url()
      const output = await m.readUrl({ url: requested }, ctx(async (request, signal) => {
        assert.deepEqual(request, { url: requested })
        assert.ok(signal instanceof AbortSignal)
        return result(`${requested}/final`, '<article><p>Provider body survives extraction.</p></article>')
      }), undefined, cfg)
      assert.equal(output.url, `${requested}/final`)
      assert.equal(output.charset, 'provider-decoded')
      assert.match(output.text, /Provider body/)
    })
    await check('web seam preserves plain-text lines and angle-bracket literals', async () => {
      const requested = url()
      const text = 'first line\n<Widget>\nthird line'
      const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, text, 'text')), undefined, cfg)
      assert.equal(output.mode, 'text')
      assert.equal(output.text, text)
    })
    await check('provider text classification preserves literal HTML examples', async () => {
      const requested = url()
      const text = '<div>example</div>\nnext line'
      const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, text, 'text')), undefined, cfg)
      assert.equal(output.mode, 'text')
      assert.equal(output.text, text)
    })
    await check('web seam dispatches JSON and retains its redirected URL', async () => {
      const requested = url()
      const output = await m.readUrl({ url: requested }, ctx(async () => result(`${requested}/json`, '{\n "answer": 42\n}', 'text')), undefined, cfg)
      assert.equal(output.mode, 'json')
      assert.equal(output.text, '{"answer":42}')
      assert.equal(output.url, `${requested}/json`)
    })
    await check('loose JSON normalizes nonfinite literals without altering strings', async () => {
      const requested = url()
      const expected = { title: 'Infinity NaN', quoted: 'say "Infinity" and \\NaN', value: null, negative: null, array: [null] }
      const raw = JSON.stringify({ ...expected, value: 'literal-nan', negative: 'literal-negative', array: ['literal-infinity'] })
        .replace('"literal-nan"', 'NaN').replace('"literal-negative"', '-Infinity').replace('"literal-infinity"', 'Infinity')
      const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, raw, 'text')), undefined, cfg)
      assert.equal(output.mode, 'json')
      assert.deepEqual(JSON.parse(output.text), expected)
    })
    await check('web seam dispatches RSS with the final URL as its link base', async () => {
      const requested = url()
      const xml = '<rss><channel><title>Feed title</title><item><title>Item title</title><link>entry</link><description>Summary body.</description></item></channel></rss>'
      const output = await m.readUrl({ url: requested, includeLinks: true }, ctx(async () => result(`${requested}/feed/`, xml, 'text')), undefined, cfg)
      assert.equal(output.mode, 'feed')
      assert.equal(output.feedCount, 1)
      assert.equal(output.links[0].url, `${requested}/feed/entry`)
    })
    await check('content dispatch recognizes namespaced Atom and RSS 1.0 roots', async () => {
      const fixtures = [
        '<?xml version="1.0"?><!-- feed --><a:feed xmlns:a="http://www.w3.org/2005/Atom"><a:title>Atom</a:title><a:entry><a:title>Entry</a:title><a:link href="entry"/></a:entry></a:feed>',
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><channel><title>RSS 1</title></channel><item><title>Entry</title><link>entry</link></item></rdf:RDF>',
      ]
      for (const fixture of fixtures) {
        const requested = `${url()}/`
        const output = await m.readUrl({ url: requested, includeLinks: true }, ctx(async () => result(requested, fixture, 'text')), undefined, cfg)
        assert.equal(output.mode, 'feed')
        assert.equal(output.feedCount, 1)
        assert.equal(output.links[0].url, `${requested}entry`)
      }
    })
    await check('HTML examples and unrelated XML are not classified as feeds', async () => {
      for (const fixture of ['<html><body><article><p>Examples include an RSS tag:</p><rss>example</rss></article></body></html>', '<rdf:RDF><description>Unrelated RDF data.</description></rdf:RDF>']) {
        const requested = url()
        const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, fixture)), undefined, cfg)
        assert.notEqual(output.mode, 'feed')
        assert.ok(!output.error)
      }
    })
    await check('web seam reports HTTP failures without a direct retry', async () => {
      const requested = url()
      const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, '<p>Error</p>', 'html', { statusCode: 503 })), undefined, cfg)
      assert.equal(output.error, 'HTTP 503')
    })
    await check('web seam preserves provider policy failures without a direct retry', async () => {
      const output = await m.readUrl({ url: url() }, ctx(async () => {
        throw Object.assign(new Error('URL blocked'), { code: 'WEB_URL_BLOCKED' })
      }), undefined, cfg)
      assert.match(output.error, /URL blocked/)
    })
    await check('web seam enforces timeout even if a provider ignores its signal', async () => {
      const keepAlive = setTimeout(() => {}, 2000)
      const started = Date.now()
      try {
        const output = await m.readUrl({ url: url() }, ctx(async () => new Promise(() => {})), undefined, { ...cfg, timeoutMs: 40 })
        assert.ok(output.error)
        assert.ok(Date.now() - started < 1500)
      } finally {
        clearTimeout(keepAlive)
      }
    })
    await check('web seam applies the configured maximum response size', async () => {
      const requested = url()
      const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, 'x'.repeat(65), 'text')), undefined, { ...cfg, maxBytes: 64 })
      assert.match(output.error, /exceeds 64 bytes/)
    })
    await check('provider truncation is disclosed without suggesting unavailable offsets', async () => {
      const requested = url()
      const output = await m.readUrl({ url: requested }, ctx(async () => result(requested, 'Available text.', 'text', { truncated: true })), undefined, cfg)
      assert.match(output.spaHint, /提供方已截断/)
      assert.equal(output.truncated, false)
    })
    await check('pre-cancelled reads do not populate the failure cache', async () => {
      const requested = url()
      const ctrl = new AbortController()
      ctrl.abort()
      let calls = 0
      const provider = ctx(async () => { calls++; return result(requested, 'Recovered body.', 'text') })
      assert.equal((await m.readUrl({ url: requested }, provider, ctrl.signal, cfg)).error, 'cancelled')
      assert.equal(calls, 0)
      const retry = await m.readUrl({ url: requested }, provider, undefined, cfg)
      assert.equal(retry.text, 'Recovered body.')
      assert.equal(calls, 1)
      assert.ok(!retry.cached)
    })
    await check('mid-fetch cancellation promptly settles and permits a fresh retry', async () => {
      const requested = url()
      const ctrl = new AbortController()
      const provider = ctx(async () => {
        setTimeout(() => ctrl.abort(), 10)
        return new Promise(() => {})
      })
      const output = await m.readUrl({ url: requested }, provider, ctrl.signal, cfg)
      assert.equal(output.error, 'cancelled')
      const retry = await m.readUrl({ url: requested }, ctx(async () => result(requested, 'Fresh body.', 'text')), undefined, cfg)
      assert.equal(retry.text, 'Fresh body.')
      assert.ok(!retry.cached)
    })
    await check('meta-refresh follows through the selected web provider', async () => {
      const requested = url()
      const target = `${requested}/next`
      const visited = []
      const output = await m.readUrl({ url: requested }, ctx(async ({ url: requestUrl }) => {
        visited.push(requestUrl)
        return result(requestUrl, requestUrl === requested ? `<meta http-equiv="refresh" content="0;url=${target}">` : '<article><p>Reached the refresh destination.</p></article>')
      }), undefined, cfg)
      assert.deepEqual(visited, [requested, target])
      assert.equal(output.url, target)
      assert.match(output.text, /refresh destination/)
    })
    await check('meta-refresh preserves truncation reported by its destination', async () => {
      const requested = url()
      const provider = ctx(async ({ url: requestUrl }) => result(requestUrl, requestUrl === requested
        ? `<meta http-equiv="refresh" content="0;url=${requested}/next">`
        : `<article><p>${'Truncated destination body. '.repeat(5)}</p></article>`, 'html', { truncated: requestUrl !== requested }))
      const output = await m.readUrl({ url: requested }, provider, undefined, cfg)
      assert.match(output.spaHint, /提供方已截断/)
      assert.equal(output.url, `${requested}/next`)
    })
    await check('pagination reports truncation on an accepted continuation page', async () => {
      const requested = url()
      const provider = ctx(async ({ url: requestUrl }) => result(requestUrl, requestUrl === requested
        ? `<article><p>${'Original page body. '.repeat(8)}</p><a rel="next" href="${requested}/next">Next page</a></article>`
        : `<article><p>${'Truncated continuation body. '.repeat(8)}</p></article>`, 'html', { truncated: requestUrl !== requested }))
      const output = await m.readUrl({ url: requested }, provider, undefined, { ...cfg, paginate: true })
      assert.equal(output.paginated, 2)
      assert.match(output.text, /Truncated continuation/)
      assert.match(output.spaHint, /提供方已截断/)
    })
    await check('pagination rejects a next-page redirect to another host', async () => {
      const requested = url()
      const provider = ctx(async ({ url: requestUrl }) => result(requestUrl === requested ? requested : 'https://other-fixture.invalid/article', requestUrl === requested
        ? `<article><p>${'Original page body. '.repeat(8)}</p><a rel="next" href="${requested}/next">Next page</a></article>`
        : `<article><p>${'Unrelated destination. '.repeat(8)}</p></article>`))
      const output = await m.readUrl({ url: requested }, provider, undefined, { ...cfg, paginate: true })
      assert.ok(!output.text.includes('Unrelated destination'))
      assert.ok(!output.paginated)
    })
    await check('pagination stops a next-page alias redirecting to the first page', async () => {
      const requested = url()
      let calls = 0
      const provider = ctx(async ({ url: requestUrl }) => {
        calls++
        return result(requested, requestUrl === requested
          ? `<article><p>${'Original page body. '.repeat(8)}</p><a rel="next" href="${requested}/alias">Next page</a></article>`
          : `<article><p>${'Duplicate destination body. '.repeat(8)}</p></article>`)
      })
      const output = await m.readUrl({ url: requested }, provider, undefined, { ...cfg, paginate: true })
      assert.equal(calls, 2)
      assert.ok(!output.text.includes('Duplicate destination'))
      assert.ok(!output.paginated)
    })
    await check('direct and proxy content gates share text and structured-JSON support', async () => {
      for (const mime of ['application/problem+json', 'application/vnd.api+json', 'model/gltf+json', 'text/markdown', 'text/csv', 'application/rss+xml', 'image/svg+xml']) {
        assert.equal(isFetchableContentType(mime), true, mime)
        globalThis.fetch = async () => new Response('{"answer":42}', { headers: { 'content-type': mime } })
        const output = await m.directFetch(url(), undefined, cfg)
        assert.ok(output.buffer, JSON.stringify(output))
      }
      for (const mime of ['image/png', 'application/pdf', 'application/octet-stream', 'application/jsonp']) {
        assert.equal(isFetchableContentType(mime), false, mime)
      }
    })
    await check('headerless UTF-16 BOM documents pass binary sniffing and decode correctly', async () => {
      const source = '<html><body><p>UTF-16 正文</p></body></html>'
      const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])
      const be = Buffer.from(le).swap16()
      for (const buffer of [le, be]) {
        assert.equal(looksBinary(buffer), false)
        globalThis.fetch = async () => new Response(buffer)
        const output = await m.directFetch(url(), undefined, cfg)
        assert.ok(output.buffer, JSON.stringify(output))
        assert.equal(m.decodeBuffer(output.buffer, '').text, source)
      }
    })
    await check('Markdown and CSV MIME types preserve literal HTML inside text', async () => {
      for (const [mime, text] of [['text/markdown', '# Example\n<div>literal example</div>\nend'], ['text/csv', 'name,example\nAlice,<p>literal example</p>']]) {
        globalThis.fetch = async () => new Response(text, { headers: { 'content-type': mime } })
        const output = await m.readUrl({ url: url() }, null, undefined, cfg)
        assert.equal(output.mode, 'text')
        assert.equal(output.text, text)
      }
    })
    await check('headerless binary bodies and BOM-prefixed control data remain rejected', async () => {
      for (const buffer of [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]), Buffer.from([0xff, 0xfe, 0, 0, 1, 0])]) {
        assert.equal(looksBinary(buffer), true)
        globalThis.fetch = async () => new Response(buffer)
        assert.match((await m.directFetch(url(), undefined, cfg)).error, /binary body/)
      }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  return passed
}
