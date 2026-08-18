// proxy-fallback.js — retry a failed direct fetch through the user's proxy
//
// Design: direct connect first, proxy only as fallback. When the direct
// fetch fails with a CONNECTION-class error (blocked network, refused,
// DNS miss, connect timeout), we look up the user's own proxy — first the
// standard HTTP_PROXY/HTTPS_PROXY env vars, then the Windows system proxy
// (registry) where proxy apps like Clash actually persist it — and retry
// once through it via the system `curl` (ships with Windows 10+/macOS/Linux;
// zero npm deps). The proxy URL is passed explicitly with `-x`, so we don't
// depend on curl's env-var reading.
//
// Transparency: a successful proxied read returns exactly like a direct one
// (the caller never knows); a failed proxied attempt returns null and the
// caller reports the ORIGINAL direct-connect error with a clear note, so the
// model/user can act (turn the proxy on, or accept the network boundary).
import { execFile, execFileSync } from 'node:child_process'

let sysProxyCache = null // '' = checked & absent; string = proxy URL

// Windows system proxy from the registry (HKCU Internet Settings). PowerShell
// is used because `reg.exe` is frequently blocked by security policy; the
// read is synchronous and cached after the first call (it only runs after a
// direct-connect failure, so the ~1s cost is invisible on the happy path).
function readWindowsSystemProxy() {
  if (sysProxyCache !== null) return sysProxyCache
  sysProxyCache = ''
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile', '-Command',
        "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyEnable, (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings').ProxyServer",
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const [enable, server] = out.trim().split(/\r?\n/).map((s) => s.trim())
    if (enable !== '1' || !server) return sysProxyCache
    // ProxyServer may be "host:port" or "http=...;https=host:port"
    const httpsPart = server.split(';').map((s) => s.trim()).find((s) => /^https=/i.test(s))
    sysProxyCache = (httpsPart ? httpsPart.replace(/^https=/i, '') : server) || ''
  } catch {
    sysProxyCache = ''
  }
  return sysProxyCache
}

// The user's proxy, in priority order: env vars, then Windows system proxy.
export async function detectProxy() {
  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  if (env) return env
  if (process.platform === 'win32') return readWindowsSystemProxy()
  return ''
}

// Returns { buffer, contentType, finalUrl } on success, { error } when the
// proxy answered but the target failed, or null when there is no proxy /
// curl is unavailable / the proxy itself is unreachable.
export async function fetchViaCurlProxy(url, cfg, externalSignal) {
  const proxy = await detectProxy()
  if (!proxy) return null
  const maxSec = Math.max(10, Math.ceil(cfg.timeoutMs / 1000) + 5)
  const args = [
    '-sS',
    '-L', // follow redirects, like the direct fetch path
    '--max-time', String(maxSec),
    '--max-filesize', String(cfg.maxBytes), // unit is BYTES, not KB
    '-x', proxy,
    '-A', cfg.userAgent,
    '-w', '\n%{http_code} %{content_type}',
    url,
  ]
  try {
    const buf = await new Promise((resolve, reject) => {
      execFile('curl', args, { maxBuffer: cfg.maxBytes + 8192, encoding: 'buffer', windowsHide: true, signal: externalSignal || undefined }, (err, stdout) => {
        if (err) return reject(err)
        resolve(stdout)
      })
    })
    // tail line carries the metadata: "<http_code> <content_type>"
    const nl = buf.lastIndexOf(0x0a)
    if (nl < 0) return null // no trailing metadata — abnormal response, treat as failure
    const meta = buf.subarray(nl + 1).toString('latin1').trim()
    const body = buf.subarray(0, nl)
    const [codeStr, ...ctParts] = meta.split(' ')
    const code = Number(codeStr)
    const contentType = ctParts.join(' ')
    if (!(code >= 200 && code < 300)) return { error: `HTTP ${code}` }
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return { error: `Unsupported content-type: ${contentType.split(';')[0]}` }
    }
    return { buffer: body, contentType, finalUrl: url, viaProxy: proxy }
  } catch (err) {
    // curl error 63 = exceeded --max-filesize (page too large, not a proxy
    // problem — report it as such instead of "proxy unreachable")
    if (err && err.code === 63) return { error: `Page exceeds ${cfg.maxBytes} bytes (via proxy)` }
    // curl missing, proxy down, or cancelled — let the caller report the
    // original direct-connect error (the proxy attempt is best-effort)
    return null
  }
}
