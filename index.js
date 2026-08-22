// dsh-read-url — DeepSeek Harness URL reader plugin
// Zero external dependencies (Node 20+ built-ins only).
// Aligned with DSH architecture:
//   - all network access goes through the ctx.web capability seam (official
//     docs/capability-seams.md), falling back to global fetch when absent
//   - cache is registered under ctx.effect, so unload fully reverts it
//     (temporal composability, docs/cordis-primer.md)
//   - cooperative tool-call timeout via ToolDefinition.timeoutMs + exec.signal
// Focus: token economy + smarter extraction for DSH agents.
//   - charset auto-detect (BOM UTF-16 / GBK/GB2312/UTF-8/Big5/Shift-JIS)
//   - content dispatch: HTML / JSON APIs / RSS-Atom feeds natively
//   - clean main-content extraction (heuristic; optional @mozilla/readability upgrade path)
//     + text-density fallback on the body path
//   - auto-joined pagination, page metadata (published/author)
//   - HTML -> Markdown / plain text, paragraph-aligned smart truncation
//   - session-level cache, compact text render (lowest token cost)
import { TextDecoder } from 'node:util'
import { looksLikeSpa, renderPage, closeBrowser, looksLikeChallenge } from './spa.js'
import { detectProxy, fetchViaCurlProxy, looksBinary } from './proxy-fallback.js'
// Re-export for tests / programmatic (PTC) cleanup.
export { closeBrowser, renderPage, looksLikeSpa, looksLikeChallenge } from './spa.js'

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
  paginate: true,
  paginateMax: 3,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
}

// Session-level cache: url -> { time, full }. Failures live in a separate
// small map so short-lived error entries never evict hot success pages.
const cache = new Map()
const failCache = new Map()
const FAIL_CACHE_MAX = 8
function cacheFail(key, error) {
  if (failCache.size >= FAIL_CACHE_MAX) failCache.delete(failCache.keys().next().value)
  failCache.set(key, { time: Date.now(), error })
}
function cacheStore(key, full, cacheMax) {
  if (cache.size >= cacheMax) cache.delete(cache.keys().next().value)
  cache.set(key, { time: Date.now(), full })
}
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
  // BOM first — byte-level evidence beats any declared charset (a UTF-16 body
  // with a latin1-read <meta> probe garbles the meta match anyway).
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8'
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le'
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be'
  const m = /charset=["']?([\w-]+)/i.exec(contentType || '')
  if (m) return m[1]
  const head = buffer.subarray(0, 2048).toString('latin1').toLowerCase()
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)
  if (meta) return meta[1]
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

// Content types this plugin can consume. Beyond HTML: JSON (data APIs) and
// XML (RSS/Atom feeds) are read natively — see readUrl's type dispatch.
// Note "application/rss+xml": the separator before xml is '+', not '/'.
const FETCHABLE_CT = /text\/html|application\/xhtml|text\/plain|\/json|[+/]xml/i

// Retry-After header (seconds form) → ms, capped; undefined when absent/invalid.
function retryAfterMs(res) {
  const v = res.headers.get('retry-after')
  if (!v) return undefined
  const sec = Number(v)
  if (!Number.isFinite(sec) || sec < 0) return undefined
  return Math.min(sec * 1000, 5000)
}

// Single fetch attempt. Never throws; maps abort/timeout/network to { error }.
async function directFetchOnce(url, signal, cfg) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: { 'user-agent': cfg.userAgent, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    })
    // Early-return paths must cancel the body stream, or the connection is
    // held open undrained and cannot return to the keep-alive pool.
    const discardBody = () => { if (res.body) res.body.cancel().catch(() => {}) }
    if (!res.ok) {
      // Rate-limit / temporary-overload: honor Retry-After with one retry
      // (capped at 5s so the cooperative timeout still bounds the call).
      if (res.status === 429 || res.status === 503) {
        const ra = retryAfterMs(res)
        discardBody()
        if (ra !== undefined) return { retryAfterMs: ra }
      }
      discardBody()
      return { error: `HTTP ${res.status} ${res.statusText}` }
    }
    const contentType = res.headers.get('content-type') || ''
    if (contentType && !FETCHABLE_CT.test(contentType)) {
      discardBody()
      return { error: `Unsupported content-type: ${contentType.split(';')[0]}` }
    }
    if (!res.body) return { buffer: Buffer.alloc(0), contentType, finalUrl: res.url }
    const chunks = []
    let size = 0
    for await (const chunk of res.body) {
      size += chunk.length
      if (size > cfg.maxBytes) { discardBody(); return { error: `Page exceeds ${cfg.maxBytes} bytes` } }
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    // Headerless responses: gate binary bodies out of the HTML pipeline.
    if (!contentType && looksBinary(buffer)) {
      return { error: 'Unsupported content-type (no header, binary body)' }
    }
    return { buffer, contentType, finalUrl: res.url }
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

// Direct-connect fetch with a single Retry-After-aware retry on 429/503.
async function directFetch(url, signal, cfg) {
  const first = await directFetchOnce(url, signal, cfg)
  if (first && first.retryAfterMs !== undefined && !(signal && signal.aborted)) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, first.retryAfterMs)
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
    })
    return directFetchOnce(url, signal, cfg)
  }
  return first
}

