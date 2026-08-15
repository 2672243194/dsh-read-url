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

export const name = 'dsh-read-url'
export const inject = ['tools']

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15000
const MAX_BYTES = 3 * 1024 * 1024
const DEFAULT_MAX_CHARS = 6000
const MAX_LINKS = 20
const CACHE_TTL_MS = 300000
const CACHE_MAX = 32

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

async function fetchPage(url, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
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
      if (size > MAX_BYTES) return { error: `Page exceeds ${MAX_BYTES} bytes` }
      chunks.push(chunk)
    }
    return { buffer: Buffer.concat(chunks), contentType, finalUrl: res.url }
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return { error: `Timeout after ${FETCH_TIMEOUT_MS}ms or cancelled` }
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

function textOnly(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<textarea[\s\S]*?<\/textarea\s*>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim()
}

export function pickMain(html) {
  let main = null
  const article = /<article[\s>]/i.exec(html)
  const mainTag = /<(main|div)[^>]*role=["']main["'][\s>]/i.exec(html)
  const start = article || mainTag
  if (start) {
    const from = start.index
    const tag = /^<([a-zA-Z0-9]+)/.exec(html.slice(from))[1].toLowerCase()
    const close = new RegExp(`</${tag}>`, 'i')
    const match = html.slice(from).match(close)
    if (match) main = html.slice(from, from + match.index + close.source.length)
  }
  if (main) return main
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
      out += escInline(m[4])
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
      out += m[4]
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

export function smartTruncate(text, maxChars) {
  const total = text.length
  if (total <= maxChars) return { text, truncated: false, charsTotal: total, charsReturned: total }
  const paragraphs = text.split(/\n\n+/)
  let acc = ''
  for (const p of paragraphs) {
    if (acc.length + p.length + 2 > maxChars) break
    acc += (acc ? '\n\n' : '') + p
  }
  if (!acc) acc = text.slice(0, maxChars)
  return { text: acc, truncated: true, charsTotal: total, charsReturned: acc.length }
}

function extractLinks(html, limit) {
  const links = []
  const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) && links.length < limit) {
    const t = textOnly(m[2])
    if (t) links.push({ title: t.slice(0, 80), url: m[1] })
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

export async function readUrl(args, ctx, externalSignal) {
  const url = String(args.url || '').trim()
  if (!/^https?:\/\//i.test(url)) return { error: 'Only http/https URLs are supported' }
  const maxChars = Math.max(500, Math.min(20000, Number(args.maxChars) || DEFAULT_MAX_CHARS))
  const mode = args.mode === 'markdown' ? 'markdown' : 'text'

  const cacheKey = `${url}|${mode}|${maxChars}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) {
    return { ...hit.result, cached: true }
  }

  let html, finalUrl, charset
  const viaSeam = await fetchViaWebSeam(ctx, url, externalSignal)
  if (viaSeam) {
    html = viaSeam.html
    finalUrl = viaSeam.finalUrl
    charset = 'provider-decoded'
  } else {
    const page = await fetchPage(url, externalSignal)
    if (page.error) return { error: page.error }
    const decoded = decodeBuffer(page.buffer, page.contentType)
    html = decoded.text
    finalUrl = page.finalUrl || url
    charset = decoded.charset
  }

  const extracted = extract(html, mode)
  const truncated = smartTruncate(extracted.text, maxChars)

  const result = {
    url: finalUrl,
    title: extracted.title || '',
    siteName: extracted.siteName || hostOf(finalUrl),
    lang: extracted.lang || '',
    charset,
    mode,
    truncated: truncated.truncated,
    charsTotal: truncated.charsTotal,
    charsReturned: truncated.charsReturned,
    text: truncated.text,
  }
  if (args.includeLinks) result.links = extractLinks(html, MAX_LINKS)

  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(cacheKey, { time: Date.now(), result })
  return result
}

function renderResult(value) {
  if (typeof value === 'string') return value
  const r = value || {}
  if (r.error) return `Error: ${r.error}`
  const lines = []
  if (r.title) lines.push(`title: ${r.title}`)
  const meta = []
  if (r.siteName) meta.push(r.siteName)
  if (r.lang) meta.push(r.lang)
  if (r.charset) meta.push(`charset ${r.charset}`)
  if (meta.length) lines.push(meta.join(' · '))
  if (r.truncated) {
    lines.push(`(chars ${r.charsReturned}/${r.charsTotal} — truncated. Raise maxChars or read the rest in a follow-up call.)`)
  } else if (typeof r.charsTotal === 'number') {
    lines.push(`(chars ${r.charsTotal})`)
  }
  if (r.cached) lines.push('(cached)')
  lines.push('', r.text || '(no readable content)')
  if (Array.isArray(r.links) && r.links.length) {
    lines.push('', 'links:')
    for (const l of r.links) lines.push(`- ${l.title} — ${l.url}`)
  }
  return lines.join('\n')
}

export function apply(ctx) {
  // Temporal composability: unload must fully revert side effects.
  ctx.effect(() => () => cache.clear())

  console.log('[dsh-read-url] plugin loaded; tool read_url registered')

  ctx.tools.register({
    name: 'read_url',
    description:
      'Fetch a webpage and return its clean main content. Auto-detects encoding (GBK/GB2312/UTF-8/Big5). ' +
      'Default mode returns plain text capped at maxChars to keep token usage low; ' +
      'use mode="markdown" for structured Markdown (headings/links/tables preserved). ' +
      'Returns a compact text block (title, metadata, truncated body). ' +
      'Repeated reads within 5 minutes are served from cache. ' +
      'For reading articles, docs and news pages. Not for login-walled or JS-rendered pages.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http(s) URL to read' },
        maxChars: { type: 'number', description: `Max characters to return (default ${DEFAULT_MAX_CHARS}, range 500-20000)` },
        mode: { type: 'string', enum: ['text', 'markdown'], description: 'text = plain (token-efficient, default); markdown = structured' },
        includeLinks: { type: 'boolean', description: 'Also return up to 20 page links (title+url)' },
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
      return readUrl(args, ctx, exec && exec.signal)
    },
  })
}
