// dsh-read-url — DeepSeek Harness URL reader plugin
// Zero external dependencies (Node 20+ built-ins only).
// Aligned with DSH architecture:
//   - all network access goes through the ctx.web capability seam (official
//     docs/capability-seams.md), falling back to global fetch when absent
//   - cache is registered under ctx.effect, so unload fully reverts it
//     (temporal composability, docs/cordis-primer.md)
//   - cooperative tool-call timeout via ToolDefinition.timeoutMs + exec.signal
// Focus: token economy + smarter extraction for DSH agents.
//   - charset auto-detect (GBK/GB2312/UTF-8/Big5) via built-in TextDecoder
//   - clean main-content extraction (heuristic; optional @mozilla/readability upgrade path)
//   - HTML -> Markdown / plain text, paragraph-aligned smart truncation
//   - session-level cache, compact text render (lowest token cost)
import { TextDecoder } from 'node:util'
import { looksLikeSpa, renderPage, closeBrowser } from './spa.js'
import { detectProxy, fetchViaCurlProxy } from './proxy-fallback.js'
// Re-export for tests / programmatic (PTC) cleanup.
export { closeBrowser, renderPage, looksLikeSpa } from './spa.js'

export const name = 'dsh-read-url'
export const inject = ['tools']

// Plugin-level configuration (overridable via cordis.patch.yml `config:` row).
const DEFAULTS = {
  timeoutMs: 15000,
  maxBytes: 3 * 1024 * 1024,
  maxChars: 6000,
  maxLinks: 20,
  cacheTtlMs: 300000,
  cacheMax: 32,
  spaRender: true,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
}

const cache = new Map()
const decoders = new Map()

function getDecoder(enc) {
  let d = decoders.get(enc)
  if (!d) {
    try {
      d = new TextDecoder(enc, { fatal: false })
    } catch {
      d = new TextDecoder('utf-8')
    }
    decoders.set(enc, d)
  }
  return d
}

function sniffCharset(buffer, contentType) {
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '')
  if (m) return m[1]
  const head = buffer.subarray(0, 2048).toString('latin1').toLowerCase()
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
  if (meta) return meta[1]
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8'
  return null
}

export function decodeBuffer(buffer, contentType) {
  let enc = sniffCharset(buffer, contentType)
  if (!enc) enc = 'utf-8'
  enc = enc.toLowerCase().replace('gb2312', 'gbk').replace('gb_2312', 'gbk')
  let text
  try {
    text = getDecoder(enc).decode(buffer)
  } catch {
    text = new TextDecoder('utf-8').decode(buffer)
  }
  if (enc !== 'utf-8' && enc !== 'utf8' && /\uFFFD/.test(text.slice(0, 2000))) {
    const fixed = new TextDecoder('utf-8').decode(buffer)
    if (!/\uFFFD/.test(fixed.slice(0, 2000))) return { text: fixed, charset: 'utf-8' }
  }
  return { text, charset: enc }
}

// Direct-connect fetch, extracted so the race path can run it concurrently
// with the proxy attempt and abort it. Returns { buffer, contentType, finalUrl }
// on success or { error } — never throws (abort/timeout/network all mapped).
async function directFetch(url, signal, cfg) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: { 'user-agent': cfg.userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    if (!res.ok) return { error: `HTTP ${res.status} ${res.statusText}` }
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      return { error: `Unsupported content-type: ${contentType.split(';')[0]}` }
    }
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > cfg.maxBytes) return { error: `Page exceeds ${cfg.maxBytes} bytes` }
      chunks.push(chunk)
    }
    return { buffer: Buffer.concat(chunks), contentType, finalUrl: res.url }
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return { error: `Timeout after ${cfg.timeoutMs}ms or cancelled` }
    }
    // undici wraps the real reason in e.cause (ENOTFOUND / ECONNREFUSED /
    // connect-timeout / TLS) — surface it so the model can tell "bad domain"
    // from "blocked network" and act accordingly instead of retrying blindly
    const cause = e.cause && e.cause.message ? String(e.cause.message).slice(0, 90) : ''
    return { error: cause || (e.message || '').slice(0, 120) }
  }
}

