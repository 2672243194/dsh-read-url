// proxy-fallback.js — optional proxy channel for direct webpage retrieval
//
// When the host web provider is absent, configured proxy retrieval races
// native fetch and the first success wins. Proxy discovery uses standard
// HTTP_PROXY/HTTPS_PROXY env vars, then the Windows system proxy registry.
// NO_PROXY exclusions retain only the native fetch. Proxy requests use system
// curl (Windows 10+/macOS/Linux; zero npm deps) with an explicit `-x` URL.
//
// Successful proxy responses use the direct channel's body shape. HTTP and
// content errors remain diagnostic; unavailable curl or proxies return null.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { BlockList, isIP } from 'node:net'

// Desktop launches can inherit a reduced PATH. Prefer the Windows-shipped
// utilities when present; other platforms and custom installations use PATH.
function systemExecutable(name) {
  if (process.platform !== 'win32') return name
  const parts = name === 'powershell'
    ? ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe']
    : ['System32', 'curl.exe']
  for (const root of [process.env.SystemRoot, process.env.WINDIR]) {
    if (typeof root !== 'string' || !win32.isAbsolute(root)) continue
    const executable = win32.join(root, ...parts)
    if (existsSync(executable)) return executable
  }
  return name
}

// Some servers omit the Content-Type header entirely; the content-type gate
// then has nothing to test and a binary body (PDF/PNG/zip) would flow into
// the HTML pipeline as mojibake. Sniff the leading bytes instead: text
// documents never contain NUL bytes or a run of control characters.
// Shared by the direct path (index.js) and the curl proxy path below.
export function looksBinary(buffer) {
  const n = Math.min(buffer.length, 512)
  if (!n) return false
  const utf16le = buffer[0] === 0xff && buffer[1] === 0xfe
  const utf16be = buffer[0] === 0xfe && buffer[1] === 0xff
  if ((utf16le || utf16be) && buffer.length % 2 === 0) {
    let controls = 0
    let units = 0
    for (let i = 2; i + 1 < n; i += 2) {
      const code = utf16le ? buffer[i] | (buffer[i + 1] << 8) : (buffer[i] << 8) | buffer[i + 1]
      if (code === 0) return true
      if (code < 9 || (code > 13 && code < 32)) controls++
      units++
    }
    return units > 0 && controls / units > 0.3
  }
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const b = buffer[i]
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) ctrl++
  }
  return ctrl / n > 0.3
}

