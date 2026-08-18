# Changelog

## [0.4.5] - 2026-08-18

### 直连 + 代理并发竞速（海外站提速 ~94%）

- **fetchPage 重构为双通道竞速**：有代理时同时发起直连 fetch 与代理 curl，`raceFirstSuccess` 取先完成且成功者，输者立即 abort（curl 进程 kill / fetch AbortController）——不再等待直连超时兜底
- **实测收益**（本机真实环境）：BBC 中文 11s → **633ms**（-94%）、V2EX 11s → **782ms**（-93%）；新浪等国内站 182ms 零感知（直连赢）；DNS 失败 / w3c 403 归因完整保留
- **代理探测前置**：`detectProxy()` 提前执行（有进程级缓存），无代理时退化为纯直连（行为与 v0.4.3 完全一致）
- **失败归因不变**：双方均失败时仍返回"直连原因 + 已尝试代理 X（代理返回/未连通）"
- **测试**：33 → **36 断言**（+raceFirstSuccess：成功优先/慢成功胜快失败/失败按序收集）；test-spa 10 全绿

## [0.4.4] - 2026-08-18

### 健壮性提升

- **4 个工具 execute 空参防御**：`undefined`/`null` args 不再抛 TypeError（返回明确错误）——应对异常调用
- **proxy-fallback 空响应防御**：curl 输出无元数据尾部时视为失败而非成功（防御异常响应）

### 隐私说明（README 新增）

- 明确声明：插件**绝不使用开发者的任何网络配置**——代理回退只读取**用户自己机器**的代理（环境变量或 Windows 系统代理）；无遥测、无统计、无数据收集，唯一对外动作是抓取用户指定读取的 URL

### 测试

- test.mjs 32 → **33 断言**（新增 4 工具空参容错断言）

## [0.4.3] - 2026-08-18

### 新增：直连失败自动代理回退（用户"默认直连，不行再走用户自己的代理"）

- **新模块 `proxy-fallback.js`**：直连失败（连接类错误：被墙/拒绝/DNS/连接超时）→ 检测用户代理 → curl 经代理重试一次
- **代理来源优先级**：环境变量 `HTTPS_PROXY/HTTP_PROXY` → **Windows 系统代理**（注册表 `HKCU Internet Settings`，Clash 等代理软件的真正落点；环境变量经常不存在）
- **无感设计**：代理读取成功返回与直连完全一致的结果（模型无感知）；失败返回原始直连错误 + 明确归因（"已尝试代理 X，代理未连通 / 代理返回 HTTP 403"）
- **不误伤**：插件自身超时（页面慢）不算连接失败，不触发代理；国内站直连成功零开销（新浪 230ms）
- **零 npm 依赖**：调用系统 curl（Win10+/macOS/Linux 标配），`-x` 显式传代理；`--max-filesize` 单位修正为字节
- 工具整体超时（非连接类）不触发代理回退

### 验证（29 站实测）

- **16 → 18 OK**：BBC 中文 / V2EX 从 ERR 变 OK（直连 10s 超时 → 自动代理 → 干净正文）
- 海外站错误全部准确归因：Wikipedia 403（代理可达但反爬）、httpbin 503（服务端故障）、PDF 404、DNS 未连通、代理 403——模型能区分"服务端错误/反爬/网络边界"
- 国内站零影响：新浪 230ms 直连；site crawl 5/5；offset 续读 / batch 隔离不变
- test.mjs 32 + test-spa 10 断言全绿（新增 proxy-fallback 函数验证）

## [0.4.2] - 2026-08-18

### 性能

- **looksLikeSpa 计数优化**：`match()` 建大数组 → `exec()` 循环计数（多 MB HTML 不再为每个 script 标签分配数组项）
- **SPA 空页轮询提前退出**：DOM 稳定检测改为"连续两次一致即停"（含空 body）——空白页不再白等满 10 秒
- **ctx.web seam 调用加协作超时**：官方 provider 挂起不再阻塞工具调用（与 fetchPage 同款 `timeoutMs` 约束）

### 修复 / 省 token

- **extractLinks URL 去重**：导航栏重复链接只保留一条（链接列表更紧凑，token 更省，覆盖不减）
- **缓存键去除 URL fragment**：`#锚点` 不再分裂缓存（续读命中率提升）
- **fetch 错误明确归因**：提取 undici `e.cause`——DNS 失败显示 `getaddrinfo ENOTFOUND`、被墙站显示超时，模型能区分"域名不存在"与"网络被阻断"，不再盲目重试；错误信息截断 ≤120 字符
- **blockMd 表格分隔行转义修复**：含 `|` 的表头单元格不再让 `---` 分隔行带反斜杠
- **batch render 链接截断**：每页 links 最多内联 6 条 + `…共 N 个`