// Settle-all race that resolves with the FIRST SUCCESSFUL result (a value
// with a buffer and no error). If every attempt fails it resolves with
// { success:false, failures:[...] } once the slowest one has settled —
// the proxy channel (curl --max-time ~20s) is the natural ceiling, and the
// direct fetch aborts on the same total budget.
// Settle-all race that resolves with the FIRST SUCCESSFUL result (a value
// with a buffer and no error). If every attempt fails it resolves with
// { success:false, failures:[...] } once the slowest one has settled —
// the proxy channel (curl --max-time ~20s) is the natural ceiling, and the
// direct fetch aborts on the same total budget.
export function raceFirstSuccess(promises) {
  return new Promise((resolve) => {
    const failures = []
    let settled = 0
    promises.forEach((p, i) => {
      p.then((v) => {
        if (v && !v.error && v.buffer) {
          resolve({ success: true, value: v })
          return
        }
        failures[i] = v
        settled += 1
        if (settled === promises.length) resolve({ success: false, failures })
      }).catch((e) => {
        failures[i] = { error: String((e && e.message) || e) }
        settled += 1
        if (settled === promises.length) resolve({ success: false, failures })
      })
    })
  })
}
async function raceFetch(url, externalSignal, cfg, proxy) {
  const directCtrl = new AbortController()
  const proxyCtrl = new AbortController()
  const withExt = (ctrl) =>
    externalSignal ? AbortSignal.any([externalSignal, ctrl.signal]) : ctrl.signal
  const directSignal = AbortSignal.any([withExt(directCtrl), AbortSignal.timeout(cfg.timeoutMs)])
  const direct = directFetch(url, directSignal, cfg)
  const proxied = fetchViaCurlProxy(url, cfg, withExt(proxyCtrl))
  const winner = await raceFirstSuccess([direct, proxied])
  directCtrl.abort()
  proxyCtrl.abort()
  return winner
}

async function fetchPage(url, externalSignal, cfg) {
  const proxy = await detectProxy()
  if (proxy) {
    const winner = await raceFetch(url, externalSignal, cfg, proxy)
    if (winner.success) return winner.value
    const dErr = winner.failures[0] && winner.failures[0].error
    const pErr = winner.failures[1]
    const px = pErr && pErr.error ? `，代理返回 ${pErr.error}` : '，代理未连通'
    return { error: `Fetch failed: ${dErr}（直连失败；已尝试代理 ${proxy}${px}）` }
  }
  // No proxy configured: plain direct connect (the original behaviour).
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs)
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal
  const r = await directFetch(url, signal, cfg)
  if (r.error) return { error: `Fetch failed: ${r.error}（直连失败，未检测到代理配置）` }
  return r
}

// Prefer the ctx.web capability seam (official docs/capability-seams.md):
// the web provider already decodes the document, so we skip our charset
// layer and only re-extract. Falls back to global fetch when absent.
// Seam calls get the same cooperative timeout as fetchPage (a hanging
// provider should not block the tool call forever).
async function fetchViaWebSeam(ctx, url, externalSignal, cfg) {
  const web = ctx && typeof ctx.get === 'function' ? ctx.get('web') : undefined
  if (!web || typeof web.fetch !== 'function') return null
  try {
    const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs)
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal
    const res = await web.fetch(url, { signal })
    if (!res || typeof res.content !== 'string') return null
    const finalUrl = res.url || res.finalUrl || url
    return { html: res.content, finalUrl }
  } catch {
    return null
  }
}

// Decode common HTML entities in already-stripped text. Runs AFTER tag
// stripping so escaped tags stay visible to the stripper and only remaining
// text is decoded. Covers the numeric/hex forms plus the named entities that
// actually show up in CJK web text (spaces, dashes, quotes, symbols) —
// undecoded leftovers would both waste tokens and read as garbage.
const ENTITIES = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ',
  sect: '§', para: '¶', dagger: '†', prime: '′', Prime: '″',
  permil: '‰', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾',
}
export function decodeTextEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-z][a-z0-9]{1,7}));?/gi, (m, dec, hex, name) => {
    if (dec !== undefined) {
      const c = Number(dec)
      return c > 0x10ffff ? m : String.fromCodePoint(c)
    }
    if (hex !== undefined) {
      const c = Number.parseInt(hex, 16)
      return c > 0x10ffff ? m : String.fromCodePoint(c)
    }
    const n = (name || '').toLowerCase()
    return Object.prototype.hasOwnProperty.call(ENTITIES, n) ? ENTITIES[n] : m
  })
}

function textOnly(html) {
  return decodeTextEntities(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<textarea[\s\S]*?<\/textarea\s*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim())
}

