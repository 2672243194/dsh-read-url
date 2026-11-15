import assert from 'node:assert/strict'

export async function runTruncationMaintenanceTests(m) {
  let passed = 0
  const ok = async (name, run) => {
    await run()
    passed++
    console.log(`  ok - ${name}`)
  }

  await ok('a short opening paragraph cannot hide the following oversized body', () => {
    const text = '閉じる\n\n' + '正文'.repeat(1000)
    const result = m.smartTruncate(text, 800)
    assert.equal(result.text, text.slice(0, 800))
    assert.equal(result.charsReturned, 800)
    assert.equal(result.charsTotal, text.length)
    assert.equal(result.truncated, true)
  })

  await ok('an early sentence cannot waste the rest of the output budget', () => {
    const text = 'Hi. ' + 'x'.repeat(1000)
    assert.equal(m.smartTruncate(text, 800).text, text.slice(0, 800))
  })

  await ok('sentence alignment still works after a rejected short paragraph', () => {
    const text = '閉じる\n\n' + 'Complete sentence. '.repeat(100)
    const result = m.smartTruncate(text, 800)
    assert.ok(result.charsReturned >= 400 && result.charsReturned <= 800)
    assert.ok(result.text.endsWith('Complete sentence.'))
    assert.equal(result.text, text.slice(0, result.charsReturned))
  })

  await ok('useful paragraph boundaries take priority over later sentence stops', () => {
    const text = 'a'.repeat(600) + '\n\n' + 'Complete sentence. '.repeat(100)
    assert.equal(m.smartTruncate(text, 800).text, 'a'.repeat(600))
  })

  await ok('rejected paragraph separators cannot masquerade as sentence stops', () => {
    const text = 'abc\n\n' + 'x'.repeat(100)
    assert.equal(m.smartTruncate(text, 10).text, text.slice(0, 10))
    assert.equal(m.smartTruncate('aaa\nbbb\nccc', 8).text, 'aaa\nbbb\n')
  })

  await ok('short paragraph continuation preserves every source character', () => {
    const text = '閉じる\n\n' + '本文'.repeat(1000) + '\n\n' + '末尾'.repeat(200)
    let offset = 0, combined = '', pages = 0
    while (offset < text.length) {
      const result = m.smartTruncate(text, 800, offset)
      assert.ok(result.charsReturned > 0)
      assert.equal(result.text, text.slice(result.charsStart, result.charsStart + result.charsReturned))
      assert.ok(/^\n*$/.test(text.slice(offset, result.charsStart)))
      combined += text.slice(offset, result.charsStart) + result.text
      offset = result.charsStart + result.charsReturned
      assert.ok(++pages < 10)
      if (!result.truncated) break
    }
    assert.equal(combined, text)
    assert.equal(offset, text.length)
  })

  await ok('filled output windows still preserve emoji at the hard boundary', () => {
    const text = '短\n\n' + 'a'.repeat(796) + '😀tail'
    const first = m.smartTruncate(text, 800)
    const second = m.smartTruncate(text, 800, first.charsStart + first.charsReturned)
    assert.equal(first.charsReturned, 799)
    assert.equal(second.text, '😀tail')
    assert.equal(first.text + second.text, text)
  })

  await ok('raw HTML in the current window retains the earlier clean boundary', () => {
    const raw = '<img data-label="' + 'x'.repeat(2000) + '">Tail'
    assert.equal(m.smartTruncate('Header\n\n' + raw, 800).text, 'Header')
    assert.equal(m.smartTruncate('Hi. ' + raw, 800).text, 'Hi.')
    const later = 'Header\n\n' + 'x'.repeat(1000) + raw
    assert.equal(m.smartTruncate(later, 800).text, later.slice(0, 800))
  })

  await ok('literal HTML examples survive aligned continuation without filtering', () => {
    const text = 'Overview\n\n<div>Literal *code* ' + 'text '.repeat(100) + '</div>\n\nFinal paragraph.'
    assert.equal(m.smartTruncate(text, 80).text, 'Overview')
    let offset = 0, combined = '', pages = 0
    while (offset < text.length) {
      const result = m.smartTruncate(text, 80, offset)
      assert.ok(result.charsReturned > 0)
      assert.equal(result.text, text.slice(result.charsStart, result.charsStart + result.charsReturned))
      assert.ok(/^\n*$/.test(text.slice(offset, result.charsStart)))
      combined += text.slice(offset, result.charsStart) + result.text
      offset = result.charsStart + result.charsReturned
      assert.ok(++pages < 20)
      if (!result.truncated) break
    }
    assert.equal(combined, text)
  })

  await ok('read_url output and rendering expose body content after a tiny heading', async () => {
    const tools = {}
    const text = '閉じる\n\n' + '实际正文。'.repeat(200)
    let fetched = 0
    m.apply({
      tools: { register: tool => { tools[tool.name] = tool } }, effect: () => {},
      get: () => ({ fetch: async ({ url }) => {
        fetched++
        return { url, statusCode: 200, body: { kind: 'text', content: text } }
      } }),
    }, { spaRender: false, paginate: false })
    const args = { url: `https://truncate-fixture.invalid/${Date.now()}`, maxChars: 800 }
    const first = await tools.read_url.execute(args)
    assert.equal(first.text, text.slice(0, 800))
    assert.ok(tools.read_url.output.render(args, first)[0].text.includes('实际正文。'))
    const second = await tools.read_url.execute({ ...args, offset: first.charsStart + first.charsReturned })
    assert.equal(first.text + second.text, text)
    assert.equal(fetched, 1)
  })

  return passed
}