### 测试 / 验证

- test.mjs 29 → **32 断言**（SPA 阈值 4/5 边界、链接去重、表格分隔行转义）
- **multi-site.mjs 扩展 18 → 29 站**：新增门户（搜狐/凤凰）、SPA（少数派）、海外与边界站（BBC-中文/维基英文/httpbin 404·重定向·PNG/PDF 类型拦截/DNS 失败）
- 29 站实测：**16 OK / 3 预期边界 / 10 环境网络边界 / 0 崩溃**（64s）；海外站 Node 直连被墙（curl 走代理可达）为环境限制非插件缺陷，错误信息现已明确归因；site crawl 阮一峰 5/5
- **海外站专项验证（08-18）**：curl 走 7897 代理拉取 BBC 中文（427KB）/V2EX（107KB）真实 HTML 后，本地提取管线输出 4112 / 6422 字符干净正文——**提取逻辑对海外站完全正常**，失败根因仅为 Node fetch 直连被墙（`NODE_USE_ENV_PROXY` 在 Node 22/24 均实测无效，不引入代理，网络通道由 DSH 官方 ctx.web seam 负责）；Wikipedia 代理 IP 被限流（403 Too Many Reqs）

## [0.4.1] - 2026-08-17

### 省 token 复审（18 站实测驱动）

- **4 个工具 description 精简 ~23%**（约 1290 → 990 字符）：`read_url` 主描述删冗余引导（引擎/缓存机制细节移出），links/batch/site 同步压缩——固定开销每次调用都在，这是最大单项
- **实体解码扩展 6 → 45 个命名实体**：`&mdash;` `&hellip;` `&ensp;` `&ldquo;` `&copy;` `&deg;` `&times;` 等不再残留——残留实体既浪费 token 又显示为乱码
- **SPA 安装提示精简**、batch render 文案中文化（`(no readable content)` → `(无可读内容)`）

### 修复（18 站实测发现）

- **SPA 渲染 `networkidle` 30s 超时**（qq-news 持续轮询永不空闲 → 渲染失败）——改为 `domcontentloaded` + DOM 稳定轮询（内容停止增长即收，上限 10s）；18 站全量测试 **1m51s → 54s**，qq-news EMPTY → OK

### 测试 / 验证

- test.mjs 27 → **29 断言**（+实体解码 7 项、+description 预算与静态性守卫）
- **multi-site.mjs 入库（18 站可复跑）**：12 OK / 3 预期边界（知乎·微博登录墙、example.com 简单页）/ 3 网络·反爬边界（wikipedia 地域 403、w3c 对 Chrome UA 403、github TLS 指纹超时——均 curl 对照定性，非插件 bug）；offset 续读、batch 失败隔离、site 爬取 5/5 通过

## [0.4.0] - 2026-08-16

### 新增（Roadmap 收官）

- **`read_url_site`** — 整站递归爬取（BFS）：从入口 URL 发现同域名页面，返回紧凑站点地图
  - 只爬同域名；登录/API/静态资源路径自动跳过（`isNoiseUrl`）；URL 去重（去 fragment）
  - `maxPages`（2–50，默认 15）/ `maxDepth`（1–5，默认 2）双重上限防 token 爆炸；**batch 轮次不超发页数预算**
  - `includeContent` 附每页摘要（默认关，结构优先省 token）；输出缩进树 `[深度] 标题 (字符数) URL`
  - 并发 2 对目标站友好；单页失败 `[失败]` 隔离不中断
  - **不做 SPA 渲染**（批量轻量抓取优先速度，SPA 单读用 `read_url`）

### 修复

- `sameHost` 对裸 hostname 误判（`new URL(hostname)` 抛错 → 所有链接被当站外）——改为 `new URL(url).hostname === hostname`

### 测试

- test.mjs 23 → **27 断言**（站点爬取：范围/去重/噪音跳过/深度/maxPages 上限/失败隔离/includeContent/render）；真实站点验证：阮一峰博客 8/8 页树状输出

## [0.3.4] - 2026-08-16

### 省 token 特调（核心原则复审）+ 修复