export function pickMain(html) {
  // Aggregation pages (e.g. blog homepages) have one <article> per item:
  // collect all of them instead of only the first.
  const articles = [...html.matchAll(/<article[\s>][\s\S]*?<\/article\s*>/gi)]
  if (articles.length) return articles.map((a) => a[0]).join('\n')
  const mainTag = /<(main|div)[^>]*role=["']main["'][\s>][\s\S]*?<\/\1\s*>/i.exec(html)
  if (mainTag) return mainTag[0]
  const body = /<body[\s>]/i.exec(html)
  if (body) {
    const after = html.slice(body.index)
    const end = after.search(/<\/body>/i)
    return end > 0 ? after.slice(0, end) : after
  }
  return html
}

// Some sites (e.g. baidu.com) ship CSS/HTML inside hidden <textarea> with
// entity-escaped tags (&lt;style&gt;...). Reveal them so noise rules can strip
// them; then run noise removal again.
function revealEscapedTags(html) {
  return html
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
}

function stripNoise(mainHtml) {
  return mainHtml
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(textarea|style|script|noscript|template)[\s>][\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(nav|footer|header|aside|form|iframe|svg|canvas|dialog)[\s>][\s\S]*?<\/\1>/gi, ' ')
    .replace(/<([a-z][a-z0-9]*)[^>]+class=["'][^"']*(ad-|ads|advert|banner|sidebar|social|share|comment|popup|modal|cookie)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, ' ')
}

// ---- HTML -> Markdown (lightweight, tag-state machine) ----
function escInline(s) {
  return s.replace(/([\\`*_[\]])/g, '\\$1')
}

export function inlineMd(html) {
  let out = ''
  const re = /<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1>|<[^>]+>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      out += escInline(decodeTextEntities(m[4]))
      continue
    }
    if (!m[1]) continue
    const tag = m[1].toLowerCase()
    if (tag === 'style' || tag === 'script' || tag === 'textarea' || tag === 'template' || tag === 'noscript') continue
    const inner = inlineMd(m[3])
    if (tag === 'a') {
      const href = /href=["']([^"']+)["']/i.exec(m[2])
      out += href ? `[${inner}](${href[1]})` : inner
    } else if (tag === 'strong' || tag === 'b') out += `**${inner}**`
    else if (tag === 'em' || tag === 'i') out += `*${inner}*`
    else if (tag === 'code') out += `\`${inner}\``
    else if (tag === 'br') out += '  \n'
    else out += inner
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

export function blockMd(html) {
  let out = ''
  const re = /<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1>|<[^>]+>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      out += decodeTextEntities(m[4])
      continue
    }
    if (!m[1]) continue
    const tag = m[1].toLowerCase()
    const attrs = m[2] || ''
    const inner = m[3]
    if (tag === 'style' || tag === 'script' || tag === 'textarea' || tag === 'template' || tag === 'noscript') {
      continue
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      const level = '#'.repeat(Number(tag[1]))
      out += `\n\n${level} ${inlineMd(inner)}`
    } else if (tag === 'p') {
      const t = inlineMd(inner)
      if (t) out += `\n\n${t}`
    } else if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main') {
      const t = blockMd(inner)
      if (t) out += `\n\n${t}`
    } else if (tag === 'blockquote') {
      const t = blockMd(inner).trim()
      out += `\n\n> ${t.replace(/\n/g, '\n> ')}`
    } else if (tag === 'pre') {
      const code = inner.replace(/<[^>]+>/g, '').trim()
      out += `\n\n\`\`\`\n${code}\n\`\`\``
    } else if (tag === 'code') {
      out += `\`${textOnly(inner)}\``
    } else if (tag === 'ul' || tag === 'ol') {
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi
      let lm, idx = 1, items = []
      while ((lm = liRe.exec(inner))) {
        const t = inlineMd(lm[1])
        items.push(tag === 'ol' ? `${idx}. ${t}` : `- ${t}`)
        idx++
      }
      if (items.length) out += `\n\n${items.join('\n')}`
    } else if (tag === 'li') {
      out += `\n- ${inlineMd(inner)}`
    } else if (tag === 'br') {
      out += '  \n'
    } else if (tag === 'hr') {
      out += '\n\n---'
    } else if (tag === 'table') {
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
      let tm, rows = []
      while ((tm = trRe.exec(inner))) {
        const cells = []
        const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi
        let cm
        while ((cm = tdRe.exec(tm[1]))) cells.push(inlineMd(cm[1]).replace(/\|/g, '\\|'))
        if (cells.length) rows.push(`| ${cells.join(' | ')} |`)
      }
      if (rows.length) {
        const header = rows[0]
        // unescape cells' escaped pipes before deriving the separator row,
        // otherwise the --- line is one char wider per escaped pipe
        const sep = header.replace(/\\\|/g, '|').replace(/[^|]/g, '-')
        out += `\n\n${rows.join('\n')}\n${sep}`
      }
    } else if (tag === 'a' || tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i') {
      const t = inlineMd(inner)
      if (t) out += t
    } else {
      const t = blockMd(inner)
      if (t) out += t
    }
  }
  return out
}

export function extract(html, mode) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  const siteName = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i.exec(html)
  const langMatch = /<html[^>]+lang=["']([\w-]+)["']/i.exec(html)
  let main = stripNoise(pickMain(html))
  main = stripNoise(revealEscapedTags(main))
  let bodyText
  if (mode === 'markdown') {
    bodyText = blockMd(main).replace(/\n{3,}/g, '\n\n').trim()
  } else {
    bodyText = textOnly(main).replace(/ +/g, ' ').trim()
  }
  return {
    title: titleMatch ? textOnly(titleMatch[1]) || titleMatch[1].trim() : '',
    siteName: siteName ? siteName[1] : '',
    lang: langMatch ? langMatch[1] : '',
    text: bodyText,
  }
}

// Optional enhancement: when @mozilla/readability + happy-dom are installed
// inside the DSH profile (npm i @mozilla/readability happy-dom), extraction
// upgrades to the Firefox Reader Mode algorithm. Falls back to the built-in
// heuristic extractor when absent. MPL-2.0 / MIT libraries, used as-is.
let readabilityReady = null
async function getReadabilityExtractor() {
  if (readabilityReady !== null) return readabilityReady
  try {
    const [{ Readability }, { Window }] = await Promise.all([
      import('@mozilla/readability'),
      import('happy-dom'),
    ])
    readabilityReady = (html, url) => {
      const window = new Window({ url })
      window.document.write(html)
      const article = new Readability(window.document).parse()
      return article ? article.content : null
    }
  } catch {
    readabilityReady = false
  }
  return readabilityReady
}

export function smartTruncate(text, maxChars, offset = 0) {
  const total = text.length
  if (offset >= total) {
    return { text: '', truncated: false, charsTotal: total, charsReturned: 0, charsStart: offset }
  }
  if (total <= maxChars && offset === 0) {
    return { text, truncated: false, charsTotal: total, charsReturned: total, charsStart: 0 }
  }
  const paragraphs = text.split(/\n\n+/)
  let pos = 0
  let start = 0
  for (let i = 0; i < paragraphs.length; i++) {
    if (pos + paragraphs[i].length > offset) {
      start = i
      break
    }
    pos += paragraphs[i].length + 2
  }
  let acc = ''
  for (let i = start; i < paragraphs.length; i++) {
    const p = paragraphs[i]
    if (acc.length + p.length + (acc ? 2 : 0) > maxChars) break
    acc += (acc ? '\n\n' : '') + p
  }
  if (!acc && maxChars > 0) acc = text.slice(offset, offset + maxChars)
  return {
    text: acc,
    truncated: offset + acc.length < total,
    charsTotal: total,
    charsReturned: acc.length,
    charsStart: offset,
  }
}

function extractLinks(html, limit, baseUrl) {
  const links = []
  const seen = new Set()
  // Accept relative hrefs too — most real pages link internally with relative
  // paths — and resolve them against the page URL so the model can follow them.
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) && links.length < limit) {
    const href = m[1].trim()
    if (!href || /^(javascript|mailto|tel|data):/i.test(href)) continue
    let url
    try {
      url = baseUrl ? new URL(href, baseUrl).href : new URL(href).href
    } catch {
      continue
    }
    // dedupe: nav bars repeat the same links many times — one entry per URL
    // keeps the link list compact (tokens) without losing coverage
    if (seen.has(url)) continue
    seen.add(url)
    const t = textOnly(m[2])
    if (t) links.push({ title: t.slice(0, 80), url })
  }
  return links
}

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function sliceFrom(full, offset, maxChars) {
  const s = smartTruncate(full.fullText, maxChars, offset)
  const out = {
    url: full.url,
    title: full.title || '',
    siteName: full.siteName || hostOf(full.url),
    lang: full.lang || '',
    charset: full.charset,
    mode: full.mode,
    truncated: s.truncated,
    charsTotal: s.charsTotal,
    charsReturned: s.charsReturned,
    charsStart: s.charsStart,
    text: s.text,
  }
  if (full.rendered) out.rendered = true
  if (full.spaHint) out.spaHint = full.spaHint
  if (Array.isArray(full.links)) out.links = full.links
  return out
}

export async function readUrl(args, ctx, externalSignal, cfg = DEFAULTS) {
  const url = String((args && args.url) || '').trim()
  if (!/^https?:\/\//i.test(url)) return { error: 'Only http/https URLs are supported' }
  const maxChars = Math.max(500, Math.min(20000, Number(args.maxChars) || cfg.maxChars))
  const mode = args.mode === 'markdown' ? 'markdown' : 'text'
  const offset = Math.max(0, Number(args.offset) || 0)

  // Cache stores the FULL extracted text keyed by url+mode+includeLinks, so
  // continuation reads (offset) and different maxChars hit the same entry —
  // but a links-request must not be served from a links-less cached copy.
  // The key drops the URL fragment: #sections would otherwise split the cache.
  let cacheUrl = url
  try {
    const u = new URL(url)
    u.hash = ''
    cacheUrl = u.href
  } catch {
    /* keep raw url on parse failure */
  }
  const cacheKey = `${cacheUrl}|${mode}|${args.includeLinks === true ? 'links' : 'no-links'}`
  const hit = cache.get(cacheKey)
  if (hit) {
    // Failed fetches are cached briefly so the model doesn't re-request a
    // broken URL in a loop (token + latency saver).
    if (hit.error) {
      if (Date.now() - hit.time < 30000) return { error: hit.error, cached: true }
      cache.delete(cacheKey)
    } else if (Date.now() - hit.time < cfg.cacheTtlMs) {
      const sliced = sliceFrom(hit.full, offset, maxChars)
      return { ...sliced, cached: true }
    }
  }

  let html, finalUrl, charset
  const viaSeam = await fetchViaWebSeam(ctx, url, externalSignal, cfg)
  if (viaSeam) {
    html = viaSeam.html
    finalUrl = viaSeam.finalUrl
    charset = 'provider-decoded'
  } else {
    const page = await fetchPage(url, externalSignal, cfg)
    if (page.error) {
      // Brief error cache: a failing URL usually stays failing for a while,
      // so serve the same error from cache instead of re-fetching.
      if (cache.size >= cfg.cacheMax) cache.delete(cache.keys().next().value)
      cache.set(cacheKey, { time: Date.now(), error: page.error })
      return { error: page.error }
    }
    const decoded = decodeBuffer(page.buffer, page.contentType)
    html = decoded.text
    finalUrl = page.finalUrl || url
    charset = decoded.charset
  }

  let extracted = extract(html, mode)
  // Optional readability upgrade: cleaner article extraction when installed.
  const ext = await getReadabilityExtractor()
  const upgrade = (target, htmlText) => {
    if (!ext) return target
    try {
      const clean = ext(htmlText, url)
      if (clean && clean.length > 0) {
        target.text = mode === 'markdown'
          ? blockMd(clean).replace(/\n{3,}/g, '\n\n').trim()
          : textOnly(clean).replace(/ +/g, ' ').trim()
      }
    } catch {
      // keep heuristic result
    }
    return target
  }
  extracted = upgrade(extracted, html)

  // Optional SPA enhancement: if the page looks client-rendered and static
  // extraction found almost nothing, try headless rendering (playwright).
  let rendered = false
  let spaHint = ''
  let renderedHtml = null
  if (cfg.spaRender !== false && looksLikeSpa(html) && (!extracted.text || extracted.text.length < 200)) {
    const rr = await renderPage(finalUrl || url, externalSignal)
    if (rr.html) {
      renderedHtml = rr.html
      const r2 = upgrade(extract(rr.html, mode), rr.html)
      if (r2.text && r2.text.length > extracted.text.length + 50) {
        extracted = r2
        finalUrl = rr.finalUrl || finalUrl
        rendered = true
      }
    } else {
      spaHint = rr.error
    }
  }

  const full = {
    url: finalUrl,
    title: extracted.title || '',
    siteName: extracted.siteName || '',
    lang: extracted.lang || '',
    charset,
    mode,
    fullText: extracted.text,
    rendered,
    spaHint,
    // Links come from the rendered DOM when available — otherwise the SPA
    // chain (content -> links -> next page) would break for JS-only pages.
    links: args.includeLinks === true ? extractLinks(renderedHtml || html, cfg.maxLinks, finalUrl) : undefined,
  }

  if (cache.size >= cfg.cacheMax) cache.delete(cache.keys().next().value)
  cache.set(cacheKey, { time: Date.now(), full })
  return sliceFrom(full, offset, maxChars)
}

function renderResult(value) {
  if (typeof value === 'string') return value
  const r = value || {}
  if (r.error) return `Error: ${r.error}`
  const lines = []
  if (r.title) lines.push(`title: ${r.title}`)
  const host = hostOf(r.url || '')
  const meta = []
  if (r.siteName && r.siteName !== host) meta.push(r.siteName)
  if (r.lang) meta.push(r.lang)
  if (r.charset) meta.push(`charset ${r.charset}`)
  if (meta.length) lines.push(meta.join(' · '))
  if (r.charsStart > 0) {
    lines.push(`(chars ${r.charsStart}+${r.charsReturned}/${r.charsTotal} — offset 续读)`)
  } else if (r.truncated) {
    lines.push(`(chars ${r.charsReturned}/${r.charsTotal} — 截断，offset 续读)`)
  } else if (typeof r.charsTotal === 'number') {
    lines.push(`(chars ${r.charsTotal})`)
  }
  if (r.cached) lines.push('(cached)')
  if (r.rendered) lines.push('(rendered — JS 执行后内容)')
  if (!r.text) {
    lines.push(r.spaHint
      ? `(无可读内容 — ${r.spaHint})`
      : '(无可读内容 — 登录墙 / SPA 页 / 空页面；SPA 需安装 playwright)')
  }
  lines.push('', r.text || '')
  if (Array.isArray(r.links) && r.links.length) {
    lines.push('', 'links:')
    for (const l of r.links) lines.push(`- ${l.title} — ${l.url}`)
  }
  return lines.join('\n')
}

function renderLinks(value) {
  if (typeof value === 'string') return value
  const r = value || {}
  if (r.error) return `Error: ${r.error}`
  if (!Array.isArray(r.links) || r.links.length === 0) return `No links found on ${r.url}`
  const lines = [`${r.count} link(s) on ${r.url}:`]
  for (const l of r.links) lines.push(`- ${l.title || l.url} — ${l.url}`)
  return lines.join('\n')
}

function readLinksTool(ctx, cfg) {
  return {
    name: 'read_url_links',
    description:
      'List links (text + URL) on a page without body text — lighter than read_url ' +
      'for mapping what a page points to. Renders SPA pages when playwright installed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http(s) URL to scan for links' },
        limit: { type: 'number', description: 'Max links to return (range 1-50, default from plugin config)' },
      },
      required: ['url'],
    },
    timeoutMs: 20000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string' },
          count: { type: 'number' },
          links: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderLinks(value) }],
    },
    async execute(args, exec) {
      const url = String((args && args.url) || '').trim()
      if (!/^https?:\/\//i.test(url)) return { error: 'Only http/https URLs are supported' }
      const limit = Math.max(1, Math.min(50, Number(args.limit) || cfg.maxLinks))
      const viaSeam = await fetchViaWebSeam(ctx, url, exec && exec.signal, cfg)
      let html, finalUrl
      if (viaSeam) {
        html = viaSeam.html
        finalUrl = viaSeam.finalUrl
      } else {
        const page = await fetchPage(url, exec && exec.signal, cfg)
        if (page.error) return { error: page.error }
        html = decodeBuffer(page.buffer, page.contentType).text
        finalUrl = page.finalUrl || url
      }
      let links = extractLinks(html, limit, finalUrl)
      // SPA fallback: a JS-only page yields no links from its static HTML;
      // render it and re-extract when the static result looks empty.
      if (links.length < 3 && cfg.spaRender !== false && looksLikeSpa(html)) {
        const rr = await renderPage(finalUrl || url, exec && exec.signal)
        if (rr.html) {
          const rl = extractLinks(rr.html, limit, rr.finalUrl || finalUrl)
          if (rl.length > links.length) {
            links = rl
            finalUrl = rr.finalUrl || finalUrl
          }
        }
      }
      return { url: finalUrl, count: links.length, links }
    },
  }
}

