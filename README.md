# dsh-read-url

DeepSeek Harness 的 URL 阅读插件：抓取任意网页，**自动识别编码（GBK/GB2312/UTF-8/Big5）**，提取干净正文，输出**省 token 的紧凑文本或结构化 Markdown**。

零依赖（Node 20+ 内置能力），免 API key，免服务端，装完即用。

## 为什么做它

DSH 的 Agent 能搜索（返回链接和片段），但缺"把 URL 读成干净正文"这一步。官方 `tool-web` 的 `web_fetch` 是**整页 turndown 转换**（导航/广告/侧栏全保留），默认上限 20 万字符——token 黑洞。本插件只返回模型真正需要的：**净化后的正文 + 必要元数据**，并默认截断。

### 同类插件对比（2026-08-15 实测源码/文档）

| 能力 | 官方 `tool-web` web_fetch | dsh-webfetch | dsh-scrape-webpage | **dsh-read-url** |
|---|---|---|---|---|
| 正文净化（容器级提取） | ❌ 整页渲染 | ⚠️ 标签级去噪，nav/footer 仍混入 | ⚠️ 自研，含噪音 | ✅ article/main 容器 + 噪音剥离 |
| 默认输出上限 | 200000 字符 | 50000 字符 | 30000 字符 | **6000 字符 + 段落级截断** |
| 中文 GBK/GB2312 | 视 provider | ⚠️ 未归一化，GB2312 易乱码 | ❌ 未处理 | ✅ 归一化 + 乱码回退 |
| 会话级缓存 | ❌ | ❌ | ❌ | ✅ 5 分钟 TTL |
| 走 `ctx.web` seam | ✅ 官方本体 | ❌ 全局 fetch | ❌ | ✅ 优先 seam，缺失回退 |
| `ctx.effect` 卸载清理 | ✅ | ❌ | ❌ | ✅ |
| 协作式超时（不暴露给模型） | ✅ | ⚠️ 自管 | ⚠️ 自管 | ✅ `timeoutMs` + `exec.signal` |
| 模型视角输出 | 整页 Markdown | 紧凑文本 | 15 字段 JSON | **紧凑文本（无需解析 JSON）** |
| 依赖 | 官方 | TS 需构建 | 零依赖 | 零依赖（JS ESM 即装即用） |

## 遵循 DSH 架构理念

按官方文档实现（`docs/capability-seams.md`、`docs/cordis-primer.md`、`docs/tool-execution-pipeline.md`）：

1. **网络访问走 `ctx.web` 能力缝**——所有 web 访问优先通过 `ctx.web.fetch()`（seam 内解析 provider，与官方 `tool-web` 一致），seam 缺失时回退全局 fetch。网络层可替换，不绑定任何具体 provider；
2. **可逆副作用**——会话缓存注册在 `ctx.effect` 下，插件卸载即自动清理（时间可组合性）；
3. **协作式工具调用超时**——`ToolDefinition.timeoutMs` 声明预算，`execute(args, exec)` 把 `exec.signal` 转发给 fetch，超时策略由管线强制执行，不把超时暴露给模型；
4. **模型视角精简**——render 输出紧凑文本（`title:` 头部 + 正文），模型直接消费，无需解析 JSON；默认参数最省 token，结构化能力按需开启。

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
```

### 工具

**`read_url(url, maxChars?, offset?, mode?, includeLinks?)`** — 抓取并提取干净正文

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | http(s) URL |
| `maxChars` | number | 6000 | 返回正文最大字符数（500–20000） |
| `offset` | number | 0 | 从该字符偏移续读（长文续段，命中缓存不重复前文） |
| `mode` | string | `text` | `text` = 纯文本（最省 token）；`markdown` = 结构化 |
| `includeLinks` | boolean | `false` | 额外返回页面内最多 20 条链接（标题+URL） |

**`read_url_links(url, limit?)`** — 只列出页面链接清单，不返回正文（更轻，适合找来源/摸站点结构）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | http(s) URL |
| `limit` | number | 20 | 最多返回链接数（1–50） |

### 配置（可选）

插件级配置通过 profile 的 `cordis.patch.yml` 覆盖（默认值见插件自带 `cordis.patch.yml`）：

```yaml
- id: dsh-read-url
  config:
    timeoutMs: 15000      # 单请求超时
    maxBytes: 3145728     # 响应体上限（字节）
    maxChars: 6000        # 默认正文截断
    maxLinks: 20          # read_url_links 默认条数
    userAgent: '...'      # 请求 UA
```

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
  "text": "……",
  "links": []          // 仅 includeLinks=true 时
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
2. **段落级智能截断 + offset 续读**——默认 6000 字符（约 3000 token），在段落边界截断保证语义完整，输出行注明 `chars 6000/12990` 并引导用 `offset` 续读；续读从指定偏移开始、命中缓存切片，**不重复返回已读前文**（实测 0+500 → 500+500，无重复）；
3. **text 模式优先**——Markdown 结构按需开启；
4. **紧凑文本 render**——模型直接看到 `title:` 头部 + 正文，无需解析 JSON；`siteName` 与域名相同时省略，元数据零冗余；
5. **会话级缓存**——同一 URL 5 分钟内重复读取直接命中，省网络也省模型重试；
6. **KV Cache 友好（DeepSeek 成本特调）**——工具 schema/description 保持**静态文本**（不嵌入配置值），配置变更不会使可复用的 prompt 前缀失效，KV 缓存持续命中。DeepSeek 缓存命中 token 价格约为未命中的 1/10，前缀越稳定越省钱（官方 `tool-web` 文档同款分析）。

## 技术说明

- **编码**：HTTP `Content-Type` charset → HTML meta → BOM 三级探测，内置 `TextDecoder` 转码（Node 20+ full-icu），GB2312 归一为 GBK，检测到乱码自动回退 UTF-8；
- **正文提取**：优先 `<article>` / `role="main"`，剥离 `nav/footer/header/aside/form/iframe` 及广告类容器，启发式回归到 `<body>`；
- **Markdown**：自研轻量标签状态机（标题/段落/列表/引用/代码块/表格/行内加粗斜体链接），零依赖；
- **安全**：仅 http/https；不执行页面脚本；响应超 3MB 拒绝；15s 超时；错误信息结构化返回（HTTP 状态/超时/类型不支持）；
- **可选增强（Firefox Reader Mode 算法）**：在 DSH profile 目录执行 `npm i @mozilla/readability happy-dom` 后自动启用，正文提取升级为 `@mozilla/readability`（MPL-2.0，引用不改写），未安装时回退内置启发式提取器，核心保持零依赖；
- **边界**：登录墙、JS 动态渲染（SPA）页面无法读取——这是同类插件的共同边界。

## Roadmap

- [ ] SPA 页面按需渲染（接入 Playwright，保持可选）
- [ ] 单页多段续读（`offset` 参数）

## 开发

```bash
node test.mjs          # 零依赖自测（转码/提取/Markdown/截断）

# 端到端验证（需已安装 DSH CLI）
npx @deepseek-ai/dsh plugin --profile headless add .        # 在插件目录的上一级执行
npx @deepseek-ai/dsh --profile headless "用 read_url 读取 https://example.com 并输出标题"
```

已通过 DSH v0.1.0-rc.6 真实运行验证：插件加载、`read_url` 注册、模型调用、真实页面返回全部正常。

## License

MIT