- **状态提示精简**：截断/续读/渲染/空内容提示全部收敛为一行短文本（`chars 6000/12000 — 截断，offset 续读`），删掉每次截断都重复输出的长英文引导语（每调用省 ~20 token，批量场景累积更多）；`spaHint` 安装指引同步精简；
- **失败结果缓存（30s）**：坏 URL 不再触发重复 fetch 循环——第一次失败即入缓存，重复请求直接返回缓存错误（省网络 + 省模型等待 + 防重试风暴）；
- **offset 越界保护**：`offset >= 全文长度` 时返回空而非重复开头（防模型续读错位）；
- **`includeLinks` 严格布尔判断**：与 batch 对齐（`=== true`），字符串 `"false"` 不再被当真值；cacheKey 同步严格化；
- 测试 21 → **23 断言**（offset 越界、错误缓存）；README 中英「省 token 设计」章节更新为 7 点（含双层缓存、批量共用缓存）。

## [0.3.3] - 2026-08-16

### 新增

- **`read_url_batch`** — 批量读多个 URL（1–10 个）：并行（并发 4 防限流）、逐页复用 `read_url` 全部能力（编码识别/正文净化/SPA 渲染/会话缓存），合并成紧凑报告。**单页失败隔离**（`[失败]` + 原因），不影响其他页；每页带标题/字符数/cached 标记。

### 测试

- test.mjs 18 → **21 断言**（批量并行+错误隔离、缓存复用、URL 数上限 10）；
- 真实站点批量验证：example.com + 腾讯（成功）+ 百度 404（失败隔离）输出正确；
- test.mjs 内两处 fire-and-forget async 断言改为顶层 await（保证断言执行、退出码可信）。

## [0.3.2] - 2026-08-16

### 修复（playwright 就绪后的真实 SPA 验证发现的 bug）

- **SPA 渲染等待不足**：`renderPage` 用 `networkidle` 后立即取 DOM，但 JS 异步渲染（setTimeout/fetch 回调）常在其后完成——拿到的是渲染前占位内容。现在 networkidle 后额外等待 `SETTLE_MS=1000ms` 让 SPA 完成绘制；
- **`read_url_links` 崩溃**：SPA 兜底分支 `const links` 被重新赋值导致 `TypeError: Assignment to constant variable`（v0.3.1 引入）。改为 `let`；
- **缓存键不含 `includeLinks`**：先读（无链接）再读（带链接）会命中旧缓存返回空链接。缓存键加入 links 变体；
- **相对链接被丢弃**：`extractLinks` 只匹配 `https?://` 绝对链接，页面内相对路径（`/page2`、`../x`）全部丢失——套娃入口不完整。现支持 base URL resolve 成绝对链接。

### 测试

- 新增 **`test-spa.mjs`**：本地起 SPA 服务（骨架 HTML + JS 异步渲染正文和链接），验证渲染触发/JS 正文/渲染后链接提取/工具不崩溃/缓存隔离——**10 断言**（需 playwright，缺失时自动 SKIP）；
- 原有 18 断言回归通过。

## [0.3.1] - 2026-08-16

### 修复（SPA 套娃链路补全）

- `read_url` 的 `includeLinks` 改为**从渲染后的 DOM 提取链接**（之前用静态 HTML，SPA 页面渲染出正文却拿不到链接——"正文→链接→下一页"的套娃浏览在 SPA 上断链）；
- `read_url_links` 增加 **SPA 兜底**：静态提取的链接 <3 条且页面疑似 SPA 时，自动渲染后重新提取（playwright 未装时优雅回退静态结果）；
- 工具描述同步更新（注明 SPA 渲染支持）。

### 测试

- 18 个零依赖断言（新增 read_url_links SPA 降级用例）。

## [0.3.0] - 2026-08-16

### 新增（SPA 页面渲染增强，Roadmap 收官）

- **可选 Playwright 渲染**：在 DSH profile 目录 `npm i playwright && npx playwright install chromium` 后自动启用——检测到正文为空且页面脚本密集（疑似 Vue/React 客户端渲染）时，自动用无头 Chromium 渲染后再提取，返回结果带 `rendered` 标记（模型可知内容来自 JS 执行）；未安装时优雅降级：返回明确安装提示、不报错，核心保持零依赖；
- **SPA 检测启发式**：`<script>` 标签数量 ≥5 且正文提取 <200 字符 → 疑似 SPA（独立 `spa.js` 模块，`looksLikeSpa` 可测）；
- **渲染生命周期合规**：浏览器实例模块级单例复用（多次调用不重复启动），插件卸载时经 `ctx.effect` 关闭；
- 新配置项 `spaRender`（默认 `true`，可关闭）。

### 测试