// Run async tasks with a concurrency cap (avoids hammering a site / getting
// rate-limited when reading many URLs at once).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

function renderBatch(value) {
  if (typeof value === 'string') return value
  const v = value || {}
  if (v.error) return `Error: ${v.error}`
  const lines = [`读取 ${v.succeeded}/${v.total} 页成功${v.failed ? `，${v.failed} 页失败` : ''}`]
  for (const p of v.pages) {
    if (p.error) {
      lines.push('', `[失败] ${p.url} — ${p.error}`)
      continue
    }
    const head = p.title || p.url
    lines.push('', `--- ${head} (${p.chars} 字符${p.cached ? ' · cached' : ''}) ---`, p.text || '(无可读内容)')
    if (Array.isArray(p.links) && p.links.length) {
      const ls = p.links.map((l) => l.title + ' — ' + l.url)
      lines.push(`links: ${ls.slice(0, 6).join(' | ')}${ls.length > 6 ? ` …共${ls.length}个` : ''}`)
    }
  }
  return lines.join('\n')
}

function readUrlBatchTool(ctx, cfg) {
  return {
    name: 'read_url_batch',
    description:
      'Read multiple URLs in parallel, each as a compact clean-content block ' +
      '(same extraction + session cache as read_url). Per-page failures isolated and tagged. ' +
      'Max 10 URLs, per-page capped at maxChars. For research/comparison across pages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'List of http(s) URLs to read (1-10)' },
        maxChars: { type: 'number', description: 'Max characters per page (range 500-20000, default 3000)' },
        mode: { type: 'string', enum: ['text', 'markdown'], description: 'text = plain (token-efficient, default); markdown = structured' },
        includeLinks: { type: 'boolean', description: 'Also return a bounded list of links per page (title+url)' },
      },
      required: ['urls'],
    },
    timeoutMs: Math.max(30000, cfg.timeoutMs + 15000),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          total: { type: 'number' },
          succeeded: { type: 'number' },
          failed: { type: 'number' },
          pages: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderBatch(value) }],
    },
    async execute(args, exec) {
      const a = args || {}
      const urls = (Array.isArray(a.urls) ? a.urls : []).map((u) => String(u).trim()).filter(Boolean)
      if (!urls.length) return { error: 'urls array is required (1-10 http(s) URLs)' }
      const list = urls.slice(0, 10)
      const perMax = Math.max(500, Math.min(20000, Number(a.maxChars) || 3000))
      const mode = a.mode === 'markdown' ? 'markdown' : 'text'
      const signal = exec && exec.signal
      const pages = await mapLimit(list, 4, (u) =>
        readUrl({ url: u, maxChars: perMax, mode, includeLinks: a.includeLinks === true }, ctx, signal, cfg),
      )
      const ok = pages.filter((p) => !p.error)
      return {
        total: list.length,
        succeeded: ok.length,
        failed: list.length - ok.length,
        pages: pages.map((p, i) => {
          if (p.error) return { url: list[i], error: p.error }
          const out = {
            url: p.url,
            title: p.title || '',
            chars: p.charsReturned,
            cached: p.cached === true,
            text: p.text,
          }
          if (Array.isArray(p.links) && p.links.length) out.links = p.links
          return out
        }),
      }
    },
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href
  } catch {
    return null
  }
}

