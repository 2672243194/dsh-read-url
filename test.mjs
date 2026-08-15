// dsh-read-url self-test — zero-dependency, run: node test.mjs
import assert from 'node:assert/strict'
import { decodeBuffer, extract, smartTruncate, blockMd, inlineMd } from './index.js'

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('decodeBuffer / GBK charset')
ok('gbk meta charset decodes correctly', () => {
  const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好 in GBK
  const buf = Buffer.concat([
    Buffer.from('<html><head><meta charset="gbk"></head><body><p>', 'utf8'),
    gbkHello,
    Buffer.from('</p></body></html>', 'utf8'),
  ])
  const { text, charset } = decodeBuffer(buf, '')
  assert.equal(charset, 'gbk')
  assert.ok(text.includes('你好'), `expected 你好 in text, got: ${text.slice(0, 80)}`)
})

ok('content-type charset wins', () => {
  const buf = Buffer.from('<html><body><p>hello</p></body></html>')
  const { charset } = decodeBuffer(buf, 'text/html; charset=utf-8')
  assert.equal(charset, 'utf-8')
})

console.log('extract / main content')
const html = `
<html lang="zh-CN"><head>
<title>示例文章 - 测试站</title>
<meta property="og:site_name" content="测试站">
</head>
<body>
<nav><a href="/">首页</a><a href="/about">关于</a></nav>
<header class="site-header"><h1>站点头部</h1></header>
<article>
<h1>文章标题</h1>
<p>第一段内容，讲了一些事情。</p>
<p>第二段内容，继续展开，<a href="https://example.com/ref">参考链接</a>在这里。</p>
<ul><li>要点一</li><li>要点二</li></ul>
<blockquote>引用一句话</blockquote>
<pre><code>const x = 1</code></pre>
</article>
<footer>页脚噪音</footer>
</body></html>`

ok('text mode returns title and clean body', () => {
  const r = extract(html, 'text')
  assert.equal(r.title, '示例文章 - 测试站')
  assert.equal(r.siteName, '测试站')
  assert.equal(r.lang, 'zh-CN')
  assert.ok(r.text.includes('第一段内容'))
  assert.ok(!r.text.includes('站点头部'), 'header noise should be removed')
  assert.ok(!r.text.includes('页脚噪音'), 'footer noise should be removed')
  assert.ok(!r.text.includes('首页'), 'nav links should be removed')
})

ok('markdown mode preserves structure', () => {
  const r = extract(html, 'markdown')
  assert.ok(r.text.includes('# 文章标题'), `expected h1 heading, got: ${r.text.slice(0, 200)}`)
  assert.ok(r.text.includes('[参考链接](https://example.com/ref)'))
  assert.ok(r.text.includes('- 要点一'))
  assert.ok(r.text.includes('> 引用一句话'))
  assert.ok(r.text.includes('```'))
})

console.log('smartTruncate / paragraph alignment')
ok('truncates at paragraph boundary', () => {
  const text = 'aaaa\n\nbbbb\n\ncccc\ndddd'
  const r = smartTruncate(text, 10)
  assert.equal(r.text, 'aaaa\n\nbbbb')
  assert.equal(r.truncated, true)
  assert.equal(r.charsTotal, 21)
})

ok('no truncation when under limit', () => {
  const r = smartTruncate('short', 100)
  assert.equal(r.truncated, false)
  assert.equal(r.text, 'short')
})

ok('hard cut when single paragraph exceeds limit', () => {
  const r = smartTruncate('abcdefghij', 5)
  assert.equal(r.text, 'abcde')
  assert.equal(r.truncated, true)
})

console.log('inline markdown')
ok('escapes special chars in plain text', () => {
  assert.equal(inlineMd('a *b* and `c`'), 'a \\*b\\* and \\`c\\`')
})

console.log(`\n${passed} assertions passed`)
