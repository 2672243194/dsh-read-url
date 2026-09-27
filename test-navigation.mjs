import assert from 'node:assert/strict'

export async function runNavigationTests(m) {
  let passed = 0
  const base = `https://navigation-fixture.invalid/${Date.now()}/page`
  const origin = new URL(base).origin
  const check = async (name, run) => {
    await run()
    passed++
    console.log(`  ok - ${name}`)
  }
  console.log('HTML navigation attributes')

  await check('next-page anchors accept real spaced and unquoted href attributes', () => {
    for (const attrs of ['href = "/next"', 'href=/next', 'data-href="/wrong" href="/next"', 'href="/next" data-href="/wrong"']) {
      assert.equal(m.findNextLink(`<a ${attrs}>Next</a>`, base), `${origin}/next`)
    }
  })
  await check('compound attributes and attribute values cannot create next-page links', () => {
    for (const html of ['<a data-href="/wrong">Next</a>', '<a data-note="href=\'/wrong\'">Next</a>', '<link data-rel="next" href="/wrong">', '<a data-rel="next" href="/wrong">Read</a>', '<link rel="next" data-href="/wrong">']) {
      assert.equal(m.findNextLink(html, base), null)
    }
  })
  await check('next relation matches a whole token and takes precedence over anchor text', () => {
    const html = '<a href="/text">Next</a><link REL = "alternate&#32;NEXT" HREF = /relation>'
    assert.equal(m.findNextLink(html, base), `${origin}/relation`)
    assert.equal(m.findNextLink('<link rel="next-page" href="/wrong"><a rel=next href=/valid>Continue</a>', base), `${origin}/valid`)
  })
  await check('relative navigation honors the first real base href including an empty value', () => {
    const tail = '<a href="child">Next</a>'
    assert.equal(m.findNextLink('<head><base data-href="/wrong/"><base target=_blank><base href = /docs/></head>' + tail, base), `${origin}/docs/child`)
    assert.equal(m.findNextLink('<head><base href=""><base href="/wrong/"></head>' + tail, base), new URL('child', base).href)
    assert.equal(m.findNextLink('<head><base href="javascript:bad"><base href="/wrong/"></head>' + tail, base), new URL('child', base).href)
  })
  await check('refresh metadata accepts attribute spacing and preserves legacy name routing', () => {
    for (const html of ['<meta http-equiv = refresh content = "0;url=/next">', '<META CONTENT="0;url=/next" HTTP-EQUIV=REFRESH>', '<meta name = refresh content="0;url=/next">']) {
      assert.equal(m.metaRefreshTarget(html, base), `${origin}/next`)
    }
    assert.equal(m.metaRefreshTarget('<meta http-equiv = refresh content="1;url=/next">', base), null)
  })
  await check('compound refresh attributes and quoted lookalikes cannot cause navigation', () => {
    for (const html of ['<meta data-http-equiv="refresh" content="0;url=/wrong">', '<meta data-name="refresh" content="0;url=/wrong">', '<meta http-equiv="refresh" data-content="0;url=/wrong">', '<meta data-note="http-equiv=\'refresh\'" content="0;url=/wrong">']) {
      assert.equal(m.metaRefreshTarget(html, base), null)
    }
  })
  await check('refresh URLs preserve query entities, literal semicolons and single decoding', () => {
    const read = content => m.metaRefreshTarget(`<meta http-equiv="refresh" content="${content}">`, base)
    assert.equal(read('0;url=/next;a=1?x=2&amp;y=3;z=4'), `${origin}/next;a=1?x=2&y=3;z=4`)
    assert.equal(read('0;url=/next?raw=&copy=2&amp;once=&amp;amp;'), `${origin}/next?raw=&copy=2&once=&amp;`)
    assert.equal(read('0;url=&quot;/next?a=1&amp;b=2&quot;'), `${origin}/next?a=1&b=2`)
  })
  await check('navigation keeps the bounded opening-tag policy', () => {
    const long = 'x'.repeat(1100)
    assert.equal(m.findNextLink(`<a data-note="${long}" href="/wrong">Next</a>`, base), null)
    assert.equal(m.findNextLink(`<link data-note="${long}" rel="next" href="/wrong">`, base), null)
    assert.equal(m.metaRefreshTarget(`<meta data-note="${long}" http-equiv="refresh" content="0;url=/wrong">`, base), null)
    assert.equal(m.findNextLink(`<head><base data-note="${long}" href="/wrong/"></head><a href="child">Next</a>`, base), new URL('child', base).href)
  })
  await check('quoted greater-than signs remain part of navigation attribute values', () => {
    for (const [quote, greater] of [['"', '>'], ["'", '>'], ['"', '&gt;']]) {
      const href = `${quote}/search?q=1${greater}0${quote}`
      assert.equal(m.findNextLink(`<a href=${href}>Next</a>`, base), `${origin}/search?q=1%3E0`)
      assert.equal(m.findNextLink(`<link rel=next href=${href}>`, base), `${origin}/search?q=1%3E0`)
      assert.equal(m.findNextLink(`<head><base href=${href}></head><a href="#part">Next</a>`, base), `${origin}/search?q=1%3E0#part`)
      assert.equal(m.metaRefreshTarget(`<meta http-equiv=refresh content=${quote}0;url=/search?q=1${greater}0${quote}>`, base), `${origin}/search?q=1%3E0`)
    }
  })
  await check('quoted greater-than signs cannot expose fake navigation attributes', () => {
    assert.equal(m.findNextLink('<a data-note="> href=\'/wrong\'" href="/next">Next</a>', base), `${origin}/next`)
    assert.equal(m.findNextLink('<link data-note="> rel=\'next\'" href="/wrong">', base), null)
    assert.equal(m.metaRefreshTarget('<meta data-note="> http-equiv=\'refresh\'" content="0;url=/wrong">', base), null)
  })
  await check('empty unclosed anchors do not swallow subsequent navigation', () => {
    for (const href of ['""', "''", '" "']) {
      assert.equal(m.findNextLink(`<a href=${href}><a href="/next">Next</a>`, base), `${origin}/next`)
    }
  })

  const tools = {}
  const calls = []
  const article = (title, links = '', head = '') => `<html><head><title>${title}</title>${head}</head><body><article><p>${title} ${'Visible document content. '.repeat(16)}</p></article>${links}</body></html>`
  const navigation = '<a data-href="/phantom">Ghost</a><a href = "one">First</a><a href=two>Second</a><a href="three" data-href="/phantom">Third</a><a href="four?a=1>0">Fourth</a>'
  const web = { fetch: async ({ url }) => {
    calls.push(url)
    const current = new URL(url)
    let content
    if (current.pathname.endsWith('/links')) content = article('LINKS', navigation, '<base href = /docs/>')
    else if (current.pathname.endsWith('/pagination')) content = article('FIRST_PAGE', '<a data-href="/phantom">Next</a>', '<link rel="alternate next" href = /second-page>')
    else if (current.pathname === '/second-page') content = article('SECOND_PAGE')
    else if (current.pathname.endsWith('/site')) content = article('SITE_ROOT', navigation, '<meta data-http-equiv="refresh" content="0;url=/phantom"><base href = /docs/>')
    else if (current.pathname.endsWith('/refresh')) content = article('SHELL', '', '<meta data-http-equiv="refresh" content="0;url=/phantom"><meta http-equiv = refresh content="0;url=/refresh-target;a=1?x=2&amp;y=3;z=4">')
    else content = article(current.pathname === '/refresh-target;a=1' ? 'REFRESH_TARGET' : 'CHILD')
    return { statusCode: 200, url, body: { kind: 'html', content } }
  } }
  m.apply({ tools: { register: tool => { tools[tool.name] = tool } }, effect: () => {}, get: key => key === 'web' ? web : undefined }, { spaRender: false, cacheTtlMs: 0 })

  await check('link tools return real attributes resolved against the declared base', async () => {
    const url = `${base}/links`
    const links = await tools.read_url_links.execute({ url })
    const page = await tools.read_url.execute({ url, includeLinks: true })
    const expected = ['/docs/one', '/docs/two', '/docs/three', '/docs/four?a=1%3E0'].map(path => origin + path)
    assert.deepEqual(links.links.map(link => link.url), expected)
    assert.deepEqual(page.links.map(link => link.url), expected)
  })
  await check('read_url fetches the actual next page without following data-href', async () => {
    calls.length = 0
    const url = `${base}/pagination`
    const result = await tools.read_url.execute({ url, maxChars: 20000 })
    assert.equal(result.paginated, 2)
    assert.ok(result.text.includes('FIRST_PAGE') && result.text.includes('SECOND_PAGE'))
    assert.deepEqual(calls, [url, `${origin}/second-page`])
  })
  await check('site crawling follows real links and ignores compound refresh attributes', async () => {
    calls.length = 0
    const url = `${base}/site`
    const result = await tools.read_url_site.execute({ url, maxPages: 5, maxDepth: 1 })
    assert.equal(result.succeeded, 5)
    assert.equal(result.failed, 0)
    assert.deepEqual(calls, [url, `${origin}/docs/one`, `${origin}/docs/two`, `${origin}/docs/three`, `${origin}/docs/four?a=1%3E0`])
  })
  await check('read, links and site tools follow the exact decoded refresh URL', async () => {
    const target = `${origin}/refresh-target;a=1?x=2&y=3;z=4`
    for (const [i, name] of ['read_url', 'read_url_links', 'read_url_site'].entries()) {
      calls.length = 0
      const url = `${base}/${i}/refresh`
      const result = await tools[name].execute({ url, maxPages: 2, maxDepth: 1 })
      assert.ok(!result.error)
      assert.deepEqual(calls, [url, target])
      if (name === 'read_url_site') assert.equal(result.pages[0].url, target)
      else assert.equal(result.url, target)
    }
  })
  return passed
}