// b is a bare hostname (hostOf() output) — must NOT be passed to new URL()
// as a full URL (that throws and would make every link look external).
function sameHost(a, b) {
  try {
    return new URL(a).hostname === b
  } catch {
    return false
  }
}

// URLs not worth crawling: static assets, login/auth paths, feeds, sitemaps.
const NOISE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|css|js|json|xml|pdf|zip|gz|tar|7z|mp3|mp4|avi|mov|webm|woff2?|ttf|eot|map)(\?|#|$)/i
const NOISE_PATH = /(\/login|\/signin|\/register|\/logout|\/signup|\/api\/|\/admin|\/wp-admin|\/wp-login|\/feed|\/rss|\/sitemap|\/robots\.txt|\/cdn-cgi)/i
function isNoiseUrl(url) {
  return NOISE_EXT.test(url) || NOISE_PATH.test(url)
}

// BFS crawl of a single site. Only same-host http(s) pages are followed;
// static assets / auth paths are skipped; visited URLs are deduped; a per-page
// failure is recorded and does not abort the crawl. No SPA rendering here —
// that is read_url's job; crawling favors speed and breadth.
async function crawlSite(entryUrl, cfg, opts, externalSignal) {
  const { maxPages, maxDepth, includeContent, perMax } = opts
  const host = hostOf(entryUrl)
  const visited = new Set()
  const pages = []
  const failures = []
  const queue = [{ url: entryUrl, depth: 0 }]
  while (queue.length && pages.length < maxPages) {
    // Never overshoot the page budget within a batch round.
    const batch = queue.splice(0, Math.min(2, maxPages - pages.length, queue.length))
    const results = await Promise.all(
      batch.map(async ({ url, depth }) => {
        const norm = normalizeUrl(url)
        if (!norm || visited.has(norm)) return null
        visited.add(norm)
        const page = await fetchPage(url, externalSignal, cfg)
        if (page.error) return { url, depth, error: page.error }
        const html = decodeBuffer(page.buffer, page.contentType).text
        const ex = extract(html, 'text')
        const links = extractLinks(html, 100, page.finalUrl || url)
        return {
          url: page.finalUrl || url,
          depth,
          title: ex.title || '',
          chars: ex.text.length,
          text: includeContent ? smartTruncate(ex.text, perMax).text : undefined,
          links,
        }
      }),
    )
    for (const r of results) {
      if (!r) continue
      if (r.error) {
        failures.push({ url: r.url, error: r.error })
        continue
      }
      pages.push(r)
      if (r.depth + 1 <= maxDepth) {
        for (const l of r.links) {
          if (!sameHost(l.url, host) || isNoiseUrl(l.url)) continue
          const n = normalizeUrl(l.url)
          if (n && !visited.has(n)) queue.push({ url: l.url, depth: r.depth + 1 })
        }
      }
    }
  }
  return { host, pages, failures }
}

function renderSite(value) {
  if (typeof value === 'string') return value
  const v = value || {}
  if (v.error) return `Error: ${v.error}`
  const lines = [`站点: ${v.host} · 爬取 ${v.succeeded}/${v.total} 页${v.failed ? ` · ${v.failed} 页失败` : ''}`]
  for (const p of v.pages) {
    const indent = '  '.repeat(p.depth)
    const head = p.title || p.url
    lines.push(`${indent}[${p.depth}] ${head} (${p.chars} 字符)  ${p.url}`)
    if (p.text) lines.push(`${indent}   ${p.text.slice(0, 80)}`)
  }
  for (const f of v.failures) lines.push(`[失败] ${f.url} — ${f.error}`)
  return lines.join('\n')
}

function readUrlSiteTool(ctx, cfg) {
  return {
    name: 'read_url_site',
    description:
      'Crawl a site BFS from one URL: dedupe same-host pages, return a compact site map ' +
      '(title + depth + size). Auth/static paths skipped; depth + page count capped; failures isolated. ' +
      'includeContent=true attaches a short summary per page (default off, token-efficient). ' +
      'Does not render SPA pages (use read_url for that).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http(s) entry URL of the site to crawl' },
        maxPages: { type: 'number', description: 'Max pages to crawl (range 2-50, default 15)' },
        maxDepth: { type: 'number', description: 'Max link depth from the entry page (range 1-5, default 2)' },
        includeContent: { type: 'boolean', description: 'Also return a short body summary per page (default false — structure only, token-efficient)' },
        maxCharsPerPage: { type: 'number', description: 'Summary length per page when includeContent=true (range 200-2000, default 500)' },
      },
      required: ['url'],
    },
    timeoutMs: 120000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          host: { type: 'string' },
          total: { type: 'number' },
          succeeded: { type: 'number' },
          failed: { type: 'number' },
          pages: { type: 'array', items: { type: 'object' } },
          failures: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSite(value) }],
    },
    async execute(args, exec) {
      const url = String((args && args.url) || '').trim()
      if (!/^https?:\/\//i.test(url)) return { error: 'Only http/https URLs are supported' }
      const maxPages = Math.max(2, Math.min(50, Number(args.maxPages) || 15))
      const maxDepth = Math.max(1, Math.min(5, Number(args.maxDepth) || 2))
      const includeContent = args.includeContent === true
      const perMax = Math.max(200, Math.min(2000, Number(args.maxCharsPerPage) || 500))
      const { host, pages, failures } = await crawlSite(
        url, cfg, { maxPages, maxDepth, includeContent, perMax }, exec && exec.signal,
      )
      return {
        host,
        total: pages.length + failures.length,
        succeeded: pages.length,
        failed: failures.length,
        pages: pages.map((p) => {
          const o = { url: p.url, depth: p.depth, title: p.title || '', chars: p.chars }
          if (p.text) o.text = p.text
          return o
        }),
        failures,
      }
    },
  }
}

