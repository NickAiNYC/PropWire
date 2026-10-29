#!/usr/bin/env node
// v176 decision-card harness — browser-verified at 1440px and 390px under the
// production CSP (vercel.json header parity). The research-mode player card is
// now a self-contained decision unit:
//   · money row   — big PROJ | FAIR numbers + 80% CI chip + distribution strip
//                   (SVG geometry only, class-based fills — CSP-clean)
//   · signal row  — role driver badge + material matchup context chips
//   · action bar  — SIM LINE primary CTA (thumb zone) + COPY FAIR + details,
//                   with the honest fail-closed "NO LIVE QUOTE" tag
// Covers the full sim round-trip (primary CTA -> tray -> apply -> card flips
// to the simulated state with ½K chip + blue line tick) and the clipboard
// copy-fair action. Screenshots: download/headless_v176_cards_{desktop,
// compact, mobile}.png
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, extname } from 'path';

const ROOT = join(process.cwd(), 'viewer');
const REPO = process.cwd();
const PORT = 9900 + Math.floor(Math.random() * 90);
const SHOTS = '/home/z/my-project/download';
mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const vercel = JSON.parse(readFileSync(join(REPO, 'vercel.json'), 'utf8'));
const prodHeaders = Object.fromEntries(
  vercel.headers.find((h) => h.source === '/(.*)').headers.map((h) => [h.key, h.value]));
const CSP = prodHeaders['Content-Security-Policy'];

