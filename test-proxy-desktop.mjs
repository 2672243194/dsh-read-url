import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { BlockList, isIP } from 'node:net'
import { runInNewContext } from 'node:vm'

export async function runProxyDesktopTests(sourceUrl = new URL('./proxy-fallback.js', import.meta.url)) {
  const source = readFileSync(sourceUrl, 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')
  const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const curl = 'C:\\Windows\\System32\\curl.exe'
  const cfg = { timeoutMs: 1000, maxBytes: 4096, userAgent: 'desktop-proxy-test' }
  const target = 'http://desktop-proxy.invalid/document'
  const proxy = 'http://127.0.0.1:12345'
  let passed = 0
  const check = async (label, fn) => {
    await fn()
    passed++
    console.log(`  ok - ${label}`)
  }
  const fixture = ({ platform = 'win32', env = { SystemRoot: 'C:\\Windows', PATH: '' }, present = [powershell, curl], fail = false, body = 'Desktop proxy body', processError } = {}) => {
    const calls = []
    const available = name => present.includes(name)
    const missing = () => Object.assign(new Error('tool unavailable'), { code: 'ENOENT' })
    const subject = runInNewContext(`${source}\n;({ detectProxy, fetchViaCurlProxy })`, {
      Buffer, Date, URL, win32, BlockList, isIP, process: { platform, env }, existsSync: available,
      execFileSync(name, args, options) {
        calls.push({ name, args, options })
        if (fail || !available(name)) throw missing()
        return '1\r\n127.0.0.1:12345\r\n'
      },
      execFile(name, args, options, callback) {
        calls.push({ name, args, options })
        if (fail || !available(name)) return callback(missing())
        if (processError) return callback(processError)
        callback(null, Buffer.concat([Buffer.from(body), Buffer.from(`\n200 text/plain ${target}`)]))
      },
    }, { filename: 'proxy-desktop-fixture.js' })
    return { subject, calls }
  }
  await check('Windows proxy discovery works without PowerShell on PATH', async () => {
    const { subject, calls } = fixture()
    assert.equal(await subject.detectProxy(), '127.0.0.1:12345')
    assert.equal(calls[0].name, powershell)
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(await subject.detectProxy(), '127.0.0.1:12345')
    assert.equal(calls.length, 1)
  })
  await check('Windows proxy requests work without curl on PATH and preserve cancellation', async () => {
    const { subject, calls } = fixture()
    const signal = new AbortController().signal
    const result = await subject.fetchViaCurlProxy(target, cfg, signal, proxy)
    assert.equal(result?.buffer.toString(), 'Desktop proxy body')
    assert.equal(result.finalUrl, target)
    assert.equal(calls[0].name, curl)
    assert.equal(calls[0].options.signal, signal)
    assert.equal(calls[0].options.windowsHide, true)
    assert.equal(calls[0].args[calls[0].args.indexOf('-x') + 1], proxy)
  })
  await check('WINDIR supplies tools when SystemRoot is missing or unavailable', async () => {
    for (const SystemRoot of [undefined, 'Z:\\MissingWindows', 'relative-root']) {
      const { subject, calls } = fixture({ env: { SystemRoot, WINDIR: 'C:\\Windows', PATH: '' } })
      assert.equal(await subject.detectProxy(), '127.0.0.1:12345')
      assert.equal((await subject.fetchViaCurlProxy(target, cfg, undefined, proxy))?.buffer.toString(), 'Desktop proxy body')
      assert.equal(calls[0].name, powershell)
      assert.equal(calls[1].name, curl)
    }
  })
  await check('Windows installations without system tool metadata retain PATH fallback', async () => {
    const { subject, calls } = fixture({ env: {}, present: ['powershell', 'curl'] })
    assert.equal(await subject.detectProxy(), '127.0.0.1:12345')
    assert.equal((await subject.fetchViaCurlProxy(target, cfg, undefined, proxy))?.buffer.toString(), 'Desktop proxy body')
    assert.equal(calls[0].name, 'powershell')
    assert.equal(calls[1].name, 'curl')
  })
  await check('Missing or blocked Windows utilities degrade without throwing', async () => {
    for (const options of [{ present: [] }, { fail: true }]) {
      const { subject } = fixture(options)
      assert.equal(await subject.detectProxy(), '')
      assert.equal(await subject.fetchViaCurlProxy(target, cfg, undefined, proxy), null)
    }
  })
  await check('Explicit proxy configuration bypasses Windows registry discovery', async () => {
    const { subject, calls } = fixture({ env: { HTTPS_PROXY: proxy, SystemRoot: 'C:\\Windows' } })
    assert.equal(await subject.detectProxy(), proxy)
    assert.equal(calls.length, 0)
  })
  await check('Linux and macOS continue to resolve curl through PATH', async () => {
    for (const platform of ['linux', 'darwin']) {
      const { subject, calls } = fixture({ platform, present: ['curl'] })
      assert.equal(await subject.detectProxy(), '')
      assert.equal((await subject.fetchViaCurlProxy(target, cfg, undefined, proxy))?.buffer.toString(), 'Desktop proxy body')
      assert.equal(calls[0].name, 'curl')
    }
  })
  await check('NO_PROXY skips exact domains and subdomains without matching lookalikes', async () => {
    const { subject } = fixture({ env: { HTTPS_PROXY: proxy, NO_PROXY: 'example.com,.internal.test,*.suffix.test' } })
    for (const url of ['https://example.com', 'https://www.example.com', 'https://EXAMPLE.com./', 'http://internal.test', 'http://sub.internal.test', 'http://sub.suffix.test']) {
      assert.equal(await subject.detectProxy(url), '', url)
    }
    for (const url of ['https://notexample.com', 'https://example.com.evil.test', 'http://internal.test.evil', 'http://notsuffix.test', 'http://suffix.test']) {
      assert.equal(await subject.detectProxy(url), proxy, url)
    }
    assert.equal(await subject.detectProxy(), proxy)
  })
  await check('NO_PROXY honors explicit and default ports', async () => {
    const { subject } = fixture({ env: { HTTPS_PROXY: proxy, NO_PROXY: 'example.com:8080,secure.test:443,plain.test:80' } })
    for (const url of ['http://example.com:8080', 'https://example.com:8080', 'https://secure.test', 'http://plain.test']) {
      assert.equal(await subject.detectProxy(url), '', url)
    }
    for (const url of ['http://example.com', 'https://example.com', 'http://secure.test', 'https://plain.test']) {
      assert.equal(await subject.detectProxy(url), proxy, url)
    }
  })
  await check('NO_PROXY matches IPv4 and canonical IPv6 addresses without widening exclusions', async () => {
    const { subject } = fixture({ env: { HTTPS_PROXY: proxy, NO_PROXY: '127.0.0.1,0:0:0:0:0:0:0:1,[2001:db8::1]:8080' } })
    for (const url of ['http://127.0.0.1:9090', 'http://[::1]', 'http://[2001:db8::1]:8080']) {
      assert.equal(await subject.detectProxy(url), '', url)
    }
    for (const url of ['http://127.0.0.2', 'http://127.0.0.1.example.com', 'http://[::2]', 'http://[2001:db8::1]:8081']) {
      assert.equal(await subject.detectProxy(url), proxy, url)
    }
  })
  await check('NO_PROXY supports curl CIDR address exclusions without DNS lookup', async () => {
    const { subject } = fixture({ env: { HTTPS_PROXY: proxy, NO_PROXY: '192.168.0.0/16,2001:db8::/32,10.0.0.0/999,invalid/24' } })
    for (const url of ['http://192.168.1.2', 'http://[2001:db8:1234::1]']) assert.equal(await subject.detectProxy(url), '', url)
    for (const url of ['http://192.169.1.2', 'http://[2001:db9::1]', 'http://10.0.0.1', 'http://example.com']) {
      assert.equal(await subject.detectProxy(url), proxy, url)
    }
  })
  await check('Lowercase no_proxy takes precedence and wildcard skips registry discovery', async () => {
    const { subject } = fixture({ env: { HTTPS_PROXY: proxy, no_proxy: 'lower.test', NO_PROXY: 'upper.test' } })
    assert.equal(await subject.detectProxy('http://lower.test'), '')
    assert.equal(await subject.detectProxy('http://upper.test'), proxy)
    const wildcard = fixture({ env: { SystemRoot: 'C:\\Windows', NO_PROXY: ' * ' } })
    assert.equal(await wildcard.subject.detectProxy(target), '')
    assert.equal(wildcard.calls.length, 0)
  })
  await check('Excluded URLs never spawn curl even with an explicit proxy override', async () => {
    const { subject, calls } = fixture({ env: { SystemRoot: 'C:\\Windows', NO_PROXY: 'desktop-proxy.invalid' } })
    assert.equal(await subject.fetchViaCurlProxy(target, cfg, undefined, proxy), null)
    assert.equal(calls.length, 0)
  })
  await check('Proxy URLs with brackets and braces are passed to curl without expansion', async () => {
    const { subject, calls } = fixture()
    for (const url of ['http://fixture.invalid/filter?fields[year]=2026', 'http://fixture.invalid/{first,second}']) {
      assert.ok((await subject.fetchViaCurlProxy(url, cfg, undefined, proxy))?.buffer)
      assert.equal(calls.at(-1).args.at(-1), url)
      assert.ok(calls.at(-1).args.includes('--globoff'))
    }
    assert.equal(calls.length, 2)
  })
  await check('Proxy retrieval enables HTTP decompression and preserves returned text', async () => {
    const { subject, calls } = fixture({ body: '压缩响应正文\nNext paragraph.' })
    const result = await subject.fetchViaCurlProxy(target, cfg, undefined, proxy)
    assert.equal(result.buffer.toString(), '压缩响应正文\nNext paragraph.')
    assert.ok(calls[0].args.includes('--compressed'))
    assert.equal(result.finalUrl, target)
  })
  await check('Decoded proxy body enforces its byte budget independently of metadata overhead', async () => {
    for (const size of [cfg.maxBytes, cfg.maxBytes + 1]) {
      const { subject } = fixture({ body: Buffer.alloc(size, 65) })
      const result = await subject.fetchViaCurlProxy(target, cfg, undefined, proxy)
      if (size === cfg.maxBytes) assert.equal(result.buffer.length, size)
      else assert.equal(result.error, `Page exceeds ${cfg.maxBytes} bytes (via proxy)`)
    }
    const { subject } = fixture({ body: '一'.repeat(Math.floor(cfg.maxBytes / 3) + 1) })
    assert.match((await subject.fetchViaCurlProxy(target, cfg, undefined, proxy)).error, /Page exceeds/)
  })
  await check('Curl and decoded stdout limits report size errors instead of proxy failure', async () => {
    for (const processError of [
      Object.assign(new Error('curl transfer exceeds limit'), { code: 63 }),
      Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }),
    ]) {
      const { subject } = fixture({ processError })
      const result = await subject.fetchViaCurlProxy(target, cfg, undefined, proxy)
      assert.equal(result.error, `Page exceeds ${cfg.maxBytes} bytes (via proxy)`)
    }
  })
  await check('Oversized curl diagnostics are not misreported as oversized page content', async () => {
    const { subject } = fixture({ processError: Object.assign(new Error('stderr maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }) })
    assert.equal(await subject.fetchViaCurlProxy(target, cfg, undefined, proxy), null)
  })
  return passed
}
