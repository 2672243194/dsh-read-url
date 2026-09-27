import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'

export async function runNetworkMaintenanceTests(m) {
  let passed = 0
  const cfg = {
    timeoutMs: 500, maxBytes: 3 * 1024 * 1024, maxChars: 6000,
    maxLinks: 20, cacheTtlMs: 300000, cacheMax: 32,
    spaRender: false, paginate: false, paginateMax: 3, userAgent: 'network-maintenance-test',
  }
  const requested = 'https://network-maintenance.invalid/start'
  const htmlResult = (url, content) => ({ url, statusCode: 200, body: { kind: 'html', content } })
  const shell = '<html><head><meta http-equiv="refresh" content="0; url=/target"></head>' +
    '<body><a href="/old">OLD_SHELL_LINK</a><p>Redirect shell, target content is still loading.</p></body></html>'
  const registeredTools = (fetch) => {
    const registered = {}
    const originalLog = console.log
    try {
      console.log = () => {}
      m.apply({
        get: key => key === 'web' ? { fetch } : undefined,
        effect() {},
        tools: { register(tool) { registered[tool.name] = tool } },
      }, cfg)
    } finally {
      console.log = originalLog
    }
    return registered
  }
  const check = async (name, run) => {
    await run()
    passed++
    console.log(`  ok - ${name}`)
  }
  const originalFetch = globalThis.fetch
  try {
    await check('completed Retry-After waits release their abort listeners', async () => {
      const ctrl = new AbortController()
      let calls = 0
      globalThis.fetch = async () => ++calls % 2
        ? new Response('', { status: 429, headers: { 'retry-after': '0' } })
        : new Response('Recovered body', { headers: { 'content-type': 'text/plain' } })
      for (let i = 0; i < 3; i++) {
        const output = await m.directFetch(requested, ctrl.signal, cfg)
        assert.equal(output.buffer.toString(), 'Recovered body')
        assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
      }
      assert.equal(calls, 6)
    })
    await check('cancelling Retry-After waits skips the second request and releases listeners', async () => {
      const ctrl = new AbortController()
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        return new Response('', { status: 503, headers: { 'retry-after': '5' } })
      }
      const pending = m.directFetch(requested, ctrl.signal, cfg)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(getEventListeners(ctrl.signal, 'abort').length, 1)
      ctrl.abort()
      assert.deepEqual(await pending, { error: 'cancelled' })
      assert.equal(calls, 1)
      assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    })
    await check('cancellation before Retry-After waiting returns an error-shaped result', async () => {
      const ctrl = new AbortController()
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        ctrl.abort()
        return new Response('', { status: 429, headers: { 'retry-after': '5' } })
      }
      assert.deepEqual(await m.directFetch(requested, ctrl.signal, cfg), { error: 'cancelled' })
      assert.equal(calls, 1)
      assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    })
    globalThis.fetch = async () => { throw new Error('Unexpected direct fetch') }
    for (const name of ['read_url_links', 'read_url_site']) {
      await check(`${name} rejects pre-cancelled calls without fetching`, async () => {
        const ctrl = new AbortController()
        ctrl.abort()
        let calls = 0
        const tools = registeredTools(async ({ url }) => { calls++; return htmlResult(url, shell) })
        assert.deepEqual(await tools[name].execute({ url: requested }, { signal: ctrl.signal }), { error: 'cancelled' })
        assert.equal(calls, 0)
      })
      await check(`${name} reports cancellation during its initial fetch`, async () => {
        const ctrl = new AbortController()
        let calls = 0
        const tools = registeredTools(async () => {
          calls++
          queueMicrotask(() => ctrl.abort())
          return new Promise(() => {})
        })
        assert.deepEqual(await tools[name].execute({ url: requested }, { signal: ctrl.signal }), { error: 'cancelled' })
        assert.equal(calls, 1)
      })
      await check(`${name} does not report a cancelled refresh shell as success`, async () => {
        const ctrl = new AbortController()
        const calls = []
        const tools = registeredTools(async ({ url }) => {
          calls.push(url)
          if (url === requested) return htmlResult(url, shell)
          queueMicrotask(() => ctrl.abort())
          return new Promise(() => {})
        })
        assert.deepEqual(await tools[name].execute({ url: requested }, { signal: ctrl.signal }), { error: 'cancelled' })
        assert.deepEqual(calls, [requested, 'https://network-maintenance.invalid/target'])
      })
      await check(`${name} still keeps the static shell on an ordinary refresh failure`, async () => {
        const tools = registeredTools(async ({ url }) => {
          if (url === requested) return htmlResult(url, shell)
          throw new Error('Controlled refresh failure')
        })
        const output = await tools[name].execute({ url: requested, maxDepth: 1, maxPages: 2 })
        assert.equal(output.error, undefined)
        if (name === 'read_url_links') {
          assert.equal(output.links[0].title, 'OLD_SHELL_LINK')
        } else {
          assert.equal(output.pages[0].url, requested)
          assert.equal(output.succeeded, 1)
        }
      })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  return passed
}