- 17 个零依赖断言（新增 SPA 检测 / 正常页不误判 / 未装 playwright 优雅降级）；真实链路验证降级提示。

## [0.2.3] - 2026-08-15

### 新增（模型后续处理便捷性特调）

- **`offset` 续读参数**：长文续读从指定字符偏移开始，不再重复返回前文；缓存改为按 url+mode 存全文，续读直接命中缓存切片（实测新浪 0+500 → 500+500，cached 且无重复）；
- **render 消费引导**：截断提示明确"用 offset 或更大 maxChars 续读"；续读时显示 `chars 500+500/12199` 位置信息；
- **空内容归因**：正文为空时提示"可能是登录墙 / JS 渲染 / 空页面"，避免模型对空结果误判。

## [0.2.2] - 2026-08-15

### 修复（12 站真实测试发现）

- **HTML 注释残留**：`<!-- 注释 -->` 只删边界不删内容，注释文本（含广告位配置）混入正文（新浪 `-->` 残留）；
- **HTML 实体未解码**：`&nbsp;` / `&quot;` / `&amp;` / 数字实体按原样输出（新浪 `&nbsp`、CSDN `&quot;` 残留）——新增 `decodeTextEntities`，在标签剥离后解码；
- **多 article 聚合页**：博客园首页每篇文章一个 `<article>`，原先只取第一个（165 字符）——改为聚合所有 article 块（3,560 字符）。

## [0.2.1] - 2026-08-15

### 优化（DeepSeek 成本特调）

- **KV Cache 友好**：工具 schema/description 静态化，不再嵌入配置值——配置变更不影响 prompt 前缀复用，KV 缓存持续命中（DeepSeek 缓存命中 token 约 1/10 价格）；
- **render 元数据精简**：`siteName` 与域名相同时省略；
- **缓存参数可配置**：`cacheTtlMs` / `cacheMax` 加入插件级配置。

## [0.2.0] - 2026-08-15

### 新增

- **`read_url_links` 独立工具**：只返回页面链接清单（标题+URL），不返回正文，适合找来源/摸站点结构；
- **插件级配置**：`timeoutMs` / `maxBytes` / `maxChars` / `maxLinks` / `userAgent` 可通过 profile 的 `cordis.patch.yml` 覆盖；
- **可选正文提取增强**：安装 `@mozilla/readability` + `happy-dom` 后自动启用 Firefox Reader Mode 算法，未安装回退内置启发式（核心保持零依赖）。

## [0.1.1] - 2026-08-15

### 修复

- **隐藏容器噪音（百度首页实测 bug）**：部分站点（如 baidu.com）把整块 CSS 存放在隐藏 `<textarea>` 中、以实体化形式（`&lt;style&gt;`）输出，导致正文混入 25~36 万字符 CSS/JS 噪音。修复：
  - 删除 `<textarea>` / `<style>` / `<script>` / `<template>` / `<noscript>` 隐藏块；
  - 实体化标签还原（`&lt;` → `<`、`&gt;` → `>`）后二次清理；
  - `blockMd` / `inlineMd` 防御性跳过以上标签。
- 修复后百度首页：text 模式 250,545 → 868 字符（-99.65%），markdown 模式 365,753 → 4,744 字符（-98.7%）。

## [0.1.0] - 2026-08-15

首个发布版本。URL 阅读插件：抓取网页并提取干净正文，面向 DSH 深度优化。

### 功能

- `read_url` 工具：URL → 干净正文（text / markdown 两种模式）
- 中文编码自动检测：GBK / GB2312 / UTF-8 / Big5（三级探测 + 乱码回退）
- 容器级正文净化：优先 `<article>` / `role="main"`，剥离导航/页脚/广告
- 省 token：默认 6000 字符 + 段落级智能截断 + 紧凑文本 render
- 会话级缓存（5 分钟 TTL，插件卸载自动清理）
- 可选返回页面链接清单（`includeLinks`，上限 20 条）

### 架构合规（DSH 官方文档）

- 网络访问优先走 `ctx.web` 能力缝，缺失时回退全局 fetch
- 缓存副作用注册于 `ctx.effect`，满足时间可组合性
- 协作式工具调用超时（`timeoutMs` + `exec.signal`），不暴露给模型
- 零运行时依赖（Node 20+ 内置能力），即装即用

### 测试

- 8 个零依赖单元断言（编码 / 提取 / Markdown / 截断）
- 真实链路验证：example.com（EN）、qq.com（ZH 截断）、ctx.web seam 路径、缓存命中
