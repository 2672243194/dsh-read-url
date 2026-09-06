import assert from 'node:assert/strict'

export async function runMarkdownTests(m) {
  let passed = 0
  const ok = (name, fn) => {
    fn()
    passed++
    console.log(`  ok - ${name}`)
  }

  ok('offset inside a short paragraph preserves the requested source position', () => {
    const text = 'abcdef\n\nghijkl\n\nmnopqr'
    const result = m.smartTruncate(text, 10, 3)
    assert.equal(result.text, 'def')
    assert.equal(result.charsStart, 3)
    assert.equal(result.text, text.slice(result.charsStart, result.charsStart + result.charsReturned))
  })

  ok('repeated continuation consumes every paragraph exactly once', () => {
    const text = 'aaaaaa\n\nbbbbbb\n\ncccccc'
    const pages = []
    let offset = 0
    for (let i = 0; i < 10; i++) {
      const result = m.smartTruncate(text, 6, offset)
      pages.push(result.text)
      assert.equal(result.text, text.slice(result.charsStart, result.charsStart + result.charsReturned))
      assert.ok(result.charsStart >= offset)
      offset = result.charsStart + result.charsReturned
      if (!result.truncated) break
    }
    assert.deepEqual(pages, ['aaaaaa', 'bbbbbb', 'cccccc'])
    assert.equal(offset, text.length)
  })

  ok('continuation accounts for every character in long paragraph separators', () => {
    const text = 'aaaa\n\n\n\nbbbb\n\ncccc'
    for (const offset of [4, 5, 6, 7, 8]) {
      const result = m.smartTruncate(text, 4, offset)
      assert.equal(result.text, 'bbbb')
      assert.equal(result.charsStart, 8)
    }
  })

  ok('sentence continuation preserves the suffix of an oversized paragraph', () => {
    const text = 'First sentence. Second sentence. Third sentence.'
    const first = m.smartTruncate(text, 20)
    const second = m.smartTruncate(text, 20, first.charsStart + first.charsReturned)
    assert.equal(first.text, 'First sentence.')
    assert.equal(second.text, ' Second sentence.')
    assert.equal(second.charsStart, first.text.length)
  })

  ok('zero output budget and separators at the end terminate predictably', () => {
    const empty = m.smartTruncate('abcdef', 0, 3)
    assert.equal(empty.text, '')
    assert.equal(empty.truncated, true)
    assert.equal(empty.charsStart, 3)
    const end = m.smartTruncate('abc\n\n\n', 4, 3)
    assert.equal(end.text, '')
    assert.equal(end.charsStart, 6)
    assert.equal(end.truncated, false)
  })

  ok('short documents retain their original paragraph whitespace', () => {
    const text = 'aaaa\n\n\n\nbbbb'
    const result = m.smartTruncate(text, 100)
    assert.equal(result.text, text)
    assert.equal(result.charsReturned, text.length)
    assert.equal(result.truncated, false)
  })

  ok('hard slicing avoids splitting an emoji when there is room to back off', () => {
    const first = m.smartTruncate('ab😀cd', 3)
    const second = m.smartTruncate('ab😀cd', 3, first.charsReturned)
    assert.equal(first.text, 'ab')
    assert.equal(second.text, '😀c')
  })

  ok('compact JSON preserves prototype-shaped keys at every copied level', () => {
    const value = JSON.parse('{"__proto__":{"a":1},"items":[{"__proto__":"data","constructor":2}],"prototype":3}')
    const output = JSON.parse(m.compactJson(value))
    assert.deepEqual(output, value)
    assert.equal(Object.getPrototypeOf(output), Object.prototype)
    assert.equal(Object.prototype.a, undefined)
  })

  ok('compact JSON still clips strings stored under prototype-shaped keys', () => {
    const value = JSON.parse('{"__proto__":{}}')
    value.__proto__.text = 'x'.repeat(1600)
    const output = JSON.parse(m.compactJson(value))
    assert.equal(output.__proto__.text, 'x'.repeat(1500) + '…[+100 chars]')
  })

  ok('ordinary compact JSON stays byte-identical', () => {
    assert.equal(m.compactJson({ a: [null, false, 1, 'x'], b: {} }), '{"a":[null,false,1,"x"],"b":{}}')
  })

  ok('inline code preserves punctuation, HTML entities and literal backticks', () => {
    assert.equal(m.inlineMd('<code>foo_bar &amp;&amp; [x] &lt; y `z`</code>'), '`` foo_bar && [x] < y `z` ``')
    assert.equal(m.inlineMd('<code>Array&lt;T&gt;</code>'), '`Array<T>`')
  })

  ok('nested inline code preserves multiple spaces without corrupting surrounding text', () => {
    assert.equal(m.inlineMd('<span>Use <strong><code>a  b</code></strong> now</span>'), 'Use **`a  b`** now')
    assert.equal(m.inlineMd('<code> x </code>'), '`  x  `')
  })

  ok('literal prose still escapes Markdown syntax outside code', () => {
    assert.equal(m.inlineMd('a *b* and `c`'), 'a \\*b\\* and \\`c\\`')
    assert.equal(m.inlineMd('<code></code>after'), 'after')
  })

  ok('code fences exceed every literal backtick run in their content', () => {
    const output = m.blockMd('<pre><code class="language-markdown">```js\nx()\n```</code></pre>').trim()
    assert.equal(output, '````markdown\n```js\nx()\n```\n````')
  })

  ok('fenced code retains indentation and language among multiple CSS classes', () => {
    const output = m.blockMd('<pre><code class="source language-js highlight">\n  const x = 1\n    x++\n</code></pre>')
    assert.equal(output, '\n\n```js\n  const x = 1\n    x++\n```')
  })

  ok('fenced code decodes escaped tags while removing highlighting wrappers', () => {
    assert.equal(m.blockMd('<pre><code><span>&lt;div&gt;</span>x &amp; y&lt;/div&gt;</code></pre>').trim(), '```\n<div>x & y</div>\n```')
    assert.equal(m.blockMd('<pre>a<br>b</pre>').trim(), '```\na\nb\n```')
  })

  ok('image and code placeholders remain distinct across nested inline nodes', () => {
    const output = m.blockMd('<p><img alt="first" src="/first.png"><span><code>a  b</code><img alt="second" src="/second.png"></span></p>')
    assert.ok(output.includes('![first](/first.png)'))
    assert.ok(output.includes('![second](/second.png)'))
    assert.ok(output.includes('`a  b`'))
    assert.ok(!output.includes('\u0001'))
  })

  ok('void line breaks survive nested formatting and mixed-case HTML', () => {
    assert.equal(m.inlineMd('name<br>address'), 'name  \naddress')
    assert.equal(m.inlineMd('<SPAN>a<BR class="clear" />b</SPAN>'), 'a  \nb')
    assert.equal(m.blockMd('<div>a<hr>b</div>').trim(), 'a\n\n---\n\nb')
  })

  ok('direct block-level links and emphasis keep their inline semantics', () => {
    assert.equal(m.blockMd('<div><a href="/docs">Docs</a> <strong>Important</strong></div>').trim(), '[Docs](/docs) **Important**')
    assert.equal(m.blockMd('<p><a href="/a(b)">Link</a></p>').trim(), '[Link](/a%28b%29)')
  })

  ok('table separators follow the header and use actual cell counts', () => {
    const output = m.blockMd('<table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td><td>2</td></tr></table>').trim()
    assert.equal(output, '| a\\|b | c |\n| --- | --- |\n| 1 | 2 |')
  })

  ok('table parsing handles uppercase markup and keeps links in cells', () => {
    const output = m.blockMd('<TABLE><TR><TH>A</TH></TR><TR><TD><a href="/a">Link</a></TD></TR></TABLE>').trim()
    assert.equal(output, '| A |\n| --- |\n| [Link](/a) |')
  })

  ok('mixed-case list markup keeps every list item', () => {
    assert.equal(m.blockMd('<UL><LI>First</LI><li><strong>Second</strong></li></UL>').trim(), '- First\n- **Second**')
  })

  ok('table output caps content rows and reports all remaining nonempty rows', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>row${i}</td><td>value</td></tr>`).join('')
    const output = m.blockMd(`<table><tr><th>A</th><th>B</th></tr>${rows}<tr></tr></table>`).trim()
    assert.ok(output.endsWith('…+16 rows'))
    assert.ok(output.includes('| row23 | value |'))
    assert.ok(!output.includes('row24'))
    assert.equal(output.split('\n')[1], '| --- | --- |')
  })

  ok('line breaks inside a table cell do not create extra Markdown rows', () => {
    const output = m.blockMd('<table><tr><th>A</th></tr><tr><td>first<br>second</td></tr></table>').trim()
    assert.equal(output, '| A |\n| --- |\n| first<br>second |')
  })

  ok('unclosed tags cannot swallow trailing prose', () => {
    assert.equal(m.inlineMd('<span><code>unfinished'), 'unfinished')
    assert.equal(m.blockMd('<table><tr><td>unfinished'), 'unfinished')
  })

  ok('table code retains long internal whitespace runs', () => {
    const spaces = ' '.repeat(160000)
    assert.ok(m.blockMd(`<table><tr><td><code>a${spaces}b</code></td></tr></table>`).includes(`a${spaces}b`))
  })

  return passed
}
