import assert from 'node:assert/strict'
import { copyFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function runConfigBoundaryTests(m) {
  let passed = 0
  const check = async (name, fn) => {
    await fn()
    passed++
    console.log(`  ok - ${name}`)
  }
  const html = '<html><body><main><p>' + 'Readable fixture content. '.repeat(20) + '</p></main><a href="/next">下一页</a></body></html>'
  const register = (plugin, fetch, cfg) => {
    const tools = {}
    plugin.apply({
      tools: { register(t) { tools[t.name] = t } },
      effect() {},
      get: key => key === 'web' && fetch ? { fetch } : undefined,
    }, { spaRender: false, paginate: false, ...cfg })
    return tools
  }
  const originalFetch = globalThis.fetch
  try {
    for (const name of ['read_url', 'read_url_links', 'read_url_batch', 'read_url_site']) {
      await check(`${name} accepts fractional numeric configuration without timer errors`, async () => {
        const tools = register(m, async ({ url }) => ({ statusCode: 200, url, body: { kind: 'html', content: html } }), { timeoutMs: '500.9' })
        const url = `https://fractional-${name}.invalid/start`
        const result = await tools[name].execute(name === 'read_url_batch' ? { urls: [url] } : { url, maxPages: 2 })
        assert.ok(!result.error, JSON.stringify(result))
        if (name === 'read_url') assert.match(result.text, /Readable fixture content/)
        if (name === 'read_url_links') assert.equal(result.links.length, 1)
        if (name === 'read_url_batch') assert.equal(result.succeeded, 1)
        if (name === 'read_url_site') assert.equal(result.succeeded, 2)
        assert.ok(Number.isInteger(tools[name].timeoutMs))
      })
    }
    await check('fractional timeouts also work on explicitly selected direct origins', async () => {
      const origin = 'https://fractional-direct.invalid'
      let calls = 0
      globalThis.fetch = async () => { calls++; return new Response('Direct fixture body.', { headers: { 'content-type': 'text/plain' } }) }
      const tools = register(m, () => { throw new Error('Unexpected web provider') }, { timeoutMs: 500.9, directFetchOrigins: [origin] })
      const result = await tools.read_url.execute({ url: origin })
      assert.equal(result.text, 'Direct fixture body.')
      assert.equal(calls, 1)
    })
    await check('fractional page limits are rounded down before pagination and budget arithmetic', async () => {
      let calls = 0
      const tools = register(m, async ({ url }) => { calls++; return { statusCode: 200, url, body: { kind: 'html', content: html } } }, { paginate: true, paginateMax: 1.9 })
      const result = await tools.read_url.execute({ url: 'https://fractional-pages.invalid/start' })
      assert.match(result.text, /Readable fixture content/)
      assert.equal(calls, 1)
      assert.equal(result.paginated, undefined)
    })
    await check('failed proxy diagnostics never include proxy credentials in values or rendered output', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'dsh-proxy-diagnostic-'))
      try {
        await copyFile(new URL('./index.js', import.meta.url), join(dir, 'index.js'))
        await copyFile(new URL('./spa.js', import.meta.url), join(dir, 'spa.js'))
        await writeFile(join(dir, 'package.json'), '{"type":"module"}')
        const source = new URL('./proxy-fallback.js', import.meta.url).href
        await writeFile(join(dir, 'proxy-fallback.js'), `export * from ${JSON.stringify(source)};
export async function detectProxy() { return 'http://fixture_user:fixture_password@proxy.invalid:8080'; }
export async function fetchViaCurlProxy() { return null; }
`)
        const isolated = await import(pathToFileURL(join(dir, 'index.js')).href)
        globalThis.fetch = async () => { throw new Error('Controlled direct failure') }
        const tools = register(isolated, undefined, {})
        const result = await tools.read_url.execute({ url: 'https://proxy-diagnostic.invalid/start' })
        const rendered = tools.read_url.output.render({}, result)
        assert.match(result.error, /Controlled direct failure/)
        assert.match(result.error, /已尝试代理/)
        assert.doesNotMatch(JSON.stringify([result, rendered]), /fixture_user|fixture_password|proxy\.invalid/)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  return passed
}
