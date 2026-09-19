// spa.js — optional SPA rendering enhancement for dsh-read-url
// Zero-dependency by default; activates only when `playwright` is installed
// in the DSH profile directory (npm i playwright && npx playwright install chromium).
// When absent, reads fall back to static extraction with a clear hint.

let browserPromise = null
const closingBrowsers = new Set()

function renderError(error) {
  return `Render failed: ${String(error?.message || error).split('\n', 1)[0].slice(0, 500)}`
}

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

// High-specificity markers of a bot-challenge interstitial (Cloudflare and
// friends). Measured: ruanyifeng.com served "Just a moment..." whose DOM
// stabilizes while the challenge sits in "Verification successful. Waiting
// for ... to respond" — the poll loop returned that transitional page and
// the caller mistook it for an improvement over static extraction.
const CHALLENGE_RE = /just a moment|performing security verification|verifying (you are|your) human|cf-chl|cf_chl|cdn-cgi\/challenge-platform|attention required!\s*[|·]?\s*cloudflare|enable javascript and cookies to continue/i

export function looksLikeChallenge(html) {
  return typeof html === 'string' && CHALLENGE_RE.test(html)
}

async function getBrowser() {
  if (!browserPromise) {
    // A failed launch (playwright later installed / chromium download finished)
    // must not stay cached as a rejected promise — reset so the next call retries.
    const pending = import('playwright')
      .then(({ chromium }) => chromium.launch({ headless: true }))
      .then((browser) => {
        browser.once('disconnected', () => {
          if (browserPromise === pending) browserPromise = null
        })
        return browser
      })
      .catch((e) => {
        if (browserPromise === pending) browserPromise = null
        throw e
      })
    browserPromise = pending
  }
  return browserPromise
}

// Render a URL with headless Chromium and return the post-JS DOM HTML.
export async function renderPage(url, externalSignal) {
  if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
  let browser
  try {
    browser = await getBrowser()
  } catch (error) {
    if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
    return { error: error?.code === 'ERR_MODULE_NOT_FOUND'
      ? 'SPA 渲染需 playwright（npm i playwright && npx playwright install chromium）'
      : renderError(error) }
  }
  if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
  let page
  let pageClosing
  const closePage = () => {
    if (page && !pageClosing) pageClosing = page.close().catch(() => {})
    return pageClosing
  }
  try {
    page = await browser.newPage()
    externalSignal?.addEventListener('abort', closePage, { once: true })
    if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
    // 'domcontentloaded' instead of 'networkidle': heartbeat-polling sites
    // (qq-news, juejin) never go idle and would time out at 30s. Instead wait
    // for the DOM to stabilize (content stops growing) up to 10s — SPA paint
    // usually lands within a couple of seconds of DOM-ready. Two consecutive
    // evaluate failures mean the page crashed — stop waiting for growth that
    // can never come.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    const t0 = Date.now()
    let prevLen = -1
    let evalFails = 0
    for (;;) {
      if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
      await page.waitForTimeout(500)
      const len = await page
        .evaluate(() => (document.body ? document.body.innerHTML.length : 0))
        .catch(() => -1)
      if (Date.now() - t0 > 10000) break
      evalFails = len === -1 ? evalFails + 1 : 0
      if (evalFails >= 2) break
      // stop once two consecutive reads agree — including empty bodies (a
      // blank page should not burn the full 10s poll)
      if (len === prevLen && prevLen >= 0) break
      prevLen = len
    }
    // A bot-challenge interstitial "stabilizes" the same way real content
    // does while it waits to redirect. When the DOM settled on a challenge
    // page, keep polling briefly: the challenge often clears and navigates
    // on its own within a few seconds (measured: Cloudflare "Verification
    // successful. Waiting for ... to respond").
    let html = await page.content()
    if (looksLikeChallenge(html)) {
      const t1 = Date.now()
      while (Date.now() - t1 < 8000) {
        if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
        await page.waitForTimeout(700)
        html = await page.content()
        if (!looksLikeChallenge(html)) break
      }
    }
    if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
    const finalUrl = page.url()
    return { html, finalUrl }
  } catch (e) {
    if (externalSignal && externalSignal.aborted) return { error: 'cancelled' }
    return { error: renderError(e) }
  } finally {
    externalSignal?.removeEventListener('abort', closePage)
    await closePage()
  }
}

// Called on plugin unload (temporal composability): release the browser.
export async function closeBrowser() {
  const p = browserPromise
  browserPromise = null
  if (p) {
    const closing = (async () => {
      try {
        const b = await p
        await b.close()
      } catch {
        // A failed launch or an already closed browser needs no further cleanup.
      }
    })()
    closingBrowsers.add(closing)
    closing.finally(() => closingBrowsers.delete(closing))
  }
  await Promise.all(closingBrowsers)
}
