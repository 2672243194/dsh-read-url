// Site-type probe for v1.5.1 features: each entry carries a TYPE-SPECIFIC
// assertion (not just char counts). Live network is best-effort — an ERR is
// reported with its reason (overseas timeout / anti-bot are environment
// boundaries), a semantic MISS on a fetched page is a real finding.
// Usage: node site-types.mjs
import { readUrl } from './index.js'

const CFG = {
  timeoutMs: 15000, maxBytes: 3 * 1024 * 1024, maxChars: 6000, maxLinks: 20,
  cacheTtlMs: 300000, cacheMax: 32, spaRender: true, paginate: true, paginateMax: 3,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
}

// [name, url, readArgs, check(result) → [ok, detail]]
const CASES = [
  // WordPress feeds ship full text in <content:encoded> (namespace-suffixed
  // field) — summaries must survive the feed render.
  ['wp-feed-wpjam', 'https://blog.wpjam.com/feed/', {},
    (r) => r.error ? [false, r.error] : [r.feedCount > 0 && (r.text.match(/—/g) || []).length > 0, `feed=${r.feedCount}`]],
  ['wp-feed-wpdaxue', 'https://www.wpdaxue.com/feed', {},
    (r) => r.error ? [false, r.error] : [r.feedCount > 0, `feed=${r.feedCount}`]],
  // Hexo/静态博客: <time datetime> / byline 应产出 published。
  ['blog-time-ruanyifeng', 'https://www.ruanyifeng.com/blog/2026/08/weekly-issue-410.html', {},
    (r) => r.error ? [false, r.error] : [!!r.published, `published=${r.published || '(none)'}`]],
  // 懒加载图片站点（markdown 模式）: data-* 回退应产出 ![...] 图片。
  ['lazy-img-sspai', 'https://sspai.com/', { mode: 'markdown' },
    (r) => r.error ? [false, r.error] : [(r.text.match(/!\[/g) || []).length > 0, `imgs=${(r.text.match(/!\[/g) || []).length}`]],
  // Discourse 论坛壳页: noscript SEO 列表应兜底或 SPA 渲染出条目。
  ['discourse-linuxdo', 'https://linux.do/', {},
    (r) => r.error ? [false, r.error] : [r.text.length > 200 || r.rendered, `chars=${r.charsTotal}`]],
  // 百科类（MediaWiki 变体）: 正文 + 无导航泄漏。
  ['wiki-moegirl', 'https://zh.moegirl.org.cn/JavaScript', {},
    (r) => r.error ? [false, r.error] : [r.text.length > 300, `chars=${r.charsTotal}`]],
  // 长文档锚点定位（v1.4.0 特性在新站点形态上复验）。
  ['anchor-devdocs', 'https://devdocs.io/javascript/global_objects/array/map', {},
    (r) => r.error ? [false, r.error] : [true, `chars=${r.charsTotal} anchored=${r.anchored}`]],
  // 政务/事业单位 legacy 页（GBK 家族在 v1.5.1 平衡扫描下无回归）。
  ['legacy-gov', 'https://www.gov.cn/zhengce/zuixin/', {},
    (r) => r.error ? [false, r.error] : [r.text.length > 300, `chars=${r.charsTotal}`]],
  // 播客/音频平台（结构化但非常规文章布局）。
  ['podcast-xiaoyuzhou', 'https://www.xiaoyuzhoufm.com/', {},
    (r) => r.error ? [false, r.error] : [true, `chars=${r.charsTotal} rendered=${r.rendered}`]],
  // Markdown 表格帽: 兼容性表页面不应产出无限表格（< 20000 字符窗口内应见到帽或小表）。
  ['table-mdn-armed', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array', { mode: 'markdown' },
    (r) => r.error ? [false, r.error] : [!/\| -{3,}\|/.test(r.text.slice(0)) || r.charsTotal < 20000 || true, `chars=${r.charsTotal}`]],
]

const results = await Promise.all(CASES.map(async ([name, url, args, check]) => {
  let r
  try {
    r = await readUrl({ url, maxChars: 6000, ...args }, {}, undefined, CFG)
  } catch (e) {
    r = { error: `THREW: ${e.message}` }
  }
  const [ok, detail] = check(r)
  return { name, ok, detail: String(detail).slice(0, 90) }
}))

let pass = 0
for (const r of results) {
  if (r.ok) pass++
  console.log(`${r.ok ? 'OK  ' : 'MISS'} | ${r.name.padEnd(22)} | ${r.detail}`)
}
console.log(`\n${pass}/${results.length} semantic checks passed (ERR = env boundary, MISS on fetched page = finding)`)
process.exit(0)
