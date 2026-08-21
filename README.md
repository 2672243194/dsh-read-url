# dsh-read-url

🌐 **English** | [中文](README.zh.md)

![dsh-read-url](docs/banner.svg)

[![npm](https://img.shields.io/npm/v/dsh-read-url)](https://www.npmjs.com/package/dsh-read-url)
[![License](https://img.shields.io/github/license/2672243194/dsh-read-url)](https://github.com/2672243194/dsh-read-url/blob/main/LICENSE)

URL reader plugin for DeepSeek Harness: fetch any URL — **webpages (HTML), JSON APIs, RSS/Atom feeds** — auto-detect encoding (UTF-16 BOM / GBK/GB2312 / UTF-8 / Big5 / Shift-JIS), extract the clean main content (**auto-joining paginated articles**), and return **token-efficient compact text or structured Markdown**.

Zero runtime dependencies (Node 20+ built-ins handle fetch/decode/extract), no API key, no server side — install and use.

## Why

DSH agents can search (getting links and snippets) but lack the step of "reading a URL into clean body text". The official `tool-web` `web_fetch` does a **whole-page turndown conversion** (nav/ads/sidebars all preserved) with a default cap of 200,000 characters — a token black hole. This plugin returns only what the model actually needs: **cleaned body + essential metadata**, truncated by default.

### Competitor comparison (measured from source/docs, 2026-08-15)

| Capability | Official `tool-web` web_fetch | dsh-webfetch | dsh-scrape-webpage | **dsh-read-url** |
|---|---|---|---|---|
| Body cleaning (container-level) | ❌ whole page | ⚠️ tag-level, nav/footer leak in | ⚠️ custom, noisy | ✅ article/main containers + noise stripping |
| Default output cap | 200,000 chars | 50,000 chars | 30,000 chars | **6,000 chars + paragraph-aligned truncation** |
| Chinese GBK/GB2312 | provider-dependent | ⚠️ not normalized, GB2312 garbles | ❌ not handled | ✅ normalized + mojibake fallback + UTF-16 BOM + Shift-JIS |
| JSON / RSS / Atom URLs | ❌ HTML only | ❌ | ❌ | ✅ native compact rendering |
| Paginated articles | ❌ manual per-page calls | ❌ | ❌ | ✅ auto-joined (default 3 pages) |
| Session-level cache | ❌ | ❌ | ❌ | ✅ 5-min TTL |
| `ctx.web` seam | ✅ (official core) | ❌ global fetch | ❌ | ✅ seam-first, fallback included |
| `ctx.effect` unload cleanup | ✅ | ❌ | ❌ | ✅ |
| Cooperative timeout (hidden from model) | ✅ | ⚠️ self-managed | ⚠️ self-managed | ✅ `timeoutMs` + `exec.signal` |
| Model-facing output | whole-page Markdown | compact text | 15-field JSON | **compact text (no JSON parsing)** |
| Dependencies | official | TypeScript build | zero deps | zero deps (JS ESM, drop-in) |
| Anti-bot / degraded responses (UA & TLS fingerprint) | ⚠️ Node default UA; measured: https intercepted by middlebox TLS fingerprinting, Baidu returns a degraded page without trending topics | ❓ not disclosed | ❓ not disclosed | ✅ full browser UA; measured: full page fetched (Baidu trending topics intact) |

> Measured 2026-08-16 (local environment): with this plugin removed, the official `web_fetch` hitting `https://www.baidu.com` had its TLS handshake intercepted by a middlebox using program fingerprints (fell back to http to succeed), and Baidu returned a **server-side degraded page** (trending topics moved to JS loading, absent from static HTML). With `dsh-read-url` restored, https worked and trending topics were fully readable. Root cause: the request's UA and TLS characteristics decide whether sites/middleboxes treat you as a bot.

## DSH architecture compliance

Implemented per official docs (`docs/capability-seams.md`, `docs/cordis-primer.md`, `docs/tool-execution-pipeline.md`):

1. **Web access via the `ctx.web` capability seam** — all web requests go through `ctx.web.fetch()` first (provider resolved inside the seam, same as official `tool-web`), falling back to global fetch when the seam is absent. The network layer is replaceable, not bound to any provider;
2. **Reversible side effects** — the session cache is registered under `ctx.effect`, auto-cleared on plugin unload (temporal composability);
3. **Cooperative tool-call timeout** — `ToolDefinition.timeoutMs` declares the budget, `execute(args, exec)` forwards `exec.signal` to fetch; the timeout policy is enforced by the pipeline, never exposed to the model;
4. **Model-facing simplicity** — render emits compact text (`title:` header + body); the model consumes it directly with no JSON parsing. Defaults are the most token-efficient; structured output is opt-in.

## Install

```bash
# From GitHub (recommended, easy updates)
npx @deepseek-ai/dsh plugin --profile web add github:2672243194/dsh-read-url

# Local development
npx @deepseek-ai/dsh plugin --profile web add ./dsh-read-url
```

Restart DSH (Web/TUI); you should see `dsh-read-url` enabled in Settings → Plugins.

## Usage

Just talk to the agent:

```
Read https://example.com/article and summarize the key points
Read https://docs.example.org/guide in markdown mode
Read these URLs together and compare their viewpoints: <url1> <url2> <url3>
```

### Real examples (measured)

**1. Token economy — return only what the model needs**

`read_url` on a portal returns cleaned body capped at `maxChars` (default 6,000) — not the raw page with nav/ads/footers. Repeat reads hit the 5-min cache (`(cached)`), so the agent never re-fetches:

```
title: 新闻中心首页_新浪网
charset utf-8
(chars 800/12398 — 截断，offset 续读)
```

**2. Overseas sites — direct + proxy race**

When a proxy is configured, the direct fetch and the proxy `curl` start together and the first to complete wins. A blocked overseas site that used to cost ~11s (direct-connect timeout + fallback) now reads in under a second:

```
BBC 中文: OK (633ms) — clean 4,000+ chars of headline news
```

**3. Long-article continuation (`offset`)**

A 12,000-char article is read in slices; `offset` resumes from cache without repeating earlier text — the model keeps exactly what it needs in context:

```
chars 800+800/12398 · cached
```

**4. Batch research across pages**

`read_url_batch` reads up to 10 pages in parallel (concurrency 4), each cleaned individually, failures isolated:

```
读取 2/4 页成功，2 页失败
--- 阮一峰的网络日志 (491 字符) ---
--- Example Domain (127 字符) ---
[失败] https://zh.wikipedia.org/... — Fetch failed: HTTP 403 ...
```

### Tools

**`read_url(url, maxChars?, offset?, mode?, includeLinks?)`** — fetch and extract clean body. Handles HTML pages, JSON APIs (compact re-indented render) and RSS/Atom feeds (entry list + `feedCount`); paginated articles (novel/news/forum) are auto-joined up to `paginateMax` pages; page metadata (`published`, `author`) is harvested automatically — meta tags first, with a byline fallback from the body text when meta is absent

| Param | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | http(s) URL |
| `maxChars` | number | 6000 | Max body characters returned (500–20000) |
| `offset` | number | 0 | Resume reading from this character offset (long-article continuation; served from cache without repeating earlier text) |
| `mode` | string | `text` | `text` = plain (most token-efficient); `markdown` = structured |
| `includeLinks` | boolean | `false` | Also return up to 20 page links (title+URL) |

**`read_url_batch(urls, maxChars?, mode?, includeLinks?)`** — read multiple URLs (1–10) in parallel, each cleaned individually, merged into one compact report

| Param | Type | Default | Description |
|---|---|---|---|
| `urls` | string[] | required | http(s) URL list (1–10) |
| `maxChars` | number | 3000 | Max body characters per page (500–20000) |
| `mode` | string | `text` | `text` = plain; `markdown` = structured |
| `includeLinks` | boolean | `false` | Also return links per page (title+URL) |

- Concurrency capped at 4 (avoids rate-limiting); a failing page is **isolated** (`[失败]` + reason in the output) and does not affect the others;
- Reuses every `read_url` capability and the session cache (encoding, cleaning, SPA rendering, 5-min cache — repeat batches hit the cache).

**`read_url_site(url, maxPages?, maxDepth?, includeContent?, maxCharsPerPage?)`** — recursive site crawl: BFS from the entry URL across same-host pages, returns a compact site map

| Param | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | http(s) entry URL |
| `maxPages` | number | 15 | Max pages to crawl (2–50; bounds output) |
| `maxDepth` | number | 2 | Max link depth from entry (1–5) |
| `includeContent` | boolean | `false` | Attach a short body summary per page (default off — structure first, token-efficient) |
| `maxCharsPerPage` | number | 500 | Summary length per page when includeContent=true (200–2000) |

- **Same-host only**; login/API/static-asset paths are skipped; URLs deduped (fragment stripped);
- Concurrency 2 (gentle on the target site); per-page failures recorded as `[失败]` without aborting;
- Output is an indented tree: `[depth] title (chars) URL`;
- **No SPA rendering here** (crawling favors speed/breadth) — use `read_url` for JS-only pages.

**`read_url_links(url, limit?)`** — list the page's links without returning body text (lighter; good for sourcing / mapping a site)

| Param | Type | Default | Description |
|---|---|---|---|
| `url` | string | required | http(s) URL |
| `limit` | number | 20 | Max links returned (1–50) |

### Configuration (optional)

Override via the profile's `cordis.patch.yml` (defaults in the plugin's own `cordis.patch.yml`):

```yaml
- id: dsh-read-url
  config:
    timeoutMs: 15000      # per-request timeout (500-120000, clamped)
    maxBytes: 3145728     # response body cap (bytes)
    maxChars: 6000        # default body truncation
    maxLinks: 20          # read_url_links default count
    spaRender: true       # SPA rendering enhancement (needs playwright installed; degrades with a hint otherwise)
    paginate: true        # auto-join paginated articles
    paginateMax: 3        # pages per article, incl. the first (1-10, clamped)
    userAgent: '...'      # request UA
    cacheTtlMs: 300000    # success-cache TTL
    cacheMax: 32          # cache entry cap
```

Values are coerced and clamped to sane ranges at load — quoted numbers in YAML work, garbage falls back to defaults.

### Output (compact)

```json
{
  "url": "...",
  "title": "...",
  "siteName": "...",
  "lang": "zh-CN",
  "charset": "gbk",
  "mode": "text",
  "truncated": true,
  "charsTotal": 12990,
  "charsReturned": 6000,
  "charsStart": 0,
  "text": "...",
  "rendered": true,        // only when extracted after SPA rendering
  "paginated": 3,          // pages auto-joined (only when > 1)
  "feedCount": 20,         // RSS/Atom entries (feeds only)
  "published": "2026-08-01",  // when the page declares it (incl. byline fallback)
  "author": "...",           // when the page declares it (incl. byline fallback)
  "links": []               // only when includeLinks=true
}
```

### PTC mode

Output is pure JSON and composable; orchestrate parallel multi-URL reads in PTC mode:

```ts
const results = await Promise.all([
  read_url({ url: 'https://a.example.com', maxChars: 4000 }),
  read_url({ url: 'https://b.example.com', maxChars: 4000 }),
])
```

## Token economy (core)

1. **Body text only by default** — no redundant headings/keywords/images/word-count fields; take them via params only when needed;
2. **Paragraph-aligned truncation + offset continuation** — 6,000 chars by default (~3,000 tokens), cut at paragraph boundaries to keep semantics; output notes a single line `(chars 6000/12990 — truncated, continue via offset)`; resume starts at the given offset, sliced from cache — **no repetition of already-read text** (measured 0+500 → 500+500, no overlap); offset past the end returns empty instead of repeating the head;
3. **`text` mode first** — Markdown structure is opt-in;
4. **Compact text render** — the model sees a `title:` header + body directly, no JSON parsing; `siteName` is omitted when identical to the hostname; every status hint is one short line (truncated / cached / rendered), no verbose paragraphs;
5. **Two-tier cache** — successful results cached per URL for 5 minutes (repeat reads hit cache: fewer network calls and fewer model retries); **failed results cached for 30 seconds** so a broken URL never triggers a re-fetch loop;
6. **KV-cache friendly (DeepSeek cost tuning)** — tool schema/description stay **static text** (no config values embedded), so changing config never invalidates the reusable prompt prefix and KV cache keeps hitting. DeepSeek's cache-hit tokens cost about 1/10 of misses — the more stable the prefix, the cheaper the run (same analysis as the official `tool-web` docs);
7. **Batch shares the cache** — `read_url_batch` reuses the same cache (repeat batches hit it directly) and caps each page at 3,000 chars (below the single-page 6,000) to bound total output;
8. **Compact fixed cost** — the four tool descriptions total ~900 chars (audited by a budget assertion in tests, kept static for KV-cache); extended HTML-entity decoding (45 named entities) means leftovers like `&mdash;`/`&hellip;` never waste tokens or render as mojibake.

## Technical notes

- **Encoding**: BOM-first detection (UTF-8 / UTF-16LE / UTF-16BE — byte-level evidence beats any declared charset), then HTTP `Content-Type` charset → HTML meta; built-in `TextDecoder` transcoding (Node 20+ full-icu, so declared Shift-JIS/EUC-JP/GBK/Big5 all decode), GB2312 normalized to GBK, auto-fallback to UTF-8 on mojibake;
- **Content dispatch**: a URL is not always an HTML page — JSON APIs are re-rendered compact (indent 1), RSS 2.0 / Atom feeds parse into an entry list (`title — url` + summary, `feedCount` field, full items via `includeLinks`; entry summaries are iteratively tag-stripped and entity-decoded until stable, so double-escaped `&lt;a&gt;` never leaks as a literal tag); XML sitemaps are rejected with a clear reason (no reading value); everything else falls through to the HTML pipeline;
- **Extraction**: prefers `<article>` (all articles joined on aggregation pages; an unrelated tiny article — e.g. a newsletter card — falls through to `<main>` when its text is under 200 chars and `<main>` exists) / `<main>` / `role="main"`; `role="main"` containers are closed via **depth counting of balanced tags** (nested divs no longer cut the block at the first `</div>` — measured: gnu.org used to lose 7/8 of its body this way); strips `nav/footer/header/aside/form/iframe` and ad-like containers, heuristic fallback to `<body>`; on the body path a **text-density pass** drops link-dominated segments (related posts, category sidebars, hot-article widgets) — pages with standard containers never reach it;
- **Pagination**: auto-follows `rel=next` or a short next-page anchor (下一页 / next / › / » — conservative, no fuzzy guessing); same-host only, loop-guarded, repeated paragraphs across the seam de-duplicated; continuation pages take the fast static path (a paginated SPA chain would cost one full render per page);
- **Metadata**: `published` / `author` harvested from meta tags into the output and the status line; when the page has no such meta (ruanyifeng.com ships zero author/date tags) a **byline fallback** harvests the body head (600-char window: `作者：X / 日期：Y` — meta wins, deep-body mentions ignored, markdown link syntax stripped); empty-body pages (login walls, JS shells) fall back to `og:description` as a hint instead of nothing;
- **Markdown**: self-written lightweight tag state machine (headings/paragraphs/lists/blockquotes/code/tables/inline bold-italic-links), zero deps; images with alt text render as `![alt](src)` (decorative empty-alt images are dropped), code fences carry the language hint from `language-*` highlighter classes;
- **Safety**: http/https only; no page scripts executed; responses over 3 MB rejected; 15s timeout; **429/503 honored with one Retry-After-aware retry** (capped at 5s so the cooperative timeout still bounds the call); **headerless responses are byte-sniffed** (a NUL byte or >30% control characters marks the body binary — PDFs/images rejected explicitly instead of mojibake through the HTML pipeline); structured errors (HTTP status / timeout / unsupported type / DNS cause such as `getaddrinfo ENOTFOUND` vs blocked-network timeout);
- **Network fallback (proxy, raced)**: when a proxy is configured (env `HTTPS_PROXY`/`HTTP_PROXY`, falling back to the Windows system proxy registry where Clash-type apps persist it), the plugin starts the direct fetch and a proxy `curl` (`-x` passed explicitly, zero npm deps) **at the same time** and uses whichever completes first — so overseas sites that are blocked on direct connect are served through the user's own proxy in ~0.6s instead of waiting out the direct-connect timeout (~11s measured, -94%). The loser is aborted (curl killed / fetch aborted) and never enters the model context, so **token cost is unchanged**. A failed race returns the original direct error with the proxy attempt noted (`已尝试代理 …`); with no proxy configured the behaviour is exactly the plain direct connect;
- **Privacy**: the plugin never uses the developer's network configuration — the proxy fallback only reads **your own machine's** proxy (env vars or Windows system proxy) at runtime. No telemetry, no analytics, no data collection: the only outbound action is fetching the URL you asked it to read;
- **Optional enhancement 1 (Firefox Reader Mode algorithm)**: run `npm i @mozilla/readability happy-dom` in the DSH profile directory to auto-enable `@mozilla/readability` (MPL-2.0, referenced unmodified) for higher-quality extraction; falls back to the built-in heuristic when not installed — the core stays zero-dependency;
- **Optional enhancement 2 (SPA page rendering)**: run `npm i playwright && npx playwright install chromium` in the DSH profile directory to auto-enable it. When the extracted body is empty and the page is script-heavy (likely Vue/React client-rendered) or a JS-redirect shell (few scripts but an empty `<body>`), the plugin automatically renders it with headless Chromium before extracting (a `rendered` flag tells the model); the rendered text is accepted only when it meaningfully beats the static one (≥20 chars from an empty static extraction — short real content is no longer rejected); **bot-challenge defense** — Cloudflare-style interstitials ("Just a moment...") get an extra 8s poll for the auto-redirect, and if the page still looks like a challenge the rendered result is rejected and the static body kept (an interstitial can carry MORE text than the real body — measured 259 vs 135 chars — and must never be mistaken for an improvement); the interstitial DOM never feeds pagination/link extraction either; rendering waits for the DOM to stabilize (content stops growing) instead of `networkidle` — heartbeat-polling sites never idle, so this avoids 30s timeouts; when not installed it degrades with a clear install hint, never errors — the core stays zero-dependency;
- **Boundaries**: login-walled pages are not readable; SPA pages need the Playwright enhancement; **structured data (e.g. which like-count belongs to which comment) is out of text-extraction scope** — this plugin flattens HTML into readable text, so exact field↔value associations are lost; for precise fields, intercept the page's actual data API (see "Real-world validation" below).

## Real-world validation (2026-08-21, v1.0.0)

152-site sweep driven by `multi-site.mjs` (committed, re-runnable, 8-way concurrent): **115 OK / 17 expected boundaries (login-walls·captcha·short static pages) / 20 attributed network·anti-bot errors / 0 crashes** (final round with all pre-release fixes in; network-class errors vary ±5 between runs, all environment-attributed). Coverage: CN portals/media, e-commerce (JD/Taobao/Pinduoduo/Suning/Dangdang), video (Bilibili/iQiyi/Youku/Mango), music, games, novels (Qidian/Zongheng/JJWXC legacy GBK), Q&A/forums, government, universities (Tsinghua/PKU/Fudan/SJTU…), Traditional-Chinese TW/HK (PTT/LTN/UDN), JP/KR portals (Yahoo JP/Hatena/goo/naver/daum), overseas tech docs (GitHub/dev.to/react.dev/nodejs.org/rust/go/python), feeds, JSON APIs, encoding stress (GBK/GB2312/Big5/gb18030), anti-bot & network boundaries. All errors are environment-attributed (Wikipedia/Reddit/UDN connect-timeout; W3C/Tieba/NGA/StackOverflow 403; BUPT 412; DNS-fail…) — every one returned as a structured, correctly-attributed error, never a crash.

Sweep-driven pre-release fixes (each locked by unit tests): double-escaped RSS descriptions, headerless binary sniffing, JS-redirect shell rendering, **`role="main"` container cut short by nested divs** (gnu.org 165→800 chars), **tiny `<article>` hijacking the main content** (gitlab 71→800 chars), relaxed render-acceptance threshold.

Plus a **15-item DSH acceptance round** (a real agent driving every read_url tool end-to-end): 12 items fully conformant, the 3 findings all closed — ① Cloudflare's "Just a moment..." interstitial carries MORE text than the real body (259 vs 135 chars) and was mistaken for a render improvement → challenge-marker detection + an extra 8s wait for the auto-redirect + interstitial results rejected; ② ruanyifeng.com ships ZERO author/date meta tags, the byline only exists in body text → byline fallback harvesting the body head (verified: `author=阮一峰 published=2026年8月21日`); ③ PDF rejection now attributes clearly: `Unsupported content-type: application/pdf`.

| Category | Sites | Result |
|---|---|---|
| Portal navigation cleaning | Baidu / QQ / NetEase / Sina / Douban / CSDN / Sohu / Ifeng | ✅ clean text, no CSS noise |
| SPA rendering | Bilibili / Xiaoheihe / Juejin / QQ News / SSPAI / oschina / ThePaper / Xueqiu / Vipshop / TapTap | ✅ `rendered` flag, post-JS body |
| Multi-article aggregation | Cnblogs / Ruan Yifeng blog / Douban group / Hacker News | ✅ 800+ chars across articles (pagination-joined paginated=2~3) |
| **Feeds & data APIs (v1.0.0)** | Ruan Yifeng Atom / github.blog Atom / V2EX Atom / Solidot RSS / SSPAI RSS / GitHub API / HN API | ✅ `charset=feed` / `charset=json` compact render |
| Static doc pages | MDN / Ruan Yifeng / example.com / GitHub / vuejs.org / react.dev / nodejs.org / go.dev / svelte.dev | ✅ clean extraction (example.com = short page, expected) |
| **Legacy-layout fixes** | gnu.org (nested-div container) / gitlab (tiny-article hijack) | ✅ 800 chars after fix (165 / 71 chars before) |
| Q&A / forum / encyclopedia | Zhihu column / Hupu / Baidu Zhidao / Baike | ✅ clean text (Zhihu homepage = login-wall, expected) |
| GBK legacy encoding | ZOL / Dangdang / JJWXC (gb18030) / People.com.cn (GB2312) | ✅ no mojibake |
| E-commerce / video / music | JD / Taobao / Pinduoduo / Bilibili / iQiyi / NetEase Music / QQ Music | ✅ clean extraction (Amazon CN button page & Kuaishou login-wall, expected) |
| Government / education | gov.cn / MOE / MIIT / Stats Bureau / 8 universities | ✅ clean; BUPT 412 attributed (WAF) |
| Network / anti-bot boundary | W3C·Tieba·NGA·StackOverflow (403); Wikipedia·Reddit·UDN (connect-timeout); httpbin (503/binary rejected); DNS-fail (ENOTFOUND) | ✅ accurately attributed errors (HTTP status / timeout / ENOTFOUND) — not plugin defects |
| offset continuation | Sina News (1,602 chars) | ✅ 800+800 seamless, cache hit |
| Batch + failure isolation | 4-URL mix | ✅ 2/4 ok, failures isolated |
| Site crawl | Ruan Yifeng blog | ✅ 5/5 pages tree map |

- **77 zero-dep assertions** (incl. entity decoding, description-budget guard, link dedupe, table-separator escaping, proxy-fallback function, missing-args tolerance, race logic, empty-race guard, schema budget, bare-main pick, worst-case timeout budgets, yml string coercion + clamping, strict-host seam degradation, UTF-16 BOM, Shift-JIS, density filter, pagination join/cap/disable, JSON render, RSS parse, sitemap rejection, 429 Retry-After retry, image alt, code-fence language, metadata, og:description fallback, double-escaped feed, headerless binary sniff, nested role=main, tiny-article fallback, unbalanced-tag degradation, byline fallback, challenge-page detection) + **12 SPA-test assertions** all green;
- Real case: on a Xiaoheihe post, comment like-counts (`up` field) could not be attributed from flattened text — **precise fields should come from the page's underlying data API** (e.g. `/bbs/app/link/tree` JSON). This is a shared boundary of text extractors, not a defect.

## Roadmap

- [x] Single-page continuation (`offset` parameter)
- [x] On-demand SPA rendering (optional Playwright enhancement, auto-enabled once the browser is installed)
- [x] Batch reading (`read_url_batch`)
- [x] Recursive site crawl (`read_url_site`)
- [x] Native JSON / RSS / Atom support (v1.0.0)
- [x] Auto-joined paginated articles (v1.0.0)
- [x] UTF-16 BOM / Shift-JIS encoding boost (v1.0.0)
- [x] Text-density fallback + metadata harvesting (v1.0.0)
- [x] Bot-challenge defense (Cloudflare interstitial detection + auto-redirect wait + rejection, v1.0.0)
- [x] Byline fallback for meta-less pages (author / published, v1.0.0)

> From v1.0.0 the plugin enters maintenance mode: bug fixes first, updates kept rare.

## Development

```bash
node test.mjs          # zero-dependency self-tests (charset/extract/markdown/truncate)
node test-spa.mjs      # SPA rendering tests (12 assertions; SKIPs if playwright absent)
node multi-site.mjs    # 152-site real-world sweep (needs network, CONC=8 tunable): portals/SPA/login-walls/static/feeds/JSON/anti-bot/net-boundaries

# End-to-end (requires DSH CLI)
npx @deepseek-ai/dsh plugin --profile headless add .        # run from the parent dir of the plugin
npx @deepseek-ai/dsh --profile headless "use read_url to read https://example.com and output the title"
```

Verified against real DSH v0.1.0-rc.6: plugin loads, `read_url` registers, model calls it, real page content returned.

## Support

If dsh-read-url helps you, please give it a ⭐ Star on [GitHub](https://github.com/2672243194/dsh-read-url).

- Completely free and open source (MIT): zero dependencies, no API key, fully local processing, no data collection;
- Independently developed and maintained — your Star is the direct signal for whether I keep investing in it;
- More users means more features — the next one might be exactly what you need.

A Star costs nothing but helps this project go further. Thanks ⭐

## License

MIT
