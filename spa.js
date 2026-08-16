// spa.js — optional SPA rendering enhancement for dsh-read-url
// Zero-dependency by default; activates only when `playwright` is installed
// in the DSH profile directory (npm i playwright && npx playwright install chromium).
// When absent, reads fall back to static extraction with a clear hint.

let browserPromise = null

// After the network goes idle, async JS (timers, deferred rendering, fetch
// callbacks) may still be pending. networkidle alone does NOT guarantee the
// DOM is populated — wait a beat so the SPA actually paints its content.
const SETTLE_MS = 1000

// Heuristic: a page whose HTML carries many <script> tags is likely a
// client-rendered SPA (Vue/React) whose body lives only after JS execution.
export function looksLikeSpa(html) {
  if (!html) return false
  const scripts = (html.match(/<script[\s>]/gi) || []).length
  return scripts >= 5
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
    return {
      error:
        'SPA rendering requires playwright — run `npm i playwright && npx playwright install chromium` in the DSH profile directory to enable it',
    }
  }
  let page
  try {
    page = await browser.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    // networkidle only means no in-flight requests; client-rendered content
    // (setTimeout chains, fetch().then(render)) often lands just after it.
    await page.waitForTimeout(SETTLE_MS)
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
