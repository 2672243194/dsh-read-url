# Changelog

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
