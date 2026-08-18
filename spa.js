// spa.js — optional SPA rendering enhancement for dsh-read-url
// Zero-dependency by default; activates only when `playwright` is installed
// in the DSH profile directory (npm i playwright && npx playwright install chromium).
// When absent, reads fall back to static extraction with a clear hint.

let browserPromise = null

// Heuristic: a page whose HTML carries many <script> tags is likely a
// client-rendered SPA (Vue/React) whose body lives only after JS execution.
// Counts with exec() instead of match() to avoid materializing a large array
// for multi-MB HTML (match() builds an array entry per script tag).
export function looksLikeSpa(html) {
  if (!html) return false
  const re = /<script[\s>]/gi
  let n = 0
  let m
  while ((m = re.exec(html)) && n < 5) n++
  return n >= 5
}

async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = await import('playwright')
    browserPromise = chromium.launch({ headless: true })
  }
  return browserPromise
}

// Render a URL with headless Chromium and return the post-JS DOM HTML.
export async function renderPage(url, externalSignal) {
  if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
  let browser
  try {
    browser = await getBrowser()
  } catch {
    return { error: 'SPA 渲染需 playwright（npm i playwright && npx playwright install chromium）' }
  }
  let page
  try {
    page = await browser.newPage()
    // 'domcontentloaded' instead of 'networkidle': heartbeat-polling sites
    // (qq-news, juejin) never go idle and would time out at 30s. Instead wait
    // for the DOM to stabilize (content stops growing) up to 10s — SPA paint
    // usually lands within a couple of seconds of DOM-ready.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const t0 = Date.now()
    let prevLen = -1
    for (;;) {
      await page.waitForTimeout(500)
      const len = await page
        .evaluate(() => (document.body ? document.body.innerHTML.length : 0))
        .catch(() => -1)
      if (Date.now() - t0 > 10000) break
      // stop once two consecutive reads agree — including empty bodies (a
      // blank page should not burn the full 10s poll)
      if (len === prevLen && prevLen >= 0) break
      prevLen = len
    }
    const html = await page.content()
    const finalUrl = page.url()
    return { html, finalUrl }
  } catch (e) {
    return { error: `Render failed: ${e.message}` }
  } finally {
    if (page) await page.close().catch(() => {})
  }
}

// Called on plugin unload (temporal composability): release the browser.
export async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise
    await b.close().catch(() => {})
    browserPromise = null
  }
}
