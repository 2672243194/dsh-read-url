# Changelog

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
