// multi-site.mjs — real-world multi-site verification for dsh-read-url
// 152-site concurrent sweep: Chinese portals / SPA / encodings (GBK/Big5/
// Shift-JIS/Korean) / anti-bot / type-block / redirects / DNS-failure /
// overseas / Q&A / forum / e-commerce / video / music / game / novel /
// government / edu / encyclopedia / feeds / JSON APIs / plain-text / gzip.
// Checks extraction quality, charset detection, noise filtering, SPA
// rendering, continuation, batch and site-crawl.
// Run: node multi-site.mjs     (tune concurrency: CONC=8 node multi-site.mjs)
import * as m from './index.js'

const SITES = [
  // ---- 第 1 批：基础类型 ----
  ['bilibili-rank', 'https://www.bilibili.com/v/popular/rank/all'],
  ['xiaoheihe (SPA)', 'https://www.xiaoheihe.cn/'],
  ['juejin (SPA)', 'https://juejin.cn/'],
  ['zhihu (login-wall)', 'https://www.zhihu.com/'],
  ['weibo (login-wall)', 'https://weibo.com/'],
  ['csdn', 'https://www.csdn.net/'],
  ['cnblogs (multi-article)', 'https://www.cnblogs.com/'],
  ['sina-news', 'https://news.sina.com.cn/'],
  ['qq-news', 'https://news.qq.com/'],
  ['163-news', 'https://news.163.com/'],
  ['douban', 'https://www.douban.com/'],
  ['baidu (anti-bot)', 'https://www.baidu.com/'],
  ['ruanyifeng (static)', 'https://www.ruanyifeng.com/blog/'],
  ['example.com (static)', 'https://example.com/'],
  ['mdn (static doc)', 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript'],
  ['wikipedia-zh (geo/anti-bot)', 'https://zh.wikipedia.org/wiki/JavaScript'],
  ['w3c (403 for chrome UA)', 'https://www.w3.org/TR/'],
  ['github (net/tls boundary)', 'https://github.com/'],
  ['sohu', 'https://www.sohu.com/'],
  ['ifeng', 'https://www.ifeng.com/'],
  ['sspai (SPA)', 'https://sspai.com/'],
  ['v2ex (proxy-fallback)', 'https://www.v2ex.com/'],
  ['bbc-zh (proxy-fallback)', 'https://www.bbc.com/zhongwen/simp'],
  ['wikipedia-en (net-boundary)', 'https://en.wikipedia.org/wiki/JavaScript'],
  ['pdf-sample (type block)', 'https://mozilla.github.io/pdf.js/web/compressed.tracemonkey-pldi-09.pdf'],
  ['httpbin-png (type block)', 'https://httpbin.org/image/png'],
  ['httpbin-404 (net-boundary)', 'https://httpbin.org/status/404'],
  ['httpbin-redirect (net-boundary)', 'https://httpbin.org/redirect/3'],
  ['dns-fail (ENOTFOUND expected)', 'https://nonexistent-domain-xyz123.com/'],
  // ---- 第 2 批：中文互联网多类型 ----
  ['zhihu-zhuanlan (Q&A/column)', 'https://zhuanlan.zhihu.com/'],
  ['baidu-baike (encyclopedia)', 'https://baike.baidu.com/'],
  ['hupu (forum)', 'https://www.hupu.com/'],
  ['36kr (tech media, SPA)', 'https://36kr.com/'],
  ['qidian (novel)', 'https://www.qidian.com/'],
  ['gov.cn (government)', 'https://www.gov.cn/'],
  ['bupt.edu.cn (education)', 'https://www.bupt.edu.cn/'],
  ['bilibili-video (video page, SPA)', 'https://www.bilibili.com/video/BV1xx411c7mD'],
  ['zhidao.baidu (Q&A)', 'https://zhidao.baidu.com/'],
  ['tieba (forum, anti-bot)', 'https://tieba.baidu.com/'],
  ['zol (tech media, gbk)', 'https://www.zol.com.cn/'],
  ['vuejs-doc (tech doc, bare-main fix)', 'https://cn.vuejs.org/guide/introduction.html'],
  // ---- 第 3 批：feeds / JSON（v1.0.0）----
  ['ruanyifeng-feed (RSS/Atom)', 'https://www.ruanyifeng.com/blog/atom.xml'],
  ['github-api (JSON)', 'https://api.github.com/repos/vuejs/core'],
  ['github-blog-feed (Atom)', 'https://github.blog/feed/'],
  ['v2ex-feed (Atom)', 'https://www.v2ex.com/index.xml'],
  ['qidian-rank (pagination candidate)', 'https://www.qidian.com/rank/yuepiao/'],
  ['oschina (pagination candidate)', 'https://www.oschina.net/blog'],
  // ---- 第 4 批：繁体中文 / 港台 ----
  ['ptt-hotboards (TW, forum)', 'https://www.ptt.cc/bbs/hotboards.html'],
  ['ltn (TW 自由时报)', 'https://news.ltn.com.tw/'],
  ['udn (TW 联合新闻网)', 'https://udn.com/news/index'],
  ['pchome-tw (TW portal)', 'https://www.pchome.com.tw/'],
  ['hk01 (HK media)', 'https://www.hk01.com/'],
  ['gov-hk (HK government)', 'https://www.gov.hk/tc/index.html'],
  // ---- 第 5 批：日韩站点（编码探测）----
  ['2ch.net (JP, Shift-JIS)', 'https://www.2ch.net/'],
  ['yahoo-jp (JP portal)', 'https://www.yahoo.co.jp/'],
  ['hatena (JP bookmark)', 'https://b.hatena.ne.jp/'],
  ['goo-jp (JP legacy portal)', 'https://www.goo.ne.jp/'],
  ['naver (KR portal)', 'https://www.naver.com/'],
  ['daum (KR portal)', 'https://www.daum.net/'],
  // ---- 第 6 批：国内门户/媒体扩充 ----
  ['thepaper (澎湃, SPA)', 'https://www.thepaper.cn/'],
  ['jiemian (界面)', 'https://www.jiemian.com/'],
  ['yicai (第一财经)', 'https://www.yicai.com/'],
  ['caixin (财新, paywall)', 'https://www.caixin.com/'],
  ['huanqiu (环球网)', 'https://www.huanqiu.com/'],
  ['guancha (观察者网)', 'https://www.guancha.cn/'],
  ['ithome (IT之家)', 'https://www.ithome.com/'],
  ['huxiu (虎嗅)', 'https://www.huxiu.com/'],
  ['ifanr (爱范儿)', 'https://www.ifanr.com/'],
  ['leiphone (雷锋网)', 'https://www.leiphone.com/'],
  ['qq-portal (腾讯网)', 'https://www.qq.com/'],
  ['sina-sports (新浪体育)', 'https://sports.sina.com.cn/'],
  ['163-money (网易财经)', 'https://money.163.com/'],
  ['chinanews (中新网)', 'https://www.chinanews.com.cn/'],
  ['gmw (光明网)', 'https://www.gmw.cn/'],
  ['cctv (央视网)', 'https://www.cctv.com/'],
  ['china-com (中国网, http+GBK)', 'http://www.china.com.cn/'],
  ['people (人民网, http+GB2312)', 'http://www.people.com.cn/'],
  ['eastmoney (东方财富)', 'https://www.eastmoney.com/'],
  ['xueqiu (雪球, SPA+anti-bot)', 'https://xueqiu.com/'],
  // ---- 第 7 批：论坛/社区 ----
  ['tianya (天涯, anti-bot)', 'https://www.tianya.cn/'],
  ['nga (NGA 游戏论坛)', 'https://bbs.nga.cn/'],
  ['kdnet (凯迪)', 'https://club.kdnet.net/'],
  ['douban-group (豆瓣小组)', 'https://www.douban.com/group/'],
  ['reddit (overseas forum)', 'https://www.reddit.com/'],
  // ---- 第 8 批：电商（反爬重灾区）----
  ['jd (京东)', 'https://www.jd.com/'],
  ['taobao (淘宝, anti-bot)', 'https://www.taobao.com/'],
  ['suning (苏宁)', 'https://www.suning.com/'],
  ['vip (唯品会)', 'https://www.vip.com/'],
  ['dangdang (当当, http)', 'http://www.dangdang.com/'],
  ['amazon-cn (亚马逊中国)', 'https://www.amazon.cn/'],
  ['pinduoduo (拼多多, SPA)', 'https://www.pinduoduo.com/'],
  // ---- 第 9 批：招聘/房产/汽车 ----
  ['zhaopin (智联)', 'https://www.zhaopin.com/'],
  ['zhipin (BOSS直聘, anti-bot)', 'https://www.zhipin.com/'],
  ['lagou (拉勾)', 'https://www.lagou.com/'],
  ['lianjia-bj (链家北京)', 'https://bj.lianjia.com/'],
  ['anjuke (安居客, anti-bot)', 'https://www.anjuke.com/'],
  ['autohome (汽车之家)', 'https://www.autohome.com.cn/'],
  ['yiche (易车)', 'https://www.yiche.com/'],
  ['dongchedi (懂车帝, SPA)', 'https://www.dongchedi.com/'],
  // ---- 第 10 批：视频/音乐/游戏 ----
  ['iqiyi (爱奇艺)', 'https://www.iqiyi.com/'],
  ['youku (优酷)', 'https://www.youku.com/'],
  ['vqq (腾讯视频)', 'https://v.qq.com/'],
  ['mgtv (芒果TV)', 'https://www.mgtv.com/'],
  ['douyin (抖音, heavy anti-bot)', 'https://www.douyin.com/'],
  ['kuaishou (快手)', 'https://www.kuaishou.com/'],
  ['netease-music (网易云音乐)', 'https://music.163.com/'],
  ['yqq (QQ音乐)', 'https://y.qq.com/'],
  ['kugou (酷狗)', 'https://www.kugou.com/'],
  ['17173 (游戏门户)', 'https://www.17173.com/'],
  ['gamersky (游民星空)', 'https://www.gamersky.com/'],
  ['3dmgame (3DM)', 'https://www.3dmgame.com/'],
  ['taptap (游戏社区, SPA)', 'https://www.taptap.cn/'],
  // ---- 第 11 批：大学/政府/学术 ----
  ['tsinghua (清华)', 'https://www.tsinghua.edu.cn/'],
  ['pku (北大)', 'https://www.pku.edu.cn/'],
  ['fudan (复旦)', 'https://www.fudan.edu.cn/'],
  ['sjtu (上交)', 'https://www.sjtu.edu.cn/'],
  ['ustc (中科大, legacy HTML)', 'https://www.ustc.edu.cn/'],
  ['zju (浙大)', 'https://www.zju.edu.cn/'],
  ['moe-gov (教育部, http)', 'http://www.moe.gov.cn/'],
  ['miit (工信部)', 'https://www.miit.gov.cn/'],
  ['stats-gov (国家统计局)', 'https://www.stats.gov.cn/'],
  ['cnki (知网)', 'https://www.cnki.net/'],
  ['arxiv (学术, overseas)', 'https://arxiv.org/'],
  // ---- 第 12 批：海外技术站（直连可达或超时归因）----
  ['stackoverflow', 'https://stackoverflow.com/'],
  ['hackernews', 'https://news.ycombinator.com/'],
  ['dev.to', 'https://dev.to/'],
  ['react.dev (docs)', 'https://react.dev/'],
  ['nodejs.org (docs)', 'https://nodejs.org/en'],
  ['rust-lang.org (docs)', 'https://www.rust-lang.org/'],
  ['python-docs (docs)', 'https://docs.python.org/3/'],
  ['go.dev (docs)', 'https://go.dev/'],
  ['mozilla.org', 'https://www.mozilla.org/'],
  ['gnu.org (legacy table HTML)', 'https://www.gnu.org/'],
  ['gitlab', 'https://gitlab.com/'],
  ['svelte.dev (docs)', 'https://svelte.dev/'],
  ['medium (paywall)', 'https://medium.com/'],
  ['nytimes (paywall)', 'https://www.nytimes.com/'],
  ['aljazeera', 'https://www.aljazeera.com/'],
  // ---- 第 13 批：特殊内容类型 / 边界 ----
  ['httpbin-html (standard HTML)', 'https://httpbin.org/html'],
  ['httpbin-utf8 (utf8 stress)', 'https://httpbin.org/encoding/utf8'],
  ['httpbin-gzip (gzip body)', 'https://httpbin.org/gzip'],
  ['httpbin-redirect6 (redirect chain)', 'https://httpbin.org/redirect/6'],
  ['httpbin-delay5 (slow response)', 'https://httpbin.org/delay/5'],
  ['httpbin-bytes (binary blob)', 'https://httpbin.org/bytes/1024'],
  ['jsonplaceholder (JSON API)', 'https://jsonplaceholder.typicode.com/posts/1'],
  ['hn-api (JSON API)', 'https://hacker-news.firebaseio.com/v0/item/8863.json'],
  ['github-raw-md (text/plain)', 'https://raw.githubusercontent.com/vuejs/core/main/README.md'],
  ['solidot-rss (RSS)', 'https://www.solidot.org/index.rss'],
  ['sspai-feed (RSS)', 'https://sspai.com/feed'],
  ['cnbeta-rss (RSS)', 'https://www.cnbeta.com.tw/backend.php?m=rss'],
  ['zongheng (纵横小说)', 'https://www.zongheng.com/'],
  ['jjwxc (晋江, legacy GBK)', 'https://www.jjwxc.net/'],
]

const tools = []
m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
const read = tools.find((t) => t.name === 'read_url')
const batchTool = tools.find((t) => t.name === 'read_url_batch')
const siteTool = tools.find((t) => t.name === 'read_url_site')

function short(s, n = 70) {
  if (s === undefined) return 'undefined'
  s = String(s)
  return s.length > n ? s.slice(0, n) + '…' : s
}

function noiseCheck(text) {
  if (!text) return false
  const t = text.slice(0, 2000)
  // CSS-property names only: `{ data ()` in JS code samples must NOT trip
  // this (vuejs.org body contains code blocks with object literals).
  return /font-size|font-family|margin:|padding:|\.css/i.test(t) ||
    /\{\s*(?:font-|margin|padding|color|display|background|width|height|position|border|text-align)[a-z-]*:/i.test(t) ||
    /<[a-z/!]/.test(t)
}

const CONC = Math.max(1, Number(process.env.CONC) || 8)
console.log(`=== dsh-read-url multi-site verification (${SITES.length} sites, concurrency ${CONC}) ===\n`)

const results = new Array(SITES.length)
let doneCount = 0

async function runOne(i) {
  const [label, url] = SITES[i]
  const t0 = Date.now()
  let r
  try {
    r = await read.execute({ url, maxChars: 800 })
  } catch (e) {
    results[i] = { label, status: 'THREW', detail: e.message }
    console.log(`[${String(i + 1).padStart(3, '/')}${SITES.length}] ${label} … THREW (${Date.now() - t0}ms): ${short(e.stack || e.message, 100)}`)
    return
  }
  const ms = Date.now() - t0
  if (r.error) {
    results[i] = { label, status: 'ERR', detail: r.error }
    console.log(`[${String(i + 1).padStart(3, '/')}${SITES.length}] ${label} … ERR  (${ms}ms): ${short(r.error, 80)}`)
    return
  }
  const len = r.text ? r.text.length : 0
  const noisy = noiseCheck(r.text)
  const flags = [r.charset ? `charset=${r.charset}` : '', r.rendered ? 'SPA-rendered' : '', r.cached ? 'cached' : '', r.paginated > 1 ? `paginated=${r.paginated}` : '', r.feedCount ? `feed=${r.feedCount}` : '', noisy ? 'NOISE!' : ''].filter(Boolean).join(' ')
  if (len >= 200 && !noisy) {
    results[i] = { label, status: 'OK', chars: len, flags, ms }
    console.log(`[${String(i + 1).padStart(3, '/')}${SITES.length}] ${label} … OK   (${ms}ms) ${len}字符 ${flags}`)
  } else if (len > 0) {
    results[i] = { label, status: 'THIN', chars: len, flags, detail: short(r.text, 60), ms }
    console.log(`[${String(i + 1).padStart(3, '/')}${SITES.length}] ${label} … THIN (${ms}ms) ${len}字符 ${flags} | ${short(r.text, 40)}`)
  } else {
    results[i] = { label, status: 'EMPTY', flags, detail: r.spaHint || '', ms }
    console.log(`[${String(i + 1).padStart(3, '/')}${SITES.length}] ${label} … EMPTY(${ms}ms) ${flags} ${r.spaHint ? '| ' + short(r.spaHint, 60) : ''}`)
  }
}

const queue = SITES.map((_, i) => i)
await Promise.all(
  Array.from({ length: Math.min(CONC, queue.length) }, () => (async () => {
    for (;;) {
      const i = queue.shift()
      if (i === undefined) return
      await runOne(i)
      doneCount++
    }
  })()),
)

const counts = { OK: 0, THIN: 0, EMPTY: 0, ERR: 0, THREW: 0 }
for (const r of results) if (r) counts[r.status]++
const noiseN = results.filter((r) => r && r.status === 'OK' && /NOISE/.test(r.flags || '')).length
console.log(`\n=== summary: ${counts.OK} OK / ${counts.THIN + counts.EMPTY} THIN+EMPTY / ${counts.ERR} ERR / ${counts.THREW} THREW (noise among OK: ${noiseN}) ===`)
for (const r of results) {
  if (!r) continue
  console.log(`  ${r.status.padEnd(6)} | ${r.label} | ${r.detail || (r.chars ? `${r.chars}字符` : '')} ${r.flags || ''}`.trimEnd())
}

// ---- continuation (offset) on a long page ----
console.log('\n=== offset continuation (sina news, 800+800) ===')
const cont = await read.execute({ url: 'https://news.sina.com.cn/', maxChars: 800, offset: 800 })
if (cont.error) console.log('  cont ERR:', short(cont.error))
else console.log(`  chars ${cont.charsStart}+${cont.charsReturned}/${cont.charsTotal}${cont.cached ? ' cached' : ''} | ${short(cont.text, 40)}`)

// ---- batch (4 urls, mixed success/failure) ----
console.log('\n=== batch (4 urls) ===')
const bt = await batchTool.execute({ urls: ['https://example.com/', 'https://www.ruanyifeng.com/blog/', 'https://zh.wikipedia.org/wiki/JavaScript', 'https://www.w3.org/TR/'], maxChars: 500 })
console.log(`  ${bt.succeeded}/${bt.total} ok; failures: ${(bt.pages || []).filter((p) => p.error).map((p) => short(p.error, 50)).join(' | ') || 'none'}`)

// ---- site crawl (ruanyifeng, maxPages 5, depth 1) ----
console.log('\n=== site crawl (ruanyifeng, maxPages=5 depth=1) ===')
const st = await siteTool.execute({ url: 'https://www.ruanyifeng.com/blog/', maxPages: 5, maxDepth: 1 })
console.log(`  ${st.succeeded}/${st.total} pages${st.failed ? `, ${st.failed} failed` : ''}`)
for (const p of (st.pages || []).slice(0, 5)) console.log(`  [${p.depth}] ${short(p.title, 30)} (${p.chars}字符)`)

await m.closeBrowser().catch(() => {})
process.exit(0)
