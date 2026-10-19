import assert from 'node:assert/strict'

export async function runProviderTextTests(m) {
  let passed = 0
  const content = '# Literal HTML examples\n\n' +
    '<meta http-equiv="refresh" content="0; url=/sample-hop">\n' +
    '<a href="/sample-link">example link</a>\n' +
    '<script>example()</script>'.repeat(5) + '\n\nEnd of document.'
  const setup = (kind = 'text', truncated = false) => {
    const tools = {}, calls = []
    m.apply({
      tools: { register(t) { tools[t.name] = t } },
      effect() {},
      get: key => key === 'web' ? { fetch: async ({ url }) => {
        calls.push(url)
        return { url, statusCode: 200, truncated, body: { kind, content } }
      } } : undefined,
    }, { spaRender: true, paginate: false })
    return { tools, calls }
  }
  const check = async (name, fn) => { await fn(); passed++; console.log(`  ok - ${name}`) }
  await check('link scanning treats provider text HTML examples as literal content', async () => {
    const { tools, calls } = setup()
    const url = 'https://provider-text-links.invalid/start'
    const result = await tools.read_url_links.execute({ url })
    assert.deepEqual(calls, [url])
    assert.deepEqual(result.links, [])
    assert.equal(result.count, 0)
    assert.match(result.spaHint, /纯文本/)
    assert.match(JSON.stringify(tools.read_url_links.output.render({}, result)), /未扫描 HTML 链接或跳转/)
  })
  await check('site reading preserves provider text without following sample links or redirects', async () => {
    const { tools, calls } = setup()
    const url = 'https://provider-text-site.invalid/start'
    const result = await tools.read_url_site.execute({ url, includeContent: true, maxCharsPerPage: 2000 })
    assert.deepEqual(calls, [url])
    assert.equal(result.succeeded, 1)
    assert.equal(result.pages[0].text, content)
    assert.equal(result.pages[0].chars, content.length)
    assert.equal(result.pages[0].title, '')
    assert.match(result.pages[0].spaHint, /纯文本/)
    assert.ok(tools.read_url_site.output.render({}, result)[0].text.includes(content))
  })
  await check('site text remains opt-in and respects the configured summary budget', async () => {
    const { tools } = setup()
    const url = 'https://provider-text-budget.invalid/start'
    const structure = await tools.read_url_site.execute({ url })
    assert.equal(structure.pages[0].text, undefined)
    assert.ok(!tools.read_url_site.output.render({}, structure)[0].text.includes('example()'))
    const limited = await tools.read_url_site.execute({ url, includeContent: true, maxCharsPerPage: 200 })
    assert.ok(limited.pages[0].text.length <= 200)
    assert.ok(content.startsWith(limited.pages[0].text))
  })
  await check('text provider truncation remains visible in links and site output', async () => {
    const { tools } = setup('text', true)
    for (const name of ['read_url_links', 'read_url_site']) {
      const result = await tools[name].execute({ url: `https://${name}-truncated.invalid` })
      assert.match(tools[name].output.render({}, result)[0].text, /提供方已截断原文/)
    }
  })
  return passed
}