// Settle-all race that resolves with the FIRST SUCCESSFUL result (a value
// with a buffer and no error). If every attempt fails it resolves with
// { success:false, failures:[...] } once the slowest one has settled —
// the proxy channel (curl --max-time ~20s) is the natural ceiling, and the
// direct fetch aborts on the same total budget.
export function raceFirstSuccess(promises) {
  return new Promise((resolve) => {
    if (promises.length === 0) {
      resolve({ success: false, failures: [] })
      return
    }
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
  const proxied = fetchViaCurlProxy(url, cfg, withExt(proxyCtrl), proxy)
  const winner = await raceFirstSuccess([direct, proxied])
  directCtrl.abort()
  proxyCtrl.abort()
  if (!winner.success) {
    // Each failure is tagged with its channel so callers read errors by
    // label ('direct' | 'proxy') rather than by array position.
    const labels = ['direct', 'proxy']
    winner.failures = winner.failures.map((f, i) => ({
      label: labels[i],
      error: f && f.error ? String(f.error) : 'unknown error',
    }))
  }
  return winner
}

async function fetchPage(url, externalSignal, cfg) {
  const proxy = await detectProxy()
  if (proxy) {
    const winner = await raceFetch(url, externalSignal, cfg, proxy)
    if (winner.success) return winner.value
    const dErr = winner.failures.find((f) => f.label === 'direct')
    const pErr = winner.failures.find((f) => f.label === 'proxy')
    const px = pErr ? `，代理返回 ${pErr.error}` : '，代理未连通'
    return { error: `Fetch failed: ${dErr ? dErr.error : 'unknown error'}（直连失败；已尝试代理 ${proxy}${px}）` }
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
  try {
    // ctx.get for a non-injected service throws on strict cordis hosts (seen
    // with 'settings') — treat that as "seam absent" and fall through.
    const web = ctx && typeof ctx.get === 'function' ? ctx.get('web') : undefined
    if (!web || typeof web.fetch !== 'function') return null
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

// A '<' with no '>' after it can never start a real tag, but tag-scanning
// regexes still probe the rest of the string at every such position, degrading
// to quadratic time on pathological input. Neutralize stray '<' in the no-'>'
// tail: text content is preserved, impossible tag openings disappear, and
// scanning stays linear. Short tails ("a < b" in prose) are left untouched.
function defuseLt(html) {
  const from = html.lastIndexOf('>') + 1
  if (html.length - from < 512 || !html.includes('<', from)) return html
  return html.slice(0, from) + html.slice(from).replace(/</g, ' ')
}

function textOnly(html) {
  return decodeTextEntities(defuseLt(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s>][\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s>][\s\S]*?<\/style>/gi, ' ')
    .replace(/<textarea[\s>][\s\S]*?<\/textarea\s*>/gi, ' ')
    .replace(/<noscript[\s>][\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]{1,1000}>/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim())
}

// ---- JSON / RSS / Atom content dispatch ----
// A URL is not always an HTML page: data APIs answer JSON and content sources
// answer feeds. Both are model-readable when compacted, so read_url handles
// them natively instead of erroring with "Unsupported content-type".

function xmlText(s) {
  let t = String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // Feeds double-escape HTML in descriptions (&lt;a href=…&gt;查看全文&lt;/a&gt;):
  // one strip-then-decode pass leaves literal tags in the rendered text.
  // Iterate strip → decode until stable.
  for (let i = 0; i < 3; i++) {
    const prev = t
    t = decodeTextEntities(t.replace(/<[^>]{1,1000}>/g, ' '))
    if (t === prev) break
  }
  return t.replace(/\s+/g, ' ').trim()
}

// RSS 2.0 <item> / Atom <entry> → compact list "title — url\n  summary".
function parseFeed(xml, limit) {
  xml = defuseLt(xml) // keeps the item scan linear
  const isAtom = /<feed[\s>]/i.test(xml)
  const itemRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry\s*>/gi : /<item[\s>][\s\S]*?<\/item\s*>/gi
  // Without a single closing tag nothing can pair, so the scan is skipped.
  const closable = isAtom ? /<\/entry\s*>/i.test(xml) : /<\/item\s*>/i.test(xml)
  const items = []
  let m
  while (closable && (m = itemRe.exec(xml)) && items.length < limit) {
    const it = m[0]
    const title = xmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(it)?.[1] || '')
    const linkTag = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(it)
    const linkHref = /<link[^>]+href=["']([^"']+)["']/i.exec(it)
    const link = (linkTag && xmlText(linkTag[1])) || (linkHref && linkHref[1]) || ''
    const desc = xmlText(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i.exec(it)?.[1] || '')
    if (!title && !link && !desc) continue
    items.push({ title: title.slice(0, 120), url: link, summary: desc.slice(0, 200) })
  }
  const feedTitle = xmlText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(xml)?.[1] || '')
  const lines = []
  for (const it of items) {
    lines.push(`- ${it.title}${it.url ? ` — ${it.url}` : ''}`)
    if (it.summary) lines.push(`  ${it.summary}`)
  }
  return { title: feedTitle, count: items.length, items, text: lines.join('\n') }
}

// ---- Text-density fallback (body path only) ----
// Pages without <article>/<main> degrade to the whole <body>: semantic noise
// stripping then still leaves link-dominated blocks (related posts, category
// sidebars, "hot articles" widgets) that carry little reading value. Split the
// body at block-level open tags and drop segments whose text is mostly links.
// Standard-container pages (article/main) never reach this code path.
const BLOCK_OPEN_RE = /<(?:p|div|section|article|main|h[1-6]|table|tbody|tr|ul|ol|li|blockquote|pre|dl|figure|figcaption|fieldset)\b[^>]{0,1000}>/gi

function linkTextLength(html) {
  if (!/<\/a/i.test(html)) return 0 // no anchor can pair — skip the scan
  let n = 0
  const re = /<a[\s>][\s\S]*?<\/a\s*>/gi
  let m
  while ((m = re.exec(html))) n += textOnly(m[0]).length
  return n
}

export function densityFilter(html) {
  const marks = []
  BLOCK_OPEN_RE.lastIndex = 0
  let m
  while ((m = BLOCK_OPEN_RE.exec(html))) marks.push(m.index)
  if (marks.length < 2) return html
  const segs = []
  if (marks[0] > 0) segs.push(html.slice(0, marks[0]))
  for (let k = 0; k < marks.length; k++) {
    segs.push(html.slice(marks[k], k + 1 < marks.length ? marks[k + 1] : html.length))
  }
  const kept = segs.filter((seg) => {
    const text = textOnly(seg)
    if (text.length < 2) return false
    // short link-dominated segment = nav item / recommendation widget entry
    if (text.length < 300 && linkTextLength(seg) > text.length * 0.65) return false
    return true
  })
  return kept.length ? kept.join('') : html
}

// Depth-counted block extraction: returns html from the opening tag at
// openIdx through its BALANCED closing tag. A non-greedy regex would stop at
// the first nested </div>, truncating heavily nested container divs.
function tagBlockAt(html, openIdx, tagName) {
  const re = new RegExp(`</?${tagName}(?=[\\s>])`, 'gi')
  re.lastIndex = openIdx
  let depth = 0
  let m
  while ((m = re.exec(html))) {
    depth += m[0][1] === '/' ? -1 : 1
    if (depth === 0) {
      const close = html.indexOf('>', m.index)
      return close > 0 ? html.slice(openIdx, close + 1) : null
    }
  }
  return null
}

export function pickMain(html) {
  // Aggregation pages (e.g. blog homepages) have one <article> per item:
  // collect all of them instead of only the first. A tiny <article> (e.g. a
  // newsletter card while the real content sits in <main>) falls through to
  // <main> when present.
  const articles = /<\/article/i.test(html)
    ? [...html.matchAll(/<article[\s>][\s\S]*?<\/article\s*>/gi)]
    : [] // without a closer in the document nothing can pair
  const hasMain = /<main[\s>]/i.test(html)
  if (articles.length && (!hasMain || textOnly(articles.map((a) => a[0]).join('')).length >= 200)) {
    return articles.map((a) => a[0]).join('\n')
  }
  const roleMain = /<(main|div)[^>]{0,1000}role=["']main["'][\s>]/i.exec(html)
  if (roleMain) {
    const block = tagBlockAt(html, roleMain.index, roleMain[1].toLowerCase())
    if (block) return block
  }
  // Bare <main> without role="main": doc generators (VitePress/VuePress,
  // MDN, MDX sites) mark the body with a plain <main> tag. Falling back to
  // the whole <body> would drag in the top/local nav (menu, outline, skip
  // link) — the extraction quality loss we saw on vuejs.org.
  const bareMain = /<main[\s>]/i.exec(html)
  if (bareMain) {
    const block = tagBlockAt(html, bareMain.index, 'main')
    if (block) return block
  }
  const body = /<body[\s>]/i.exec(html)
  if (body) {
    const after = html.slice(body.index)
    const end = after.search(/<\/body>/i)
    return densityFilter(end > 0 ? after.slice(0, end) : after)
  }
  return densityFilter(html)
}

// Some sites (e.g. baidu.com) ship CSS/HTML inside hidden <textarea> with
// entity-escaped tags (&lt;style&gt;...). Reveal TAG-SHAPED sequences so noise
// rules can strip them. &lt; is revealed only when a tag name follows: a bare
// &lt; from prose ("a &lt; b") would be swallowed by the tag stripper up to
// the next real '>'. Bare &gt; / &quot; never open a strip span and are
// revealed unconditionally.
function revealEscapedTags(html) {
  return html
    .replace(/&lt;(?=\/?[a-zA-Z!])/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
}

function stripNoise(mainHtml) {
  // Attribute runs are bounded so a '<' whose '>' is far away costs a bounded
  // scan instead of a run to that '>'; real attributes never approach 1000
  // chars. Container groups only include tags whose closing tag exists in the
  // input — absent closers cannot pair, so scanning for their body is wasted
  // work.
  const closers = new Set()
  for (const c of mainHtml.matchAll(/<\/([a-z0-9]+)/gi)) closers.add(c[1].toLowerCase())
  const group = (names) => names.filter((n) => closers.has(n))
  const raw = group(['textarea', 'style', 'script', 'noscript', 'template'])
  const box = group(['nav', 'footer', 'header', 'aside', 'form', 'iframe', 'svg', 'canvas', 'dialog'])
  let out = mainHtml.replace(/<!--[\s\S]*?-->/g, ' ')
  if (raw.length) {
    out = out.replace(new RegExp(`<(${raw.join('|')})[\\s>][\\s\\S]*?<\\/\\1\\s*>`, 'gi'), ' ')
  }
  if (box.length) {
    out = out.replace(new RegExp(`<(${box.join('|')})[\\s>][\\s\\S]*?<\\/\\1>`, 'gi'), ' ')
  }
  return out.replace(
    /<([a-z][a-z0-9]*)[^>]{1,1000}class=["'][^"']{0,300}(ad-|ads|advert|banner|sidebar|social|share|comment|popup|modal|cookie)[^"']{0,300}["'][^>]{0,1000}>[\s\S]*?<\/\1>/gi,
    ' ',
  )
}

// ---- HTML -> Markdown (lightweight, tag-state machine) ----
function escInline(s) {
  return s.replace(/([\\`*_[\]])/g, '\\$1')
}

// <img> is a void element (never matches the paired-tag regex in either md
// walker): convert descriptive images to markdown BEFORE the tag walk, via a
// sentinel so escInline cannot escape the generated brackets. Decorative
// images (empty alt) are dropped — the model cannot see pixels anyway.
const IMG_SENTINEL = '\u0001'
function imgsToMarkdown(html) {
  const store = []
  const out = html.replace(/<img\b[^>]{0,1000}>/gi, (tag) => {
    const alt = /alt=["']([^"']*)["']/i.exec(tag)
    const src = /src=["']([^"']+)["']/i.exec(tag)
    store.push(src && alt && alt[1].trim() ? `![${alt[1].trim()}](${src[1]})` : '')
    return `${IMG_SENTINEL}${store.length - 1}${IMG_SENTINEL}`
  })
  return {
    html: out,
    // Unknown sentinel indexes are PRESERVED (a nested walker's restore must
    // not eat sentinels owned by an outer frame — blockMd recurses into itself).
    restore: (s) => s.replace(new RegExp(`${IMG_SENTINEL}(\\d+)${IMG_SENTINEL}`, 'g'), (m, i) => {
      const v = store[Number(i)]
      return v === undefined ? m : v
    }),
  }
}

// An open tag whose closing tag appears nowhere in the input can never pair;
// removing such openers up front keeps the walker from rescanning the rest of
// the string at every position, so the walk stays linear. The walkers drop
// these tags either way, so the rendered output is unchanged. The depth cap
// bounds recursion — real pages never nest hundreds of levels; beyond the cap
// the walker degrades to plain text.
const OPEN_TAG_RE = /<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^'">]){0,1000})>/g
const MD_MAX_DEPTH = 100
function stripUnmatchedOpeners(html) {
  const closers = new Set()
  for (const m of html.matchAll(/<\/([a-zA-Z0-9]+)/g)) closers.add(m[1].toLowerCase())
  html = defuseLt(html)
  return html.replace(OPEN_TAG_RE, (m, name) => (closers.has(name.toLowerCase()) ? m : ''))
}

export function inlineMd(html, depth = 0) {
  if (depth > MD_MAX_DEPTH) {
    return escInline(decodeTextEntities(html.replace(/<[^>]{1,1000}>/g, ' ')).replace(/\s+/g, ' ').trim())
  }
  const img = imgsToMarkdown(html)
  html = stripUnmatchedOpeners(img.html)
  let out = ''
  const re = /<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^'">]){0,1000})>([\s\S]*?)<\/\1>|<[^>]{1,1000}>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) {
      out += escInline(decodeTextEntities(m[4]))
      continue
    }
    if (!m[1]) continue
    const tag = m[1].toLowerCase()
    if (tag === 'style' || tag === 'script' || tag === 'textarea' || tag === 'template' || tag === 'noscript') continue
    const inner = inlineMd(m[3], depth + 1)
    if (tag === 'a') {
      const href = /href=["']([^"']+)["']/i.exec(m[2])
      out += href ? `[${inner}](${href[1]})` : inner
    } else if (tag === 'strong' || tag === 'b') out += `**${inner}**`
    else if (tag === 'em' || tag === 'i') out += `*${inner}*`
    else if (tag === 'code') out += `\`${inner}\``
    else if (tag === 'br') out += '  \n'
    else out += inner
  }
  return img.restore(out.replace(/[ \t]+/g, ' ').trim())
}

export function blockMd(html, depth = 0) {
  if (depth > MD_MAX_DEPTH) {
    return decodeTextEntities(html.replace(/<[^>]{1,1000}>/g, ' ')).replace(/\s+/g, ' ').trim()
  }
  const img = imgsToMarkdown(html)
  html = stripUnmatchedOpeners(img.html)
  let out = ''
  const re = /<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^'">]){0,1000})>([\s\S]*?)<\/\1>|<[^>]{1,1000}>|([^<]+)/g
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
      out += `\n\n${level} ${inlineMd(inner, depth + 1)}`
    } else if (tag === 'p') {
      const t = inlineMd(inner, depth + 1)
      if (t) out += `\n\n${t}`
    } else if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main') {
      const t = blockMd(inner, depth + 1)
      if (t) out += `\n\n${t}`
    } else if (tag === 'blockquote') {
      const t = blockMd(inner, depth + 1).trim()
      out += `\n\n> ${t.replace(/\n/g, '\n> ')}`
    } else if (tag === 'pre') {
      const code = inner.replace(/<[^>]{1,1000}>/g, '').trim()
      // Language hint from common highlighter conventions: the model reads
      // ```js fenced blocks far more accurately than unlabelled ones.
      const lang =
        /<code[^>]+class=["'][^"']*(?:language|lang)-([\w#+.-]+)["']/i.exec(inner)?.[1] || ''
      out += `\n\n\`\`\`${lang}\n${code}\n\`\`\``
    } else if (tag === 'code') {
      out += `\`${textOnly(inner)}\``
    } else if (tag === 'ul' || tag === 'ol') {
      // Without a single </li> nothing can pair, so the item scan is skipped.
      const items = []
      if (inner.includes('</li')) {
        const liRe = /<li[^>]{0,1000}>([\s\S]*?)<\/li>/gi
        let lm, idx = 1
        while ((lm = liRe.exec(inner))) {
          const t = inlineMd(lm[1], depth + 1)
          items.push(tag === 'ol' ? `${idx}. ${t}` : `- ${t}`)
          idx++
        }
      }
      if (items.length) out += `\n\n${items.join('\n')}`
    } else if (tag === 'li') {
      out += `\n- ${inlineMd(inner, depth + 1)}`
    } else if (tag === 'br') {
      out += '  \n'
    } else if (tag === 'hr') {
      out += '\n\n---'
    } else if (tag === 'table') {
      const rows = []
      if (inner.includes('</tr')) {
        const trRe = /<tr[^>]{0,1000}>([\s\S]*?)<\/tr>/gi
        let tm
        while ((tm = trRe.exec(inner))) {
          const cells = []
          if (tm[1].includes('</t')) {
            const tdRe = /<t[dh][^>]{0,1000}>([\s\S]*?)<\/t[dh]>/gi
            let cm
            while ((cm = tdRe.exec(tm[1]))) cells.push(inlineMd(cm[1], depth + 1).replace(/\|/g, '\\|'))
          }
          if (cells.length) rows.push(`| ${cells.join(' | ')} |`)
        }
      }
      if (rows.length) {
        const header = rows[0]
        // unescape cells' escaped pipes before deriving the separator row,
        // otherwise the --- line is one char wider per escaped pipe
        const sep = header.replace(/\\\|/g, '|').replace(/[^|]/g, '-')
        out += `\n\n${rows.join('\n')}\n${sep}`
      }
    } else if (tag === 'a' || tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i') {
      const t = inlineMd(inner, depth + 1)
      if (t) out += t
    } else {
      const t = blockMd(inner, depth + 1)
      if (t) out += t
    }
  }
  return img.restore(out)
}

// Page-level metadata the model actually asks about (who wrote it, when) —
// cheap to harvest from <meta>.
function extractMeta(html) {
  const get = (names) => {
    for (const n of names) {
      const m = new RegExp(`<meta[^>]{1,1000}(?:property|name)=["']${n}["'][^>]{1,1000}content=["']([^"']+)["']`, 'i').exec(html)
      if (m) return decodeTextEntities(m[1]).replace(/<[^>]{1,1000}>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
    }
    return ''
  }
  return {
    published: get(['article:published_time', 'og:published_time', 'pubdate', 'publishdate', 'date', 'dc.date']),
    author: get(['author', 'article:author', 'og:article:author']),
    description: get(['og:description', 'description']),
  }
}

// Meta-less pages still print the byline inside the body head: "作者：阮一峰
// 日期：2026年8月21日". Fill ONLY the missing fields, and only from the first
// 600 chars of body text — deeper matches are content, not bylines.
const BYLINE_AUTHOR_RE = /(?:作者|責任編輯|責任主编|editor)[：:\s]{1,3}([^\s，,。/|()（）[\]]{2,24})/
const BYLINE_DATE_RE = /(?:发表日期|发布日期|发表时间|发布时间|日期|发表于|发布于|published(?:\s+on)?)[：:\s]{0,3}(\d{4}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}日?|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)/i

function bylineFallback(text, meta) {
  const head = typeof text === 'string' ? text.slice(0, 600) : ''
  const out = { published: meta.published, author: meta.author }
  if (!out.author) {
    const m = BYLINE_AUTHOR_RE.exec(head)
    if (m) out.author = m[1].trim().slice(0, 40)
  }
  if (!out.published) {
    const m = BYLINE_DATE_RE.exec(head)
    if (m) out.published = m[1].replace(/\s+/g, ' ').trim().slice(0, 40)
  }
  return out
}

export function extract(html, mode) {
  html = defuseLt(html) // kills the no-'>'-tail quadratic scans before any picker runs
  const titleMatch = /<title[^>]{0,1000}>([\s\S]*?)<\/title>/i.exec(html) || /<meta[^>]{1,1000}property=["']og:title["'][^>]{1,1000}content=["']([^"']+)["']/i.exec(html)
  const siteName = /<meta[^>]{1,1000}property=["']og:site_name["'][^>]{1,1000}content=["']([^"']+)["']/i.exec(html)
  const langMatch = /<html[^>]{1,1000}lang=["']([\w-]+)["']/i.exec(html)
  let main = stripNoise(pickMain(html))
  main = stripNoise(revealEscapedTags(main))
  let bodyText
  if (mode === 'markdown') {
    bodyText = blockMd(main).replace(/\n{3,}/g, '\n\n').trim()
  } else {
    bodyText = textOnly(main).replace(/ +/g, ' ').trim()
  }
  const meta = extractMeta(html)
  // Empty-body pages (login walls, JS-only shells) still carry og:description
  // — surface it as a fallback hint instead of nothing.
  let text = bodyText
  let usedDescription = false
  if (!text && meta.description) {
    text = meta.description
    usedDescription = true
  }
  const byline = bylineFallback(text, meta)
  return {
    title: titleMatch ? textOnly(titleMatch[1]) || titleMatch[1].trim() : '',
    siteName: siteName ? siteName[1] : '',
    lang: langMatch ? langMatch[1] : '',
    published: byline.published,
    author: byline.author,
    text,
    usedDescription,
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
  if (!acc && maxChars > 0) {
    // The first paragraph after the offset is itself longer than maxChars.
    // Keep the alignment promise at sentence level before hard-slicing.
    const p = paragraphs[start] || ''
    const rel = Math.max(0, offset - pos)
    const rest = p.length > rel ? p.slice(rel) : text.slice(offset)
    const sentences = rest.match(/[^.!?\n。！？]+[.!?\n。！？]*/g) || [rest]
    for (const s of sentences) {
      if (acc.length + s.length > maxChars) break
      acc += s
    }
    if (!acc) acc = rest.slice(0, maxChars)
  }
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
  // Iteration cap: a page whose nav repeats the same links thousands of times
  // would otherwise scan the whole HTML to fill `limit` unique entries. Scan
  // at most limit*4 anchors; dedupe keeps the result bounded regardless.
  let scans = 0
  const maxScans = limit * 4
  while ((m = re.exec(html)) && links.length < limit && scans++ < maxScans) {
    const href = m[1].trim()
    if (!href || /^(javascript|mailto|tel|data):/i.test(href)) continue
    let url
    try {
      url = baseUrl ? new URL(href, baseUrl).href : new URL(href).href
    } catch {
      continue
    }
    // Only http(s) links are followable by the model / crawler; other schemes
    // (ftp:, data:) survive URL resolution and would pollute link lists and
    // crawl queues.
    if (!/^https?:/i.test(url)) continue
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

// ---- Pagination: auto-follow "next page" ----
// Long articles on novel/news/forum sites are split into pages; without this
// the model had to notice the truncation and re-call the tool per page. The
// recognition is deliberately conservative: rel=next (standard) or a short
// anchor whose whole text is a next-page marker — no fuzzy guessing.
const NEXT_TEXT_RE = /^(?:[›»>]+\s*)?(?:下一页|下页|下一篇|下一頁|下頁|后一页|後一頁|next page|next|older entries|[›»>]{1,3})(?:\s*[›»>]+)?$/i

export function findNextLink(html, baseUrl) {
  const resolve = (href) => {
    try {
      const u = new URL(href, baseUrl)
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
    } catch {
      return null
    }
  }
  const rel = /<(?:link|a)\b[^>]+rel=["']next["'][^>]*>/i.exec(html || '')
  if (rel) {
    const href = /href=["']([^"']+)["']/i.exec(rel[0])
    const r = href && resolve(href[1])
    if (r) return r
  }
  const re = /<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi
  let m
  let scans = 0
  // Bounded like extractLinks: a nav bar with thousands of anchors must not
  // scan the whole DOM hunting for a next-marker.
  while ((m = re.exec(html || '')) && scans++ < 400) {
    const t = textOnly(m[2])
    if (t.length <= 16 && NEXT_TEXT_RE.test(t)) {
      const r = resolve(m[1])
      if (r) return r
    }
  }
  return null
}

// Join two page bodies, dropping a repeated suffix/prefix overlap (many
// paginated sites repeat the last paragraph or a heading on the next page).
function joinPageText(a, b) {
  const max = Math.min(300, a.length, b.length)
  for (let n = max; n >= 30; n--) {
    if (a.slice(a.length - n) === b.slice(0, n)) {
      const rest = b.slice(n).trim()
      return rest ? `${a}\n\n${rest}` : a
    }
  }
  return `${a}\n\n${b}`
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
  if (full.paginated > 1) out.paginated = full.paginated
  if (full.feedCount) out.feedCount = full.feedCount
  if (full.published) out.published = full.published
  if (full.author) out.author = full.author
  if (Array.isArray(full.links)) out.links = full.links
  return out
}

// ---- JSON payloads: compact render ----
// Indented JSON spends a newline + indent per key — pure token overhead for
// the model. Render compact, and clip monster string values (embedded HTML,
// base64 blobs) with a visible marker so the model knows there is more.
const JSON_STR_MAX = 1500
export function compactJson(value) {
  const clip = (s) =>
    s.length > JSON_STR_MAX ? s.slice(0, JSON_STR_MAX) + `…[+${s.length - JSON_STR_MAX} chars]` : s
  const walk = (v, depth) => {
    if (typeof v === 'string') return clip(v)
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1))
    if (v && typeof v === 'object' && depth < 12) {
      const o = {}
      for (const k of Object.keys(v)) o[k] = walk(v[k], depth + 1)
      return o
    }
    return v
  }
  try {
    return JSON.stringify(walk(value, 0))
  } catch {
    // Extreme nesting/size where even native stringify exhausts the stack —
    // degrade to a clipped raw render instead of crashing the tool call.
    try {
      return clip(String(value))
    } catch {
      return '[unserializable json]'
    }
  }
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
  // Failed fetches are cached briefly so the model doesn't re-request a
  // broken URL in a loop (token + latency saver).
  const fh = failCache.get(cacheKey)
  if (fh) {
    if (Date.now() - fh.time < 30000) return { error: fh.error, cached: true }
    failCache.delete(cacheKey)
  }
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.time < cfg.cacheTtlMs) {
    const sliced = sliceFrom(hit.full, offset, maxChars)
    return { ...sliced, cached: true }
  }

  const failWith = (error) => {
    cacheFail(cacheKey, error)
    return { error }
  }

  // Non-HTML payloads (JSON APIs, RSS/Atom feeds) are read natively: fetch,
  // dispatch by content-type / payload shape, render compact. Falls back to
  // the HTML pipeline for everything else.
  const dispatch = async () => {
    const viaSeam = await fetchViaWebSeam(ctx, url, externalSignal, cfg)
    if (viaSeam) {
      const t = viaSeam.html.trim()
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          return { kind: 'json', text: compactJson(JSON.parse(t)) }
        } catch { /* not JSON — keep HTML pipeline */ }
      }
      return { kind: 'html', html: viaSeam.html, finalUrl: viaSeam.finalUrl, charset: 'provider-decoded' }
    }
    const page = await fetchPage(url, externalSignal, cfg)
    if (page.error) return { error: page.error }
    const ct = (page.contentType || '').split(';')[0].toLowerCase().trim()
    const decoded = decodeBuffer(page.buffer, page.contentType)
    if (/json$/.test(ct)) {
      try {
        return { kind: 'json', text: compactJson(JSON.parse(decoded.text)) }
      } catch { /* invalid JSON — serve through the HTML pipeline as text */ }
    }
    if (/[+/]xml$/.test(ct)) {
      if (/<urlset[\s>]/i.test(decoded.text) || /<sitemapindex[\s>]/i.test(decoded.text)) {
        return { error: 'Unsupported content (XML sitemap)' }
      }
      if (/<rss[\s>]/i.test(decoded.text) || /<feed[\s>]/i.test(decoded.text)) {
        return { kind: 'feed', feed: parseFeed(decoded.text, cfg.maxLinks) }
      }
    }
    return { kind: 'html', html: decoded.text, finalUrl: page.finalUrl || url, charset: decoded.charset }
  }
  const payload = await dispatch()
  if (payload.error) return failWith(payload.error)

  if (payload.kind === 'json') {
    const full = { url, title: '', siteName: hostOf(url), lang: '', charset: 'json', mode: 'json', fullText: payload.text, paginated: 1 }
    cacheStore(cacheKey, full, cfg.cacheMax)
    return sliceFrom(full, offset, maxChars)
  }
  if (payload.kind === 'feed') {
    const f = payload.feed
    const full = {
      url, title: f.title || '', siteName: hostOf(url), lang: '', charset: 'feed',
      mode: 'feed', fullText: f.text, paginated: 1, feedCount: f.count,
      links: args.includeLinks === true ? f.items : undefined,
    }
    cacheStore(cacheKey, full, cfg.cacheMax)
    return sliceFrom(full, offset, maxChars)
  }

  let html = payload.html
  let finalUrl = payload.finalUrl || url
  const charset = payload.charset

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
  // Beyond script-heavy shells (looksLikeSpa, ≥5 <script> tags), a page whose
  // extraction is EMPTY but carries any <script> may be a JS-redirect shell
  // (2 scripts, empty <body>, redirect issued from JS) — with no text to
  // lose, rendering is always worth one bounded attempt. Pages with no
  // scripts at all cannot change under rendering and are skipped.
  let rendered = false
  let spaHint = ''
  let renderedHtml = null
  const needsRender = !extracted.text || extracted.text.length < 200
  const scriptShell = !extracted.text && /<script[\s>]/i.test(html)
  if (cfg.spaRender !== false && needsRender && (looksLikeSpa(html) || scriptShell)) {
    const rr = await renderPage(finalUrl || url, externalSignal)
    if (rr.html) {
      renderedHtml = rr.html
      // A challenge interstitial (Cloudflare "Just a moment...") must never
      // be accepted as an improvement — it can carry MORE text than the real
      // static body and would evict the latter.
      if (looksLikeChallenge(rr.html)) {
        renderedHtml = null // pagination/links must not read the interstitial DOM
        spaHint = extracted.text
          ? '已渲染但被人机验证页拦截，保留静态提取结果'
          : '已渲染但被人机验证页拦截（无静态内容可用）'
      } else {
        const r2 = upgrade(extract(rr.html, mode), rr.html)
        // Accept the rendered text when it meaningfully beats the static one.
        // From an EMPTY static extraction even a short body is a real gain
        // (JS shells can render just 30-60 chars of real content, below the
        // fixed +50 margin).
        const gain = r2.text.length - extracted.text.length
        const accept = r2.text && (gain > 50 || (!extracted.text && r2.text.length >= 20))
        if (accept) {
          extracted = r2
          finalUrl = rr.finalUrl || finalUrl
          rendered = true
        } else if (!extracted.text) {
          spaHint = '已渲染仍无可读内容（可能登录墙或反爬拦截）'
        }
      }
    } else {
      spaHint = rr.error
    }
  }

  // Auto-pagination: follow the "next page" chain (bounded, same-host, no
  // loops). Continuation pages go through the fast static path — a paginated
  // SPA chain would cost one full render per page, out of proportion.
  let paginated = 1
  const paginateMax = cfg.paginate === false ? 1 : Math.max(1, Math.min(10, Number(cfg.paginateMax) || 3))
  const startHost = hostOf(finalUrl || url)
  const seen = new Set([normalizeUrl(finalUrl || url)])
  let nextUrl = paginateMax > 1 ? findNextLink(renderedHtml || html, finalUrl || url) : null
  while (
    nextUrl && paginated < paginateMax &&
    sameHost(nextUrl, startHost) &&
    !(externalSignal && externalSignal.aborted)
  ) {
    const nu = normalizeUrl(nextUrl)
    if (!nu || seen.has(nu)) break
    seen.add(nu)
    const page = await fetchPage(nextUrl, externalSignal, cfg)
    if (page.error) break
    const ct = (page.contentType || '').split(';')[0].toLowerCase().trim()
    if (!/html|xhtml/.test(ct)) break
    const nextHtml = decodeBuffer(page.buffer, page.contentType).text
    const nextEx = extract(nextHtml, mode)
    if (!nextEx.text || nextEx.text.length < 20) break
    extracted.text = joinPageText(extracted.text, nextEx.text)
    paginated++
    nextUrl = findNextLink(nextHtml, page.finalUrl || nextUrl)
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
    paginated,
    published: extracted.published || '',
    author: extracted.author || '',
    // Links come from the rendered DOM when available — otherwise the SPA
    // chain (content -> links -> next page) would break for JS-only pages.
    links: args.includeLinks === true ? extractLinks(renderedHtml || html, cfg.maxLinks, finalUrl) : undefined,
  }

  cacheStore(cacheKey, full, cfg.cacheMax)
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
  if (r.charset && r.charset !== 'utf-8' && r.charset !== 'json' && r.charset !== 'feed') {
    meta.push(`charset ${r.charset}`)
  }
  if (r.published) meta.push(r.published)
  if (r.author) meta.push(`by ${r.author}`)
  if (r.feedCount) meta.push(`feed · ${r.feedCount} 条`)
  if (r.mode === 'json') meta.push('json')
  if (meta.length) lines.push(meta.join(' · '))
  // One compact status line instead of several parenthetical lines — the
  // flags are hints, not content, so they share a single line of tokens.
  const flags = []
  if (r.charsStart > 0) flags.push(`chars ${r.charsStart}+${r.charsReturned}/${r.charsTotal}`, 'offset 续读')
  else if (r.truncated) flags.push(`chars ${r.charsReturned}/${r.charsTotal}`, '截断', 'offset 续读')
  else if (typeof r.charsTotal === 'number') flags.push(`chars ${r.charsTotal}`)
  if (r.cached) flags.push('cached')
  if (r.paginated > 1) flags.push(`已拼接${r.paginated}页`)
  if (r.rendered) flags.push('rendered')
  if (flags.length) lines.push(`(${flags.join(' · ')})`)
  if (!r.text) {
    if (r.charsStart > 0 && !r.truncated) {
      lines.push('(offset 已到文末，无更多内容)')
    } else {
      lines.push(r.spaHint
        ? `(无可读内容 — ${r.spaHint})`
        : '(无可读内容 — 登录墙 / SPA 页 / 空页面；SPA 需安装 playwright)')
    }
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
        limit: { type: 'number', description: 'Links to return (1-50; default from plugin config)' },
      },
      required: ['url'],
    },
    // Covers SPA-render fallback: full fetch timeout + playwright render cap.
    timeoutMs: Math.max(45000, cfg.timeoutMs + 45000),
    isConcurrencySafe: () => true,
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
      // render it and re-extract when the static result looks empty. Any
      // <script> counts as renderable when there are no links at all — the
      // static shell may be a JS-redirect (same rationale as read_url).
      if (links.length < 3 && cfg.spaRender !== false && (looksLikeSpa(html) || (links.length === 0 && /<script[\s>]/i.test(html)))) {
        const rr = await renderPage(finalUrl || url, exec && exec.signal)
        // A challenge interstitial's links are the challenge's own scripts —
        // never an improvement over whatever the static HTML offered.
        if (rr.html && !looksLikeChallenge(rr.html)) {
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
      'Read multiple URLs in parallel: each a compact clean block (same extraction + cache as read_url). ' +
      'Failures isolated and tagged. Max 10 URLs, capped at maxChars per page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'URLs to read in parallel (1-10, http/s)' },
        maxChars: { type: 'number', description: 'Chars per page (500-20000; default 3000)' },
        mode: { type: 'string', enum: ['text', 'markdown'], description: 'text = plain (token-cheap, default); markdown = structured' },
        includeLinks: { type: 'boolean', description: 'Return page links too (title+url, bounded)' },
      },
      required: ['urls'],
    },
    // Worst case: ceil(10/4)=3 concurrency waves, each (fetch + SPA render).
    timeoutMs: Math.max(60000, cfg.timeoutMs * 3 + 135000),
    // Concurrent batch calls multiply fetch pressure but stay isolated (each
    // call owns its result array; the session cache is commutative).
    isConcurrencySafe: () => true,
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
  // Stop once the host's cooperative signal fires (tool budget hit): without
  // this the loop keeps draining the queue on instantly-aborted fetches.
  while (queue.length && pages.length < maxPages && !(externalSignal && externalSignal.aborted)) {
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
        // Queue cap: a huge site (millions of links) would otherwise grow the
        // queue unboundedly while maxPages bounds only what we *process*.
        if (queue.length >= maxPages * 20) continue
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
      '(title + depth + size). Auth/static paths skipped; failures isolated. ' +
      'includeContent=true attaches a short summary per page (default off, token-cheap). ' +
      'Does not render SPA pages (use read_url for that).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Entry URL of the site to crawl (http/s)' },
        maxPages: { type: 'number', description: 'Pages to crawl (2-50; default 15)' },
        maxDepth: { type: 'number', description: 'Link depth from entry (1-5; default 2)' },
        includeContent: { type: 'boolean', description: 'Short body summary per page (default off; structure-only is token-cheap)' },
        maxCharsPerPage: { type: 'number', description: 'Summary chars per page (200-2000; default 500)' },
      },
      required: ['url'],
    },
    // Worst case: ceil(maxPages/2)=25 waves of paired fetches (no SPA render
    // here); the cooperative signal stops the loop early once the budget is hit.
    timeoutMs: Math.max(120000, cfg.timeoutMs * 25),
    // Crawl state (visited set, queue) is call-local; only the shared session
    // cache is global and commutative — parallel crawls of different hosts
    // are safe and useful (one task mapping several sites).
    isConcurrencySafe: () => true,
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
  // YAML is free-form: numbers can arrive quoted as strings, which would poison
  // arithmetic and AbortSignal timeouts downstream — coerce to numbers once
  // here, clamp to sane ranges, and fall back to defaults on garbage.
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const clamp = (v, d, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  cfg.timeoutMs = clamp(cfg.timeoutMs, DEFAULTS.timeoutMs, 500, 120000)
  cfg.maxBytes = clamp(cfg.maxBytes, DEFAULTS.maxBytes, 65536, 16 * 1024 * 1024)
  cfg.maxChars = clamp(cfg.maxChars, DEFAULTS.maxChars, 500, 20000)
  cfg.maxLinks = clamp(cfg.maxLinks, DEFAULTS.maxLinks, 1, 50)
  cfg.cacheTtlMs = clamp(cfg.cacheTtlMs, DEFAULTS.cacheTtlMs, 0, 3600000)
  cfg.cacheMax = clamp(cfg.cacheMax, DEFAULTS.cacheMax, 1, 256)
  cfg.paginateMax = clamp(cfg.paginateMax, DEFAULTS.paginateMax, 1, 10)
  if (typeof cfg.userAgent !== 'string' || !cfg.userAgent.trim()) cfg.userAgent = DEFAULTS.userAgent
  if (typeof cfg.spaRender !== 'boolean') cfg.spaRender = DEFAULTS.spaRender
  if (typeof cfg.paginate !== 'boolean') cfg.paginate = DEFAULTS.paginate

  // Temporal composability: unload must fully revert side effects.
  ctx.effect(() => () => {
    cache.clear()
    failCache.clear()
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
        maxChars: { type: 'number', description: 'Body text chars to return (500-20000; default from plugin config)' },
        offset: { type: 'number', description: 'Start at this char offset (continue long pages). Default 0; served from cache.' },
        mode: { type: 'string', enum: ['text', 'markdown'], description: 'text = plain (token-cheap, default); markdown = structured' },
        includeLinks: { type: 'boolean', description: 'Return page links too (title+url, bounded)' },
      },
      required: ['url'],
    },
    // Pipeline budget must cover the real worst case: first page fetch +
    // SPA render (goto 30s cap + DOM-stability poll 10s) + up to paginateMax
    // continuation fetches (static, no render). Derived from load-time cfg —
    // scale with it, never clamp it.
    timeoutMs: Math.max(45000, cfg.timeoutMs * (cfg.paginate === false ? 1 : cfg.paginateMax + 1) + 45000),
    // All shared state is commutative-safe under concurrent calls (session
    // cache Map get/set, decoder cache, one shared browser with isolated
    // pages per render), so the agent may fan out several read_url calls in
    // one parallel group — a real win for multi-source reading tasks.
    isConcurrencySafe: () => true,
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
