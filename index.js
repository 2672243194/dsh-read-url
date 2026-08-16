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

async function fetchPage(url, externalSignal, cfg) {
  const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs)
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal
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
    return { error: `Fetch failed: ${e.message}` }
  }
}

// Prefer the ctx.web capability seam (official docs/capability-seams.md):
// the web provider already decodes the document, so we skip our charset
// layer and only re-extract. Falls back to global fetch when absent.
async function fetchViaWebSeam(ctx, url, externalSignal) {
  const web = ctx && typeof ctx.get === 'function' ? ctx.get('web') : undefined
  if (!web || typeof web.fetch !== 'function') return null
  try {
    const res = await web.fetch(url, { signal: externalSignal })
    if (!res || typeof res.content !== 'string') return null
    const finalUrl = res.url || res.finalUrl || url
    return { html: res.content, finalUrl }
  } catch {
    return null
  }
}

// Decode common HTML entities in already-stripped text (&nbsp;/&amp;/&lt;/&gt;/
// &quot;/&#39;/numeric). Runs AFTER tag stripping so escaped tags stay visible
// to the stripper and only remaining text is decoded.
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
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
        const sep = header.replace(/[^|]/g, '-')
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
  const url = String(args.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { error: 'Only http/https URLs are supported' }
  const maxChars = Math.max(500, Math.min(20000, Number(args.maxChars) || cfg.maxChars))
  const mode = args.mode === 'markdown' ? 'markdown' : 'text'
  const offset = Math.max(0, Number(args.offset) || 0)

  // Cache stores the FULL extracted text keyed by url+mode+includeLinks, so
  // continuation reads (offset) and different maxChars hit the same entry —
  // but a links-request must not be served from a links-less cached copy.
  const cacheKey = `${url}|${mode}|${args.includeLinks === true ? 'links' : 'no-links'}`
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
  const viaSeam = await fetchViaWebSeam(ctx, url, externalSignal)
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
      'List the links (visible text + URL) found on a webpage, without returning body text. ' +
      'Lighter than read_url for mapping what a page points to or finding source links. ' +
      'Renders JS-only (SPA) pages when playwright is installed. ' +
      'Read-only, no credentials sent.',
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
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return { error: 'Only http/https URLs are supported' }
      const limit = Math.max(1, Math.min(50, Number(args.limit) || cfg.maxLinks))
      const viaSeam = await fetchViaWebSeam(ctx, url, exec && exec.signal)
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
    lines.push('', `--- ${head} (${p.chars} 字符${p.cached ? ' · cached' : ''}) ---`, p.text || '(no readable content)')
    if (Array.isArray(p.links) && p.links.length) {
      lines.push(`links: ${p.links.map((l) => l.title + ' — ' + l.url).join(' | ')}`)
    }
  }
  return lines.join('\n')
}

function readUrlBatchTool(ctx, cfg) {
  return {
    name: 'read_url_batch',
    description:
      'Read multiple URLs in parallel and return each page\'s clean main content as a compact block. ' +
      'Uses the same extraction as read_url (charset auto-detect, noise stripping, optional readability/SPA rendering) and the same session cache. ' +
      'Per-page failures are isolated: one broken URL does not affect the others, and each result is tagged with its URL. ' +
      'For research / comparison tasks that need several pages at once. ' +
      'Max 10 URLs; per-page output capped at maxChars to keep token usage low.',
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
      const urls = (Array.isArray(args.urls) ? args.urls : []).map((u) => String(u).trim()).filter(Boolean)
      if (!urls.length) return { error: 'urls array is required (1-10 http(s) URLs)' }
      const list = urls.slice(0, 10)
      const perMax = Math.max(500, Math.min(20000, Number(args.maxChars) || 3000))
      const mode = args.mode === 'markdown' ? 'markdown' : 'text'
      const signal = exec && exec.signal
      const pages = await mapLimit(list, 4, (u) =>
        readUrl({ url: u, maxChars: perMax, mode, includeLinks: args.includeLinks === true }, ctx, signal, cfg),
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

export function apply(ctx, config) {
  // Plugin-level config from cordis.patch.yml (config row), merged over defaults.
  const cfg = { ...DEFAULTS, ...(config || {}) }

  // Temporal composability: unload must fully revert side effects.
  ctx.effect(() => () => {
    cache.clear()
    closeBrowser().catch(() => {})
  })

  console.log('[dsh-read-url] plugin loaded; tools read_url, read_url_batch, read_url_links registered')

  ctx.tools.register({
    name: 'read_url',
    description:
      'Fetch a webpage and return its clean main content. Auto-detects encoding (GBK/GB2312/UTF-8/Big5). ' +
      'Default mode returns plain text capped at maxChars to keep token usage low; ' +
      'use mode="markdown" for structured Markdown (headings/links/tables preserved). ' +
      'Returns a compact text block (title, metadata, truncated body). ' +
      'Repeated reads within 5 minutes are served from cache. ' +
      'Handles JS-rendered (SPA) pages when playwright is installed in the DSH profile; ' +
      'login-walled pages are not accessible.',
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
}
