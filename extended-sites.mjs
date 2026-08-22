// Extended-category live probe: site types NOT in the 152-site sweep.
// Usage: node extended-sites.mjs [CONC]
import { readUrl, apply } from './index.js'

const CONC = Number(process.argv[2] || process.env.CONC || 6)
const CFG = {
  timeoutMs: 15000, maxBytes: 3 * 1024 * 1024, maxChars: 6000, maxLinks: 20,
  cacheTtlMs: 300000, cacheMax: 32, spaRender: true, paginate: true, paginateMax: 3,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
}

const SITES = [
  // --- JSON APIs (compact render path, long arrays / nested) ---
  ['github-api-repo', 'https://api.github.com/repos/nodejs/node'],
  ['npm-registry', 'https://registry.npmjs.org/express/latest'],
  ['hn-algolia-api', 'https://hn.algolia.com/api/v1/search?query=readability&hitsPerPage=5'],
  ['jsonplaceholder-users', 'https://jsonplaceholder.typicode.com/users'],
  // --- doc-generator sites (Docusaurus / VitePress / Sphinx / mdBook) ---
  ['react-dev', 'https://react.dev/reference/react/useEffect'],
  ['vuejs-guide', 'https://vuejs.org/guide/introduction.html'],
  ['python-docs', 'https://docs.python.org/3/library/json.html'],
  ['rust-book', 'https://doc.rust-lang.org/book/ch01-01-installation.html'],
  ['mdn-page', 'https://developer.mozilla.org/en-US/docs/Web/API/fetch'],
  ['arch-wiki', 'https://wiki.archlinux.org/title/Pacman'],
  // --- academic / papers ---
  ['arxiv-abs', 'https://arxiv.org/abs/1706.03762'],
  ['pubmed', 'https://pubmed.ncbi.nlm.nih.gov/?q=transformer'],
  // --- developer communities ---
  ['stackoverflow-q', 'https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-an-unsorted-array'],
  ['hn-classic', 'https://news.ycombinator.com/'],
  ['lobsters', 'https://lobste.rs/'],
  ['habr-ru', 'https://habr.com/ru/articles/'],
  // --- redirects / shorteners / raw content ---
  ['httpbin-redirect3', 'https://httpbin.org/redirect/3?url=/html'],
  ['github-raw', 'https://raw.githubusercontent.com/mozilla/readability/main/README.md'],
  ['gist-raw', 'https://gist.githubusercontent.com/octocat/6cad326836d38bd3a7ae/raw/'],
  // --- non-https plain http ---
  ['cern-http', 'http://info.cern.ch/hypertext/WWW/TheProject.html'],
  // --- CJK beyond the sweep: Korean / more Japanese ---
  ['naver-news-kr', 'https://news.naver.com/main/main.naver'],
  ['asahi-jp', 'https://www.asahi.com/'],
  // --- huge single page (long article) ---
  ['en-wiki-long', 'https://en.wikipedia.org/wiki/China'],
  // --- semantic-poor legacy table layout ---
  ['w3c-legacy', 'https://www.w3.org/People/Raggett/book4/ch02/tables.html'],
]

// stub ctx like multi-site.mjs: no web seam → full local pipeline
const ctx = { get: () => null }

async function runOne([name, url]) {
  const t0 = Date.now()
  try {
    const r = await readUrl({ url, maxChars: 800 }, ctx, undefined, CFG)
    const ms = Date.now() - t0
    if (r.error) return { name, url, ms, err: r.error }
    const tag = [r.charset, r.rendered ? 'SPA' : '', r.paginated > 1 ? `pg${r.paginated}` : '', r.mode].filter(Boolean).join(' ')
    return { name, url, ms, ok: true, tag, chars: r.charsTotal, title: (r.title || '').slice(0, 38), head: (r.text || '').replace(/\s+/g, ' ').slice(0, 60) }
  } catch (e) {
    return { name, url, ms: Date.now() - t0, err: 'CRASH: ' + e.message }
  }
}

async function mapLimit(items, limit, fn) {
  const out = []
  let idx = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) out[idx] = await fn(items[idx++])
  })
  await Promise.all(workers)
  return out
}

const results = await mapLimit(SITES, CONC, runOne)
let ok = 0
for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
  if (r.ok) {
    ok++
    console.log(`  OK   | ${r.name.padEnd(20)} | ${r.ms}ms ${r.tag} | ${r.chars}字符 | ${r.title}`)
    console.log(`       |   正文头: ${r.head}`)
  } else {
    console.log(`  ERR  | ${r.name.padEnd(20)} | ${r.ms}ms | ${r.err}`)
  }
}
console.log(`\n${ok}/${results.length} ok`)
if (results.some((r) => r.err && r.err.startsWith('CRASH'))) process.exit(1)
