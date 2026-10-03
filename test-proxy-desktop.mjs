import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { win32 } from 'node:path'
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
  const fixture = ({ platform = 'win32', env = { SystemRoot: 'C:\\Windows', PATH: '' }, present = [powershell, curl], fail = false } = {}) => {
    const calls = []
    const available = name => present.includes(name)
    const missing = () => Object.assign(new Error('tool unavailable'), { code: 'ENOENT' })
    const subject = runInNewContext(`${source}\n;({ detectProxy, fetchViaCurlProxy })`, {
      Buffer, Date, win32, process: { platform, env }, existsSync: available,
      execFileSync(name, args, options) {
        calls.push({ name, args, options })
        if (fail || !available(name)) throw missing()
        return '1\r\n127.0.0.1:12345\r\n'
      },
      execFile(name, args, options, callback) {
        calls.push({ name, args, options })
        if (fail || !available(name)) return callback(missing())
        callback(null, Buffer.from(`Desktop proxy body\n200 text/plain ${target}`))
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
  return passed
}