// Shared by direct and proxy retrieval so a document's route cannot change
// which text formats are accepted. Structured suffixes include vendor APIs.
export function isFetchableContentType(contentType) {
  const mime = (contentType || '').split(';', 1)[0].trim().toLowerCase()
  return ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/json', 'application/xml', 'text/xml'].includes(mime) ||
    /^[a-z][a-z0-9!#$&^_.+-]{0,63}\/(?:[a-z0-9!#$&^_.+-]{1,127}\+)?(?:json|xml)$/.test(mime)
}

let sysProxyCache = null // '' = checked & absent; string = proxy URL
let sysProxyCheckedAt = 0 // cache timestamp; a failed read is re-tried after 60s
const SYS_PROXY_RETRY_MS = 60 * 1000

// Windows system proxy from the registry (HKCU Internet Settings). PowerShell
// is used because `reg.exe` is frequently blocked by security policy; the
// read is synchronous and cached to avoid repeated discovery during reads.
// A FAILED read is cached as '' but re-tried after 60s — an environment that
// transiently blocks the PowerShell child (EDR, policy) should not starve
// the whole session of the proxy.
function readWindowsSystemProxy() {
  const now = Date.now()
  if (sysProxyCache !== null && now - sysProxyCheckedAt < SYS_PROXY_RETRY_MS) return sysProxyCache
  sysProxyCache = ''
  sysProxyCheckedAt = now
  try {
    const out = execFileSync(
      systemExecutable('powershell'),
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
    return sysProxyCache
  } catch {
    sysProxyCache = ''
    return sysProxyCache
  }
}

// Match curl's domain/IP exclusions before starting a redundant direct curl
// request. Port-qualified hosts and wildcard suffixes are also accepted.
function bypassesProxy(url) {
  const exclusions = process.env.no_proxy || process.env.NO_PROXY
  if (!url || !exclusions) return false
  let target
  try { target = new URL(url) } catch { return false }
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const ipVersion = isIP(hostname)
  const port = target.port || (target.protocol === 'https:' ? '443' : '80')
  for (let entry of exclusions.split(',')) {
    entry = entry.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    const slash = entry.indexOf('/')
    if (slash >= 0) {
      const address = entry.slice(0, slash)
      const prefix = entry.slice(slash + 1)
      if (!ipVersion || isIP(address) !== ipVersion || !/^\d{1,3}$/.test(prefix)) continue
      try {
        const block = new BlockList()
        const family = ipVersion === 6 ? 'ipv6' : 'ipv4'
        block.addSubnet(address, Number(prefix), family)
        if (block.check(hostname, family)) return true
      } catch {}
      continue
    }
    let entryPort = ''
    if (entry.startsWith('[')) {
      const end = entry.indexOf(']')
      if (end < 0) continue
      const tail = entry.slice(end + 1)
      if (tail && !/^:\d{1,5}$/.test(tail)) continue
      entryPort = tail.slice(1)
      entry = entry.slice(1, end)
    } else if (!isIP(entry) && entry.indexOf(':') >= 0) {
      const colon = entry.lastIndexOf(':')
      entryPort = entry.slice(colon + 1)
      entry = entry.slice(0, colon)
      if (entry.includes(':') || !/^\d{1,5}$/.test(entryPort)) continue
    }
    if (entryPort && Number(entryPort) !== Number(port)) continue
    if (isIP(entry)) {
      if (!ipVersion) continue
      try {
        const canonical = new URL(isIP(entry) === 6 ? `http://[${entry}]` : `http://${entry}`).hostname
          .replace(/^\[|\]$/g, '')
        if (canonical === hostname) return true
      } catch {}
      continue
    }
    if (ipVersion) continue
    if (entry.startsWith('*.')) {
      if (hostname.endsWith(entry.slice(1).replace(/\.$/, ''))) return true
      continue
    }
    else if (entry.startsWith('.')) entry = entry.slice(1)
    entry = entry.replace(/\.$/, '')
    if (entry && (hostname === entry || hostname.endsWith(`.${entry}`))) return true
  }
  return false
}

// The user's proxy, in priority order: env vars, then Windows system proxy.
export async function detectProxy(url) {
  if (bypassesProxy(url)) return ''
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
// `proxyOverride` lets the caller pass an already-detected proxy (the race
// path probes once up front) instead of re-detecting here.
export async function fetchViaCurlProxy(url, cfg, externalSignal, proxyOverride) {
  if (bypassesProxy(url)) return null
  const proxy = proxyOverride || (await detectProxy(url))
  if (!proxy) return null
  const maxSec = Math.max(10, Math.ceil(cfg.timeoutMs / 1000) + 5)
  const args = [
    '-sS',
    '--globoff',
    '--compressed', // request and decode supported HTTP content encodings
    '-L', // follow redirects, like the direct fetch path
    '--max-time', String(maxSec),
    '--max-filesize', String(cfg.maxBytes), // unit is BYTES, not KB
    '-x', proxy,
    '-A', cfg.userAgent,
    // trailing metadata line: "<code> <content_type> <url_effective>"
    // (url_effective last: content_type may be empty, URLs never contain
    // unencoded spaces — parse from both ends so the final URL of a redirect
    // chain survives).
    '-w', '\n%{http_code} %{content_type} %{url_effective}',
    url,
  ]
  try {
    const buf = await new Promise((resolve, reject) => {
      execFile(systemExecutable('curl'), args, { maxBuffer: cfg.maxBytes + 8192, encoding: 'buffer', windowsHide: true, signal: externalSignal || undefined }, (err, stdout) => {
        if (err) return reject(err)
        resolve(stdout)
      })
    })
    // tail line carries the metadata: "<code> <content_type> <url_effective>"
    const nl = buf.lastIndexOf(0x0a)
    if (nl < 0) return null // no trailing metadata — abnormal response, treat as failure
    const meta = buf.subarray(nl + 1).toString('latin1').trim()
    const body = buf.subarray(0, nl)
    // Older curl versions bound the compressed transfer, not the decoded
    // body. Do not let the metadata allowance enlarge the content budget.
    if (body.length > cfg.maxBytes) return { error: `Page exceeds ${cfg.maxBytes} bytes (via proxy)` }
    const parts = meta.split(' ')
    const codeStr = parts.shift()
    const finalUrlEff = parts.length > 1 ? parts.pop() : url
    const code = Number(codeStr)
    const contentType = parts.join(' ')
    if (code >= 200 && code < 300) {
      // Headerless responses: gate binary bodies out (same rule as the direct
      // path — curl writes an empty %{content_type} then).
      if (!contentType && looksBinary(body)) {
        return { error: 'Unsupported content-type (no header, binary body)' }
      }
    }
    if (!(code >= 200 && code < 300)) return { error: `HTTP ${code}` }
    if (contentType && !isFetchableContentType(contentType)) {
      return { error: `Unsupported content-type: ${contentType.split(';')[0]}` }
    }
    return { buffer: body, contentType, finalUrl: finalUrlEff, viaProxy: proxy }
  } catch (err) {
    // curl error 63 = exceeded --max-filesize (page too large, not a proxy
    // problem — report it as such instead of "proxy unreachable")
    if (err && (err.code === 63 || (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && err.message.startsWith('stdout')))) {
      return { error: `Page exceeds ${cfg.maxBytes} bytes (via proxy)` }
    }
    // curl missing, proxy down, or cancelled — let the caller report the
    // original direct-connect error (the proxy attempt is best-effort)
    return null
  }
}