export function apply(ctx, config) {
  // Plugin-level config from cordis.patch.yml (config row), merged over defaults.
  const cfg = { ...DEFAULTS, ...(config || {}) }

  // Temporal composability: unload must fully revert side effects.
  ctx.effect(() => () => {
    cache.clear()
    closeBrowser().catch(() => {})
  })

  console.log('[dsh-read-url] plugin loaded; tools read_url, read_url_batch, read_url_links, read_url_site registered')

  ctx.tools.register({
    name: 'read_url',
    description:
      'Fetch a page and return its clean main content (auto charset detect). ' +
      'text (default) = plain body capped at maxChars; markdown = headings/links/tables. ' +
      'Compact block: title, metadata, truncated body; 5-min session cache; ' +
      'SPA pages render when playwright installed; login walls are not accessible.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http(s) URL to read' },
        maxChars: { type: 'number', description: 'Max characters of body text to return (range 500-20000, default from plugin config)' },
        offset: { type: 'number', description: 'Start reading from this character offset (for continuing a long page). Default 0. Served from cache.' },
        mode: { type: 'string', enum: ['text', 'markdown'], description: 'text = plain (token-efficient, default); markdown = structured' },
        includeLinks: { type: 'boolean', description: 'Also return a bounded list of page links (title+url)' },
      },
      required: ['url'],
    },
    timeoutMs: Math.max(5000, cfg.timeoutMs + 5000),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          siteName: { type: 'string' },
          lang: { type: 'string' },
          charset: { type: 'string' },
          mode: { type: 'string' },
          truncated: { type: 'boolean' },
          charsTotal: { type: 'number' },
          charsReturned: { type: 'number' },
          text: { type: 'string' },
          links: { type: 'array', items: { type: 'object' } },
          cached: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      return readUrl(args, ctx, exec && exec.signal, cfg)
    },
  })

  ctx.tools.register(readLinksTool(ctx, cfg))
  ctx.tools.register(readUrlBatchTool(ctx, cfg))
  ctx.tools.register(readUrlSiteTool(ctx, cfg))
}
