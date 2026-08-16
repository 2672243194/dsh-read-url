// test-spa.mjs — real SPA rendering test (requires playwright installed)
// Run: node test-spa.mjs   (skips cleanly with a hint if playwright is missing)
//
// Spins up a local server that serves an SPA-style page: an HTML shell with
// 8 <script> tags whose content is rendered asynchronously by JS (setTimeout).
// Verifies:
//   1. read_url renders the page and returns the JS-generated body
//   2. includeLinks extracts links from the RENDERED DOM (chain entry)
//   3. read_url_links falls back to rendering when static links are empty
//   4. cache key isolates links/no-links variants
import assert from 'node:assert/strict'
import http from 'node:http'
import * as m from './index.js'

const PORT = 18090

const SPA_HTML = `<!DOCTYPE html>
<html><head><title>SPA 测试页</title></head>
<body><div id="app">加载中...</div>
<script src="/app.js"></script>
<script src="/app.js"></script>
<script src="/app.js"></script>
<script src="/app.js"></script>
<script src="/app.js"></script>
<script src="/app.js"></script>
<script src="/app.js"></script>
<script src="/app.js"></script>
</body></html>`

const APP_JS = `
setTimeout(() => {
  const app = document.getElementById('app')
  app.innerHTML =
    '<h1>动态渲染标题</h1>' +
    '<p>这是由 JavaScript 异步加载后渲染的正文内容，静态抓取拿不到这些文字。</p>' +
    '<p>SPA 渲染链路验证。' +
    '<a href="/page2">下一页</a> · ' +
    '<a href="https://example.com/ref">参考链接</a></p>'
}, 300)
`

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/app.js') {
        res.setHeader('content-type', 'application/javascript; charset=utf-8')
        res.end(APP_JS)
      } else {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.end(SPA_HTML)
      }
    })
    server.listen(PORT, () => resolve(server))
  })
}

const results = []
function ok(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name}${extra ? ' | ' + extra : ''}`)
}

const server = await startServer()
const url = `http://127.0.0.1:${PORT}/`

try {
  // 0) playwright availability (renderPage returns { error } when missing)
  const probe = await m.renderPage(url)
  if (probe.error && probe.error.includes('playwright')) {
    console.log('SKIP: playwright not installed — install with `npm i playwright && npx playwright install chromium`')
    server.close()
    process.exit(0)
  }

  // 1) read_url renders JS-generated body
  const r1 = await m.readUrl({ url, maxChars: 800 })
  ok('read_url 触发渲染 (rendered=true)', r1.rendered === true)
  ok('read_url 返回 JS 渲染正文', (r1.text || '').includes('异步加载后渲染'))
  ok('read_url 不含静态占位', !(r1.text || '').includes('加载中'))

  // 2) includeLinks 从渲染后 DOM 提取（套娃入口）
  const r2 = await m.readUrl({ url, maxChars: 800, includeLinks: true })
  const links2 = r2.links || []
  ok('includeLinks 返回链接', links2.length > 0)
  ok('includeLinks 含渲染后的下一页链接', links2.some((l) => l.url.includes('page2')))
  ok('includeLinks 含渲染后的参考链接', links2.some((l) => l.url.includes('example.com')))

  // 3) read_url_links 工具：SPA 兜底
  const tools = []
  m.apply({ tools: { register: (t) => tools.push(t) }, effect: () => {}, get: () => undefined }, {})
  const linksTool = tools.find((t) => t.name === 'read_url_links')
  assert.ok(linksTool, 'read_url_links tool registered')
  const r3raw = await linksTool.execute({ url })
  const r3 = typeof r3raw === 'string' ? JSON.parse(r3raw) : r3raw
  ok('read_url_links 不崩溃且有链接', !r3.error && (r3.links || []).length > 0)
  ok('read_url_links 含渲染后的参考链接', (r3.links || []).some((l) => l.url.includes('example.com')))

  // 4) 缓存键隔离：无链接请求不会污染带链接请求
  const r1b = await m.readUrl({ url, maxChars: 800 })
  const r2b = await m.readUrl({ url, maxChars: 800, includeLinks: true })
  ok('缓存隔离：无links调用不带links字段', !Array.isArray(r1b.links))
  ok('缓存隔离：带links调用仍返回链接', Array.isArray(r2b.links) && r2b.links.length > 0)
} finally {
  server.close()
  await m.closeBrowser().catch(() => {})
}

const passed = results.filter((r) => r.ok).length
console.log(`\n${passed}/${results.length} assertions passed`)
process.exit(passed === results.length ? 0 : 1)