const server = createServer((req, res) => {
  const clean = decodeURIComponent(req.url.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const file = join(ROOT, rel);
  if (!existsSync(file)) { res.writeHead(404, prodHeaders); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', ...prodHeaders });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
  if (!ok) failures++;
};

const bootPage = async (context, label) => {
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__PROP_WIRE_READY__ === true, null, { timeout: 25000 });
  check(`${label}: boots to __PROP_WIRE_READY__ under prod CSP`, true);
  check(`${label}: zero uncaught page errors`, pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  return page;
};

// ── Source contracts ─────────────────────────────────────────────────────
const appjs = readFileSync(join(ROOT, 'app.js'), 'utf8');
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
check('source: decision-card structure present in app.js',
  ['card-money-row', 'card-dist-svg', 'card-sim-primary', 'data-copy-fair', 'card-signal-row', 'card-research-tag'].every((m) => appjs.includes(m)));
check('source: dead pseudo progress bar fully retired', !appjs.includes('card-prog-fill'));
check('source: "AWAITING QUOTE" sportsbook block retired (markup, not comments)',
  !appjs.includes('>AWAITING QUOTE<') && !appjs.includes('card-quote-standby-wrap') && !appjs.includes('card-unverified-tag'));
check('source: distribution strip is class-filled SVG (no inline fills)',
  !/cdist-(track|band|tick)[^>]*fill=/.test(appjs));
check('source: money-row / cdist / action-bar CSS present',
  ['.card-money-val', '.cdist-band', '.cdist-tick-proj', '.card-sim-primary', '.card-action-bar', '.card-research-tag'].every((m) => css.includes(m)));

// ── Desktop 1440x900: decision card anatomy ──────────────────────────────
const browser = await chromium.launch();
try {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await bootPage(desktop, 'desktop 1440');
  await page.click('[data-view="cards"]');
  await page.waitForSelector('#cardView .mobile-quant-row .card-money-row');

  const anatomy = await page.evaluate(() => {
    const card = document.querySelector('#cardView .mobile-quant-row');
    const moneyVal = card?.querySelector('.card-money-val');
    const fairVal = card?.querySelector('.card-money-val.fair');
    const ciChip = card?.querySelector('.card-ci-chip');
    const svg = card?.querySelector('.card-dist-svg');
    const edge = card?.querySelector('.card-hero-edge');
    const signal = card?.querySelector('.card-signal-row');
    const primary = card?.querySelector('.card-sim-primary');
    const copyBtn = card?.querySelector('[data-copy-fair]');
    const tag = card?.querySelector('.card-research-tag');
    const inline = [moneyVal, primary, copyBtn, card?.querySelector('.card-money-row'), card?.querySelector('.card-action-bar')]
      .filter((el) => el && el.getAttribute('style'));
    return {
      moneyFont: moneyVal ? getComputedStyle(moneyVal).fontSize : '',
      fairFont: fairVal ? getComputedStyle(fairVal).fontSize : '',
      ciText: ciChip?.textContent || '',
      rects: svg ? svg.querySelectorAll('rect').length : 0,
      tickFair: svg ? svg.querySelectorAll('.cdist-tick-fair').length : 0,
      tickProj: svg ? svg.querySelectorAll('.cdist-tick-proj').length : 0,
      edgeText: edge?.textContent?.trim() || '',
      edgeTitle: edge?.getAttribute('title') || '',
      signalChips: signal ? signal.querySelectorAll('.driver-badge, .card-context-chip').length : 0,
      primaryText: primary?.textContent?.trim() || '',
      primaryGrow: primary ? getComputedStyle(primary).flexGrow : '',
      primaryBg: primary ? getComputedStyle(primary).backgroundColor : '',
      copyText: copyBtn?.textContent?.trim() || '',
      tagText: tag?.textContent?.trim() || '',
      inlineStyleEls: inline.length,
      cards: document.querySelectorAll('#cardView .mobile-quant-row').length
    };
  });
  check('money row: PROJ value is a BIG number (>= 20px)', parseFloat(anatomy.moneyFont) >= 20, anatomy.moneyFont);
  check('money row: FAIR value slightly quieter but still big', parseFloat(anatomy.fairFont) >= 18, anatomy.fairFont);
  check('money row: 80% CI chip renders a real range', /^80% CI \d+–\d+$/.test(anatomy.ciText), anatomy.ciText);
  check('dist strip: track + band + fair/proj ticks (>= 4 rects)', anatomy.rects >= 4 && anatomy.tickFair === 1 && anatomy.tickProj === 1, `${anatomy.rects} rects`);
  check('edge pill: model skew with direction and magnitude', /[↑↓]\s*[+-]?\d+\.\d%/.test(anatomy.edgeText), anatomy.edgeText);
  check('edge pill: tooltip explains Model Skew vs Fair', /Model Skew/i.test(anatomy.edgeTitle), anatomy.edgeTitle.slice(0, 60));
  check('signal row: driver badge / context chips present', anatomy.signalChips >= 1, `${anatomy.signalChips} chips`);
  check('action bar: SIM LINE is the primary CTA', anatomy.primaryText.includes('SIM LINE'), anatomy.primaryText);
  check('action bar: primary grows to fill the thumb zone', anatomy.primaryGrow !== '0', anatomy.primaryGrow);
  check('action bar: COPY FAIR secondary action present', anatomy.copyText.includes('COPY FAIR'), anatomy.copyText);
  check('honesty: fail-closed "NO LIVE QUOTE" tag (research mode)', anatomy.tagText === 'NO LIVE QUOTE', anatomy.tagText);
  check('CSP-clean: zero inline style attrs on new card elements', anatomy.inlineStyleEls === 0, `${anatomy.inlineStyleEls} styled`);
  check('board: research cards render (top 25 benchmarks)', anatomy.cards >= 5, `${anatomy.cards} cards`);

  // ── Copy-fair round-trip (clipboard stubbed — asserts payload honesty) ─
  await page.evaluate(() => {
    if (!navigator.clipboard) navigator.clipboard = {};
    navigator.clipboard.writeText = (t) => { window.__copiedFair = t; return Promise.resolve(); };
  });
  await page.click('#cardView .mobile-quant-row [data-copy-fair]');
  await page.waitForTimeout(250);
  const copied = await page.evaluate(() => window.__copiedFair || '');
  check('copy fair: payload carries player, fair, projection, CI', /Model Fair \d+\.\d/.test(copied) && /Proj \d+\.\d/.test(copied) && /80% CI \d+-\d+/.test(copied), copied.slice(0, 80));
  check('copy fair: payload keeps the approximation disclaimer', /approximate; not a betting recommendation/.test(copied));

  // ── Sim round-trip: primary CTA -> tray -> apply -> card flips state ────
  await page.click('#cardView .mobile-quant-row .card-sim-primary');
  await page.waitForSelector('#simModalBody .sim-readout-grid', { timeout: 10000 });
  check('sim round-trip: primary CTA opens the simulator tray', true);
  await page.click('#simApplyBtn');
  await page.waitForTimeout(500);
  const simCard = await page.evaluate(() => {
    const card = document.querySelector('#cardView .mobile-quant-row');
    return {
      primaryText: card?.querySelector('.card-sim-primary')?.textContent?.trim() || '',
      tag: card?.querySelector('.card-research-tag')?.textContent?.trim() || '',
      kelly: card?.querySelector('.card-kelly-chip')?.textContent?.trim() || '',
      bookTick: card ? card.querySelectorAll('.card-dist-svg .cdist-tick-book').length : 0
    };
  });
  check('sim round-trip: card flips to SIM <line> · EDIT', /^⚡ SIM \d+\.\d · EDIT$/.test(simCard.primaryText), simCard.primaryText);
  check('sim round-trip: honest tag switches to SIMULATED · NOT A BOOK QUOTE', simCard.tag === 'SIMULATED · NOT A BOOK QUOTE', simCard.tag);
  check('sim round-trip: ½K Kelly chip appears with the simulated line', /^½K \d+\.\d%$/.test(simCard.kelly), simCard.kelly);
  check('sim round-trip: blue line tick lands on the distribution strip', simCard.bookTick === 1, `${simCard.bookTick} tick(s)`);

  // ── Compact grid at 1440px: money row survives the narrow columns ──────
  await page.click('[data-view="compact-grid"]');
  await page.waitForSelector('#cardView.compact-grid');
  await page.waitForTimeout(400);
  const compact = await page.evaluate(() => {
    const cv = document.getElementById('cardView');
    const card = cv.querySelector('.mobile-quant-row');
    const money = card.querySelector('.card-money-row');
    const cardRect = card.getBoundingClientRect();
    const moneyRect = money.getBoundingClientRect();
    return {
      cols: (getComputedStyle(cv).gridTemplateColumns || '').split(' ').filter(Boolean).length,
      cards: cv.querySelectorAll('.mobile-quant-row').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      moneyInside: moneyRect.left >= cardRect.left - 1 && moneyRect.right <= cardRect.right + 1
    };
  });
  check('compact: decision cards render in the fluid grid', compact.cols >= 4 && compact.cards >= 5, `${compact.cols} cols · ${compact.cards} cards`);
  check('compact: money row stays inside its card (no bleed)', compact.moneyInside);
  check('compact: no horizontal overflow at 1440px', compact.overflow <= 10, `scrollWidth-clientWidth=${compact.overflow}`);
  await page.screenshot({ path: join(SHOTS, 'headless_v176_cards_compact.png'), fullPage: false });

  // Desktop cards screenshot (back to standard cards view)
  await page.click('[data-view="cards"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'headless_v176_cards_desktop.png'), fullPage: false });
  await desktop.close();

  // ── Mobile 390x844: thumb-zone sizes and no overflow ────────────────────
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  });
  const mpage = await bootPage(mobile, 'mobile 390');
  const mobileCard = await mpage.evaluate(() => {
    const card = document.querySelector('#cardView .mobile-quant-row');
    const primary = card?.querySelector('.card-sim-primary');
    const copyBtn = card?.querySelector('[data-copy-fair]');
    const moneyVal = card?.querySelector('.card-money-val');
    return {
      primaryH: primary ? Math.round(primary.getBoundingClientRect().height) : 0,
      copyH: copyBtn ? Math.round(copyBtn.getBoundingClientRect().height) : 0,
      moneyFont: moneyVal ? getComputedStyle(moneyVal).fontSize : '',
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cards: document.querySelectorAll('#cardView .mobile-quant-row').length
    };
  });
  check('mobile 390: SIM primary hits the 44px thumb-zone target', mobileCard.primaryH >= 42, `${mobileCard.primaryH}px`);
  check('mobile 390: COPY FAIR secondary hits the thumb-zone target', mobileCard.copyH >= 42, `${mobileCard.copyH}px`);
  check('mobile 390: money numbers stay big (>= 18px)', parseFloat(mobileCard.moneyFont) >= 18, mobileCard.moneyFont);
  check('mobile 390: no horizontal overflow', mobileCard.overflow <= 10, `scrollWidth-clientWidth=${mobileCard.overflow}`);
  check('mobile 390: research cards render', mobileCard.cards >= 5, `${mobileCard.cards} cards`);
  await mpage.screenshot({ path: join(SHOTS, 'headless_v176_cards_mobile.png'), fullPage: false });
  await mobile.close();
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nv176 decision-card harness: ALL PASS' : `\nv176 decision-card harness: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
