import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

// A local optional-dependency fixture exercises the public rendering API.
export async function runLifecycleTests(source = fileURLToPath(new URL('.', import.meta.url))) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-'))
  for (const name of ['index.js', 'spa.js', 'proxy-fallback.js']) await copyFile(join(source, name), join(dir, name))
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  const fixtureDir = join(dir, 'node_modules', 'playwright')
  await mkdir(fixtureDir, { recursive: true })
  await writeFile(join(fixtureDir, 'package.json'), '{"name":"playwright","type":"module","exports":"./index.js"}')
  await writeFile(join(fixtureDir, 'index.js'), 'export const chromium = { launch: () => globalThis.__dshLifecycleFixture.launch() }')
  const original = globalThis.__dshLifecycleFixture
  const originalFetch = globalThis.fetch
  const m = await import(pathToFileURL(join(dir, 'index.js')).href)
  let passed = 0, failed = 0
  const makeState = () => {
    const state = { launches: 0, pages: [], browsers: [], onPage: null, onLaunch: null, onClose: null }
    state.launch = async () => {
      const number = ++state.launches
      if (state.onLaunch) await state.onLaunch(number)
      const browser = new EventEmitter()
      browser.close = async () => {
        if (state.onClose) await state.onClose(number)
        browser.emit('disconnected')
      }
      browser.newPage = async () => {
        const navigation = deferred()
        const page = {
          closes: 0,
          goto: async () => {},
          waitForTimeout: tick,
          evaluate: async () => 100,
          content: async () => '<article>Rendered fixture content.</article>',
          url: () => 'https://fixture.invalid/',
          close: async () => { page.closes++; navigation.resolve() },
          navigation,
        }
        state.pages.push(page)
        if (state.onPage) state.onPage(page)
        return page
      }
      state.browsers.push(browser)
      return browser
    }
    globalThis.__dshLifecycleFixture = state
    return state
  }
  const check = async (name, run) => {
    try { await run(makeState()); passed++; console.log(`  ok - ${name}`) }
    catch (error) { failed++; console.error(`  FAIL - ${name}: ${error.message}`) }
    finally { globalThis.fetch = originalFetch; await m.closeBrowser() }
  }
  console.log('SPA cancellation / browser lifecycle (local fixture)')
  try {
    await check('browser launch failures retain a compact cause and permit retry', async state => {
      state.onLaunch = number => { if (number === 1) throw new Error('spawn EPERM\nLong browser launch log') }
      const failed = await m.renderPage('https://fixture.invalid/')
      assert.equal(failed.error, 'Render failed: spawn EPERM')
      assert.ok((await m.renderPage('https://fixture.invalid/')).html)
      assert.equal(state.launches, 2)
    })
    await check('abort interrupts navigation and closes only its own page', async state => {
      const entered = deferred()
      state.onPage = page => { if (state.pages.length === 1) page.goto = () => { entered.resolve(); return page.navigation.promise } }
      const controller = new AbortController()
      const pending = m.renderPage('https://fixture.invalid/slow', controller.signal)
      await entered.promise
      const other = await m.renderPage('https://fixture.invalid/fast')
      controller.abort()
      let timer
      const early = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 500) })])
      clearTimeout(timer)
      state.pages[0].navigation.resolve()
      await pending
      assert.equal(early?.error, 'cancelled')
      assert.ok(other.html)
      assert.equal(state.pages[0].closes, 1)
      assert.equal(state.launches, 1)
    })
    await check('abort during browser launch does not create a page', async state => {
      const launched = deferred(), release = deferred()
      state.onLaunch = async () => { launched.resolve(); await release.promise }
      const controller = new AbortController()
      const pending = m.renderPage('https://fixture.invalid/', controller.signal)
      await launched.promise
      controller.abort()
      release.resolve()
      assert.equal((await pending).error, 'cancelled')
      assert.equal(state.pages.length, 0)
    })
    await check('a disconnected shared browser is relaunched', async state => {
      await m.renderPage('https://fixture.invalid/')
      state.browsers[0].emit('disconnected')
      await m.renderPage('https://fixture.invalid/')
      assert.equal(state.launches, 2)
    })
    await check('an older failed launch cannot evict a newer browser', async state => {
      const launched = deferred(), release = deferred()
      state.onLaunch = async number => { if (number === 1) { launched.resolve(); await release.promise } }
      const first = m.renderPage('https://fixture.invalid/first')
      await launched.promise
      const closing = m.closeBrowser()
      await m.renderPage('https://fixture.invalid/second')
      release.reject(new Error('launch refused'))
      await first
      await closing
      await m.renderPage('https://fixture.invalid/third')
      assert.equal(state.launches, 2)
    })
    await check('concurrent browser cleanup waits for the same shutdown', async state => {
      await m.renderPage('https://fixture.invalid/')
      const entered = deferred(), release = deferred()
      state.onClose = async () => { entered.resolve(); await release.promise }
      const first = m.closeBrowser()
      await entered.promise
      let settled = false
      const second = m.closeBrowser().then(() => { settled = true })
      await tick()
      const early = settled
      release.resolve()
      await Promise.all([first, second])
      assert.equal(early, false)
    })
    await check('plugin disposal returns and awaits browser shutdown', async state => {
      await m.renderPage('https://fixture.invalid/')
      const release = deferred()
      state.onClose = () => release.promise
      let dispose
      m.apply({ tools: { register() {} }, effect(fn) { dispose = fn() } }, {})
      const result = dispose()
      let settled = false
      const done = Promise.resolve(result).then(() => { settled = true })
      await tick()
      const early = settled
      release.resolve()
      await done
      assert.equal(typeof result?.then, 'function')
      assert.equal(early, false)
    })
    await check('DOM evaluation failures must be consecutive before stopping', async state => {
      let count = 0
      state.onPage = page => { page.evaluate = async () => {
        count++
        if (count === 1 || count === 3) throw new Error('transient navigation')
        return count < 4 ? 30 : 100
      } }
      assert.ok((await m.renderPage('https://fixture.invalid/')).html)
      assert.equal(count, 5)
    })
    const shell = '<html><head><title>Static shell</title>' + '<script src="/boot.js"></script>'.repeat(5) + '</head><body><div id="app"></div></body></html>'
    const cfg = {
      timeoutMs: 500, maxBytes: 3 * 1024 * 1024, maxChars: 6000,
      maxLinks: 20, cacheTtlMs: 0, cacheMax: 32,
      spaRender: true, paginate: false, paginateMax: 3, userAgent: 'lifecycle-test',
      directFetchOrigins: ['https://direct-lifecycle.invalid'],
    }
    const providerResult = (url, content) => ({ url, statusCode: 200, body: { kind: 'html', content }, truncated: false })
    const redirect = url => `<meta http-equiv="refresh" content="0; url=${url}">`
    await check('read_url_links cancellation during rendering closes the page without returning old links', async state => {
      const requested = 'https://provider-lifecycle.invalid/cancel-links-render'
      const entered = deferred()
      state.onPage = page => { page.goto = () => { entered.resolve(); return page.navigation.promise } }
      const controller = new AbortController()
      const registered = new Map()
      let dispose
      m.apply({
        get: () => ({ fetch: async ({ url }) => {
          assert.equal(url, requested)
          return providerResult(url, shell.replace('<div id="app"></div>', '<a href="/old">OLD_SHELL_LINK</a>'))
        } }),
        tools: { register(tool) { registered.set(tool.name, tool) } },
        effect(fn) { dispose = fn() },
      }, { ...cfg, directFetchOrigins: [] })
      try {
        const pending = registered.get('read_url_links').execute({ url: requested }, { signal: controller.signal })
        await entered.promise
        controller.abort()
        const output = await pending
        assert.deepEqual(output, { error: 'cancelled' })
        assert.equal(state.pages.length, 1)
        assert.equal(state.pages[0].closes, 1)
      } finally { controller.abort(); await dispose() }
    })
    await check('explicit direct read_url retains static content without launching a browser', async state => {
      const requested = 'https://direct-lifecycle.invalid/read-shell'
      let directCalls = 0, providerCalls = 0
      globalThis.fetch = async url => {
        assert.equal(String(url), requested)
        directCalls++
        return new Response(shell, { headers: { 'Content-Type': 'text/html' } })
      }
      const ctx = { get: () => ({ fetch: async () => { providerCalls++; throw new Error('URL resolves to a non-public IP address') } }) }
      const output = await m.readUrl({ url: requested }, ctx, undefined, cfg)
      assert.equal(output.error, undefined)
      assert.equal(directCalls, 1)
      assert.equal(providerCalls, 0)
      assert.equal(state.launches, 0)
      assert.match(output.spaHint, /static|静态/i)
    })
    await check('a provider-to-direct meta-refresh chain neither leaves the allowed origin nor launches a browser', async state => {
      const requested = 'https://provider-lifecycle.invalid/start-chain'
      const directUrl = 'https://direct-lifecycle.invalid/relay-chain'
      const finalUrl = 'https://provider-lifecycle.invalid/final-chain'
      const providerCalls = []
      let directCalls = 0
      globalThis.fetch = async url => {
        assert.equal(String(url), directUrl)
        directCalls++
        return new Response(redirect(finalUrl) + shell, { headers: { 'Content-Type': 'text/html' } })
      }
      const ctx = { get: () => ({ fetch: async ({ url }) => {
        providerCalls.push(url)
        assert.equal(url, requested)
        return providerResult(url, redirect(directUrl))
      } }) }
      const output = await m.readUrl({ url: requested }, ctx, undefined, cfg)
      assert.equal(output.error, undefined)
      assert.equal(output.url, directUrl)
      assert.deepEqual(providerCalls, [requested])
      assert.equal(directCalls, 1)
      assert.equal(state.launches, 0)
      assert.match(output.spaHint, /static|静态/i)
    })
    await check('read_url_links does not render a provider meta-refresh target fetched through an explicit direct origin', async state => {
      const requested = 'https://provider-lifecycle.invalid/links-entry'
      const directUrl = 'https://direct-lifecycle.invalid/links-shell'
      const registered = new Map()
      let dispose, directCalls = 0, providerCalls = 0
      globalThis.fetch = async url => {
        assert.equal(String(url), directUrl)
        directCalls++
        return new Response(shell, { headers: { 'Content-Type': 'text/html' } })
      }
      const ctx = {
        get: () => ({ fetch: async ({ url }) => {
          assert.equal(url, requested)
          providerCalls++
          return providerResult(url, redirect(directUrl))
        } }),
        tools: { register(tool) { registered.set(tool.name, tool) } },
        effect(fn) { dispose = fn() },
      }
      m.apply(ctx, cfg)
      try {
        const output = await registered.get('read_url_links').execute({ url: requested }, {})
        assert.equal(output.error, undefined)
        assert.equal(output.url, directUrl)
        assert.equal(output.count, 0)
        assert.equal(directCalls, 1)
        assert.equal(providerCalls, 1)
        assert.equal(state.launches, 0)
        assert.match(output.spaHint, /static|静态/i)
      } finally { await dispose() }
    })
  } finally { globalThis.fetch = originalFetch; globalThis.__dshLifecycleFixture = original }
  assert.equal(failed, 0, `${failed} lifecycle checks failed`)
  return passed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`${await runLifecycleTests(process.argv[2])} lifecycle assertions passed`)
}
