# dsh-read-url

🌐 [English](README.md) | **中文**

![dsh-read-url](docs/banner.svg)

[![npm](https://img.shields.io/npm/v/dsh-read-url)](https://www.npmjs.com/package/dsh-read-url)
[![License](https://img.shields.io/github/license/2672243194/dsh-read-url)](https://github.com/2672243194/dsh-read-url/blob/main/LICENSE)

DeepSeek Harness 的 URL 阅读插件：抓取任意 URL——**网页（HTML）、JSON 接口、RSS/Atom 订阅源**——**自动识别编码（UTF-16 BOM / GBK/GB2312 / UTF-8 / Big5 / Shift-JIS）**，提取干净正文（**分页长文自动拼接**），输出**省 token 的紧凑文本或结构化 Markdown**。

核心零运行时依赖（Node 20+ 内置能力完成抓取/转码/提取），免 API key，免服务端，装完即用。

## 为什么做它

DSH 的 Agent 能搜索（返回链接和片段），但缺"把 URL 读成干净正文"这一步。官方 `tool-web` 的 `web_fetch` 是**整页 turndown 转换**（导航/广告/侧栏全保留），默认上限 20 万字符——token 黑洞。本插件只返回模型真正需要的：**净化后的正文 + 必要元数据**，并默认截断。

### 同类插件对比（2026-08-15 实测源码/文档）

| 能力 | 官方 `tool-web` web_fetch | dsh-webfetch | dsh-scrape-webpage | **dsh-read-url** |
|---|---|---|---|---|
| 正文净化（容器级提取） | ❌ 整页渲染 | ⚠️ 标签级去噪，nav/footer 仍混入 | ⚠️ 自研，含噪音 | ✅ article/main 容器 + 噪音剥离 |
| 默认输出上限 | 200000 字符 | 50000 字符 | 30000 字符 | **6000 字符 + 段落级截断** |
| 中文 GBK/GB2312 | 视 provider | ⚠️ 未归一化，GB2312 易乱码 | ❌ 未处理 | ✅ 归一化 + 乱码回退 + UTF-16 BOM + Shift-JIS |
| JSON / RSS / Atom URL | ❌ 仅 HTML | ❌ | ❌ | ✅ 原生紧凑渲染 |
| 分页长文 | ❌ 需逐页手动调用 | ❌ | ❌ | ✅ 自动拼接（默认 3 页） |
| 会话级缓存 | ❌ | ❌ | ❌ | ✅ 5 分钟 TTL |
| 走 `ctx.web` seam | ✅ 官方本体 | ❌ 全局 fetch | ❌ | ✅ 优先 seam，缺失回退 |
| `ctx.effect` 卸载清理 | ✅ | ❌ | ❌ | ✅ |
| 协作式超时（不暴露给模型） | ✅ | ⚠️ 自管 | ⚠️ 自管 | ✅ `timeoutMs` + `exec.signal` |
| 模型视角输出 | 整页 Markdown | 紧凑文本 | 15 字段 JSON | **紧凑文本（无需解析 JSON）** |
| 依赖 | 官方 | TS 需构建 | 零依赖 | 核心零运行时依赖（JS ESM 即装即用） |
| 反爬/降级响应（UA 与 TLS 指纹） | ⚠️ Node 默认 UA，实测 https 被中间设备按 TLS 指纹拦截、百度返回无热搜的降级版 | ❓ 未披露 | ❓ 未披露 | ✅ 完整浏览器 UA，实测获取完整版页面（百度热搜正常） |

> 2026-08-16 实测（本机环境）：停用本插件后用官方 `web_fetch` 读 `https://www.baidu.com`——TLS 握手被中间设备按程序指纹拦截（退回 http 才成功），且百度对 Node UA 返回**服务端降级版**（热搜词条改由 JS 异步加载，静态 HTML 不含）；换回 `dsh-read-url` 后 https 正常、热搜完整可读。差异根因：请求的 UA 与 TLS 特征决定网站/中间设备是否按 bot 处理。

## 遵循 DSH 架构理念

按官方文档实现（`docs/capability-seams.md`、`docs/cordis-primer.md`、`docs/tool-execution-pipeline.md`）：

1. **网络访问走 `ctx.web` 能力缝**——所有 web 访问优先通过 `ctx.web.fetch()`（seam 内解析 provider，与官方 `tool-web` 一致），seam 缺失时回退全局 fetch。网络层可替换，不绑定任何具体 provider；
2. **可逆副作用**——会话缓存注册在 `ctx.effect` 下，插件卸载即自动清理（时间可组合性）；
3. **协作式工具调用超时**——`ToolDefinition.timeoutMs` 声明预算，`execute(args, exec)` 把 `exec.signal` 转发给 fetch，超时策略由管线强制执行，不把超时暴露给模型；
4. **模型视角精简**——render 输出紧凑文本（`title:` 头部 + 正文），模型直接消费，无需解析 JSON；默认参数最省 token，结构化能力按需开启；
5. **并行工具调用**——4 个工具全部声明 `isConcurrencySafe`（v1.1.0 起）：共享状态（会话缓存 / 解码器缓存 / SPA 浏览器 page 隔离）均满足交换性安全，agent loop 可把多个 read_url 调用归入并行池——多源阅读任务的墙钟时间按最慢一站计，而非各站之和。

## 安装

```bash
# 从 GitHub（推荐，便于更新）
npx @deepseek-ai/dsh plugin --profile web add github:2672243194/dsh-read-url

# 本地开发
npx @deepseek-ai/dsh plugin --profile web add ./dsh-read-url
```

重启 DSH（Web/TUI）后，设置 → 插件列表应看到 `dsh-read-url` 已启用。

## 使用

直接对话：

```
帮我读一下 https://example.com/article 并总结要点
用 markdown 格式读 https://docs.example.org/guide
同时读一下这几个网址，对比它们的观点：<url1> <url2> <url3>
```

### 真实案例（实测数据）

**1. 省 token——只返回模型真正需要的内容**

门户页 `read_url` 返回按 `maxChars`（默认 6000）截断的干净正文——不是带导航/广告/页脚的原始页面。重复读取命中 5 分钟会话缓存（`(cached)`），模型不会重复抓取：

```
title: 新闻中心首页_新浪网
charset utf-8
(chars 800/12398 — 截断，offset 续读)
```

**2. 海外站——直连 + 代理并发竞速**

检测到代理时，直连与代理 `curl` 同时发起、先完成者胜。原本被墙的海外站（直连超时 + 回退约 11s）现在 1 秒内读到：

```
BBC 中文: OK (633ms) — 4000+ 字符干净头条新闻
```

**3. 长文续读（`offset`）**

1.2 万字符的文章分片读取，`offset` 从缓存续读且不重复前文——模型上下文只保留需要的部分：

```
chars 800+800/12398 · cached
```

**4. 跨页批量研究**

`read_url_batch` 并行读最多 10 页（并发 4），逐页净化、失败隔离：

```
读取 2/4 页成功，2 页失败
--- 阮一峰的网络日志 (491 字符) ---
--- Example Domain (127 字符) ---
[失败] https://zh.wikipedia.org/... — Fetch failed: HTTP 403 ...
```

### 工具

**`read_url(url, maxChars?, offset?, mode?, includeLinks?)`** — 抓取并提取干净正文。支持 HTML 网页、JSON 接口（紧凑重排渲染）、RSS/Atom 订阅源（条目列表 + `feedCount`）；分页长文（小说/新闻/论坛）自动拼接至 `paginateMax` 页；页面元数据（`published`、`author`）自动提取——meta 标签优先，无 meta 时从正文署名行兜底

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | http(s) URL |
| `maxChars` | number | 6000 | 返回正文最大字符数（500–20000） |
| `offset` | number | 0 | 从该字符偏移续读（长文续段，命中缓存不重复前文） |
| `mode` | string | `text` | `text` = 纯文本（最省 token）；`markdown` = 结构化 |
| `includeLinks` | boolean | `false` | 额外返回页面内最多 20 条链接（标题+URL） |

**`read_url_batch(urls, maxChars?, mode?, includeLinks?)`** — 批量读多个 URL（1–10 个），并行、逐页净化，合并成一个紧凑报告

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `urls` | string[] | 必填 | http(s) URL 列表（1–10 个） |
| `maxChars` | number | 3000 | 每页返回正文最大字符数（500–20000） |
| `mode` | string | `text` | `text` = 纯文本；`markdown` = 结构化 |
| `includeLinks` | boolean | `false` | 每页额外返回链接（标题+URL） |

- 并发 4 限制（防目标站限流），单页失败**不影响其他页**（结果里标注 `[失败]` + 原因）；
- 复用 `read_url` 的全部能力与缓存：编码识别、正文净化、SPA 渲染、5 分钟缓存（重复批量读直接命中）。

**`read_url_site(url, maxPages?, maxDepth?, includeContent?, maxCharsPerPage?)`** — 整站递归爬取：从入口 URL 出发，BFS 发现同域名页面，返回紧凑站点地图

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | http(s) 入口 URL |
| `maxPages` | number | 15 | 最多爬取页数（2–50，防 token 爆炸） |
| `maxDepth` | number | 2 | 最大链接深度（1–5） |
| `includeContent` | boolean | `false` | 每页附短正文摘要（默认关——结构优先，省 token） |
| `maxCharsPerPage` | number | 500 | includeContent 时每页摘要长度（200–2000） |

- **只爬同域名**；登录/API/静态资源路径自动跳过；URL 去重（去 fragment）；
- 并发 2 对目标站友好；单页失败记录 `[失败]` 不影响整体；
- 输出为缩进树：`[深度] 标题 (字符数) URL`；
- **不做 SPA 渲染**（整站是轻量批量抓取，渲染每页 1s+ 太慢）——SPA 页请用 `read_url` 单读。

**`read_url_links(url, limit?)`** — 只列出页面链接清单，不返回正文（更轻，适合找来源/摸站点结构）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | http(s) URL |
| `limit` | number | 20 | 最多返回链接数（1–50） |

### 配置（可选）

通过 profile 的 `cordis.patch.yml` 覆盖（默认值见插件自带 `cordis.patch.yml`）：

```yaml
- id: dsh-read-url
  config:
    timeoutMs: 15000      # 单请求超时（500-120000，自动钳制）
    maxBytes: 3145728     # 响应体上限（字节）
    maxChars: 6000        # 默认正文截断
    maxLinks: 20          # read_url_links 默认条数
    spaRender: true       # SPA 渲染增强（需 playwright 已安装，未装自动降级提示）
    paginate: true        # 分页长文自动拼接
    paginateMax: 3        # 每篇最多拼接页数，含首页（1-10，自动钳制）
    userAgent: '...'      # 请求 UA
    cacheTtlMs: 300000    # 成功缓存 TTL
    cacheMax: 32          # 缓存条目上限
```

配置在加载时统一强转数字并钳制到合理范围——YAML 里加引号的数字也能用，非法值回退默认。

### 输出结构（紧凑）

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
  "text": "……",
  "rendered": true,        // 仅 SPA 渲染后提取时出现
  "paginated": 3,          // 自动拼接的页数（仅 > 1 时出现）
  "feedCount": 20,         // RSS/Atom 条目数（仅订阅源）
  "published": "2026-08-01", // 页面声明了发布时间时（含署名行兜底）
  "author": "……",            // 页面声明了作者时（含署名行兜底）
  "links": []              // 仅 includeLinks=true 时
}
```

### PTC 模式

输出是纯 JSON、可组合，PTC 模式下一次编排多 URL 并行读取：

```ts
const results = await Promise.all([
  read_url({ url: 'https://a.example.com', maxChars: 4000 }),
  read_url({ url: 'https://b.example.com', maxChars: 4000 }),
])
```

## 省 token 设计（核心）

1. **默认只给正文**——不返回 headings/keywords/images/字数统计等冗余字段，需要时按参数取；
2. **段落级智能截断 + offset 续读**——默认 6000 字符（约 3000 token），在段落边界截断保证语义完整，输出行仅一行 `(chars 6000/12990 — 截断，offset 续读)` 引导；续读从指定偏移开始、命中缓存切片，**不重复返回已读前文**（实测 0+500 → 500+500，无重复）；offset 越界返回空而非重复开头；
3. **text 模式优先**——Markdown 结构按需开启；
4. **紧凑文本 render**——模型直接看到 `title:` 头部 + 正文，无需解析 JSON；`siteName` 与域名相同时省略；状态提示全部一行内（截断/续读/缓存/渲染标记），无长段落废话；
5. **双层缓存**——成功结果按 URL 缓存 5 分钟（重复读取直接命中，省网络也省模型重试）；**失败结果缓存 30 秒**（坏 URL 不会触发重复 fetch 循环）；
6. **KV Cache 友好（DeepSeek 成本特调）**——工具 schema/description 保持**静态文本**（不嵌入配置值），配置变更不会使可复用的 prompt 前缀失效，KV 缓存持续命中。DeepSeek 缓存命中 token 价格约为未命中的 1/10，前缀越稳定越省钱（官方 `tool-web` 文档同款分析）；
7. **批量共用缓存**——`read_url_batch` 内部复用同一套缓存，重复批量读直接命中，且每页默认 3000 字符（低于单页 6000）控制总量；
8. **固定开销压缩**——4 个工具 description 合计约 900 字符（有断言守卫，保持静态利于 KV 缓存）；HTML 实体解码扩展至 45 个命名实体，`&mdash;`/`&hellip;` 等残留不再浪费 token 或显示为乱码。

## 技术说明

- **编码**：BOM 优先探测（UTF-8 / UTF-16LE / UTF-16BE——字节级证据优先于任何声明），其次 HTTP `Content-Type` charset → HTML meta；内置 `TextDecoder` 转码（Node 20+ full-icu，页面声明的 Shift-JIS/EUC-JP/GBK/Big5 均可正确解码），GB2312 归一为 GBK，检测到乱码自动回退 UTF-8；
- **内容类型分发**：URL 不一定是 HTML——JSON 接口紧凑重排渲染（缩进 1 格），RSS 2.0 / Atom 订阅源解析为条目列表（`标题 — 链接` + 摘要，`feedCount` 字段，`includeLinks` 时附完整 items；条目摘要迭代「剥标签+解实体」直到稳定，双重转义的 `&lt;a&gt;` 不会漏成字面标签）；XML sitemap 明确拒绝（对模型无阅读价值）；其余全部走 HTML 管线；
- **正文提取**：优先 `<article>`（聚合页多篇合并；无关小卡片 article——如订阅挂件——文本不足 200 字符且页面有 `<main>` 时自动回落 main）/ `<main>` / `role="main"`，`role="main"` 容器用**深度计数找平衡闭合标签**（嵌套 div 不会在第一个 `</div>` 被截断——实测 gnu.org 曾因此只取到 1/8 正文）；剥离 `nav/footer/header/aside/form/iframe` 及广告类容器，启发式回归到 `<body>`；body 路径上追加**文本密度过滤**——丢弃链接主导的短块（相关推荐/分类侧栏/热门文章挂件），标准容器页面完全不走此路径；
- **分页拼接**：识别 `rel=next`（标准）或纯「下一页 / next / › / »」短锚文本（刻意保守，不做模糊猜测）；同域限定 + 防环；跨页重复段落自动去重；续页走静态快路径（分页 SPA 链每页一次完整渲染不划算）；
- **元数据**：`published` / `author` 从 meta 标签提取进输出字段与状态行；页面无相关 meta 时（如阮一峰博客零 meta 标签）从**正文头部 600 字符的署名行兜底**（「作者：X / 日期：2026年8月21日」，meta 优先、正文深部提及不误采、markdown 链接语法不泄漏）；空正文页（登录墙/JS 壳）回落到 `og:description` 作为提示，不再返回空；
- **Markdown**：自研轻量标签状态机（标题/段落/列表/引用/代码块/表格/行内加粗斜体链接），零依赖；带 alt 的图片渲染为 `![alt](src)`（空 alt 装饰图丢弃），代码块围栏带 `language-*` class 里的语言标注；
- **安全**：仅 http/https；不执行页面脚本；响应超 3MB 拒绝；15s 超时；**429/503 感知 Retry-After 重试一次**（封顶 5s，保证协作超时仍约束调用）；**无 Content-Type 头的响应按字节特征嗅探**（NUL 字节或控制字符占比 >30% 判为二进制，PDF/图片等明确拒绝，不进 HTML 管线产出乱码）；错误信息结构化返回（HTTP 状态/超时/类型不支持/DNS 归因如 `getaddrinfo ENOTFOUND` vs 被墙超时）；
- **网络回退（代理，并发竞速）**：检测到代理时（环境变量 `HTTPS_PROXY`/`HTTP_PROXY` → **Windows 系统代理**注册表，Clash 类软件的真正落点），插件**同时发起**直连 fetch 与代理 curl（`-x` 显式传参，零 npm 依赖），**先完成且成功者胜**——海外站（直连被墙）经用户自己的代理 ~0.6s 读到，不再等直连超时兜底（实测 11s → 633ms，-94%）。输者立即 abort（curl 进程 kill / fetch 中止），**结果从不进入模型上下文，token 消耗零变化**。双方均失败时返回原始直连错误并注明代理尝试（`已尝试代理 …`）；无代理配置时退化为纯直连（行为与 v0.4.3 完全一致）；
- **隐私**：插件**绝不使用开发者的任何网络配置**——代理回退只在运行时读取**你自己机器**的代理（环境变量或 Windows 系统代理）。无遥测、无统计、无数据收集：唯一的对外动作就是抓取你让它读的那个 URL；
- **可选增强一（Firefox Reader Mode 算法）**：在 DSH profile 目录执行 `npm i @mozilla/readability happy-dom` 后自动启用，正文提取升级为 `@mozilla/readability`（MPL-2.0，引用不改写），未安装时回退内置启发式提取器，核心保持零依赖；
- **可选增强二（SPA 页面渲染）**：在 DSH profile 目录执行 `npm i playwright && npx playwright install chromium` 后自动启用。检测到正文为空且（页面脚本密集 疑似 Vue/React 客户端渲染，或 body 为空的 JS 跳转壳——script 数不多但正文全靠跳转）时，自动用无头 Chromium 渲染后再提取（`rendered` 标记告知模型）；渲染结果仅在**显著优于**静态提取时采用（静态为空时 ≥20 字符即接受，防短正文被拒）；**人机验证页防御**——Cloudflare「Just a moment...」等指纹页识别后额外轮询 8s 供其自动跳转，仍未通过则拒绝渲染结果、保留静态正文（指纹页文字量可能超过真实正文，实测 259 vs 135 字符，绝不当作提升），指纹页 DOM 也不污染分页/链接提取；渲染采用 `domcontentloaded` + **DOM 稳定轮询**（内容停止增长即收，上限 10s）而非 `networkidle`——心跳轮询站永不空闲，避免 30s 超时；未安装时优雅提示安装方法、不报错——核心保持零依赖；
- **边界**：登录墙页面无法读取；SPA 页面需安装 Playwright 增强后渲染读取（未安装时返回明确提示）；**结构化数据（如评论的点赞数归属、榜单数值）不在文本提取范围**——本插件把 HTML 扁平化为可读文本，字段与数值的精确对应关系会丢失；需要精确字段时，用 Playwright 拦截页面实际调用的数据 API 获取（见下方「真实世界验证」）。

## 真实世界验证（2026-08-21，v1.0.0；2026-08-22 适配 DSH 0.1.1-rc.2 复验）

152 站全量实测（`multi-site.mjs` 已提交可复跑，8 并发）：**115 OK / 17 预期边界（登录墙·验证页·静态小页） / 20 网络·反爬归因错误 / 0 崩溃**（含全部发布前修复的终态轮；网络类错误逐轮有 ±5 波动，均为环境归因）。覆盖国内门户 / 媒体 / 电商（京东·淘宝·拼多多·苏宁·当当）/ 视频（B 站·爱奇艺·优酷·芒果）/ 音乐 / 游戏 / 小说（起点·纵横·晋江 legacy GBK）/ 问答 / 论坛 / 政府 / 高校（清北复交等 8 所）/ 港台繁体（PTT·自由时报·联合报）/ 日韩（Yahoo JP·Hatena·goo·naver·daum）/ 海外技术站（GitHub·dev.to·react.dev·nodejs·rust·go·python docs）/ 订阅源 / JSON API / 编码压力（GBK·GB2312·Big5·gb18030）/ 反爬与网络边界。错误全部环境归因（维基/Reddit/UDN 连接超时；W3C/贴吧/NGA/StackOverflow 403；北邮 412；DNS 失败等）——每一个都返回结构化、准确归因的错误，无一崩溃。

扫描驱动的发布前修复（全部带单测锁定）：RSS 双重转义、无头二进制嗅探、JS 跳转壳渲染、**`role="main"` 嵌套 div 截断**（gnu.org 165→800 字符）、**小 article 劫持主内容**（gitlab 71→800 字符）、渲染接受门槛放宽。

另有 **DSH 15 项全功能验收轮**（真实 Agent 调用 read_url 系工具逐项核对）：12 项完全符合，3 项问题全部修复闭环——① Cloudflare「Just a moment...」验证页文字量超过真实正文（259 vs 135 字符）被误当作渲染提升 → 挑战页特征识别 + 渲染后额外等待 8s 自动跳转 + 拒绝接受指纹页；② 阮一峰页面零 author/date meta 标签，作者/日期只在正文里 → byline 兜底从正文头部 600 字符提取署名行（实测 `author=阮一峰 published=2026年8月21日`）；③ PDF 类型拒绝归因 → 明确报 `Unsupported content-type: application/pdf`。

| 类别 | 站点 | 结果 |
|---|---|---|
| 门户导航净化 | 百度 / 腾讯 / 网易 / 新浪 / 豆瓣 / CSDN / 搜狐 / 凤凰 | ✅ 干净正文，无 CSS 噪音 |
| **SPA 渲染** | B 站 / 小黑盒 / 掘金 / QQ 新闻 / 少数派 / 开源中国 / 澎湃 / 雪球 / 唯品会 / TapTap | ✅ `rendered` 标记 + JS 执行后正文 |
| 多 article 聚合 | 博客园 / 阮一峰博客 / 豆瓣小组 / Hacker News | ✅ 800+ 字符多篇聚合（含分页拼接 paginated=2~3） |
| **订阅源与数据 API（v1.0.0）** | 阮一峰 Atom / github.blog Atom / v2ex Atom / Solidot RSS / 少数派 RSS / GitHub API / HN API | ✅ `charset=feed` / `charset=json` 紧凑渲染 |
| 静态文档页 | MDN / 阮一峰 / example.com / GitHub / vuejs.org / react.dev / nodejs.org / go.dev / svelte.dev | ✅ 干净提取（example.com 简单页，预期） |
| **legacy 布局修复** | gnu.org（嵌套 div 容器）/ gitlab（小 article 劫持） | ✅ 修复后 800 字符满额（修复前 165 / 71 字符） |
| 问答 / 论坛 / 百科 | 知乎专栏 / 虎扑 / 百度知道 / 百科 | ✅ 干净正文（知乎首页登录墙，预期） |
| GBK 老编码 | 中关村在线 / 当当 / 晋江（gb18030） / 人民网（GB2312） | ✅ 无乱码 |
| 电商 / 视频 / 音乐 | 京东 / 淘宝 / 拼多多 / B 站 / 爱奇艺 / 网易云 / QQ 音乐 | ✅ 干净提取（亚马逊跳转按钮页、快手登录墙，预期） |
| 政府 / 教育 | gov.cn / 教育部 / 工信部 / 统计局 / 清华北大等 8 所高校 | ✅ 干净；北邮 412 已归因（WAF） |
| 网络·反爬边界 | W3C·贴吧·NGA·StackOverflow（403）；维基·Reddit·UDN（连接超时）；httpbin（503/二进制拒绝）；DNS 失败（ENOTFOUND） | ✅ 错误全部准确归因（HTTP 状态/超时/ENOTFOUND），非插件缺陷 |
| **offset 续读** | 新浪新闻（1602 字符） | ✅ 800+800 无缝衔接、命中缓存 |
| **批量 + 失败隔离** | 4 URL 混合 | ✅ 2/4 成功、失败隔离 |
| **整站爬取** | 阮一峰博客 | ✅ 5/5 页树状站点地图 |

- **79 个单元断言**（含实体解码、description/schema 预算守卫、链接去重、表格分隔行转义、代理回退函数、空参容错、竞速逻辑、空竞速守卫、裸 main 提取、最坏链路超时预算、yml 字符串强转+钳制、严格宿主 seam 降级、UTF-16 BOM、Shift-JIS、密度过滤、分页拼接/封顶/关闭、JSON 渲染、RSS 解析、sitemap 拒绝、429 Retry-After 重试、图片 alt、代码语言、元数据、og:description 回落、双转义 feed、无头二进制嗅探、嵌套 role=main、薄 article 回落、不平衡标签降级、byline 兜底、人机验证页识别、isConcurrencySafe 声明 + 并发缓存竞态烟雾）+ **12 个 SPA 测试断言**全绿；
- 一个真实案例：小黑盒帖子的评论点赞数（`up` 字段）无法从扁平文本确定归属——**精确字段应走页面背后的数据 API**（如 `/bbs/app/link/tree` JSON），这是同类文本提取器的共同边界，不是缺陷。

## Roadmap

- [x] 单页多段续读（`offset` 参数）
- [x] SPA 页面按需渲染（可选 Playwright 增强，装浏览器后自动启用）
- [x] 批量读取（`read_url_batch`）
- [x] 整站递归爬取（`read_url_site`）
- [x] JSON / RSS / Atom 原生支持（v1.0.0）
- [x] 分页长文自动拼接（v1.0.0）
- [x] UTF-16 BOM / Shift-JIS 编码增强（v1.0.0）
- [x] 文本密度兜底 + 元数据提取（v1.0.0）
- [x] 人机验证页防御（Cloudflare 指纹页识别 + 等待自动跳转 + 拒绝误采，v1.0.0）
- [x] 无 meta 页面署名行兜底（author / published，v1.0.0）
- [x] 并行工具调用声明（isConcurrencySafe，多源阅读墙钟时间按最慢一站计，v1.1.0）

> v1.0.0 起进入维护期：以修 bug 为主，减少更新频率。

## 开发

```bash
node test.mjs          # 单元自测（转码/提取/Markdown/截断/批量/站点爬取/缓存隔离/配置钳制）

# SPA 渲染真实测试（需 playwright 已安装，未装自动 SKIP）
node test-spa.mjs      # 12 断言：JS 正文/渲染后链接/工具不崩溃/缓存隔离/JS 跳转壳

# 152 站真实世界验证（需联网，CONC=8 可调并发）
node multi-site.mjs    # 门户/SPA/登录墙/静态/订阅源/JSON/反爬/网络边界，输出分级结果

# 端到端验证（需已安装 DSH CLI）
npx @deepseek-ai/dsh plugin --profile headless add .        # 在插件目录的上一级执行
npx @deepseek-ai/dsh --profile headless "用 read_url 读取 https://example.com 并输出标题"
```

已通过 DSH v0.1.0-rc.6 真实运行验证：插件加载、`read_url` 注册、模型调用、真实页面返回全部正常。

## 支持

如果 dsh-read-url 对你有帮助，欢迎在 [GitHub](https://github.com/2672243194/dsh-read-url) 点个 ⭐ Star。

- 完全免费开源（MIT），零依赖、免 API key、纯本地处理、不收集任何数据；
- 独立开发维护，Star 数量是我判断是否继续投入迭代的直接依据；
- 用的人越多，功能越完善——下一个功能很可能就是你需要的那个。

一个 Star 不花一分钱，但能让这个项目走得更远。谢谢 ⭐

## License

MIT
