/* لعب مباراة كاملة في متصفح حقيقي (3 لاعبين) وحفظ لقطات كل مرحلة. */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const OUT = process.env.OUT_DIR || path.join(__dirname, 'shots');
const BASE = process.env.BASE || 'http://127.0.0.1:3011/';
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1134/chrome-linux/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const pages = [];
  const errors = [];
  for (let k = 0; k < 3; k += 1) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(`p${k}: ${e.message}`));
    await p.goto(BASE, { waitUntil: 'load' });
    pages.push(p);
  }
  const shot = async (name, idx = 0) => pages[idx].screenshot({ path: path.join(OUT, `${name}.png`) });

  const names = ['أمين', 'سارة', 'علي'];
  await pages[0].fill('#name-input', names[0]);
  await pages[0].click('[data-action="create"]');
  await pages[0].waitForSelector('.code-big');
  const code = (await pages[0].textContent('.code-big')).trim();
  for (let k = 1; k < 3; k += 1) {
    await pages[k].fill('#name-input', names[k]);
    await pages[k].fill('#code-input', code);
    await pages[k].click('[data-action="join"]');
    await pages[k].waitForSelector('.code-big');
  }
  await sleep(700);
  await shot('e2e-lobby');

  await pages[0].waitForSelector('[data-action="start"]:not([disabled])');
  await pages[0].click('[data-action="start"]');
  for (const p of pages) await p.waitForSelector('.card-pick');
  await sleep(400);
  await shot('e2e-cards');
  for (const p of pages) {
    for (let i = 0; i < 3; i += 1) await p.locator('.card-pick').nth(i).click();
    await p.click('[data-action="confirm-cards"]');
  }
  for (const p of pages) await p.waitForSelector('.plot[data-plot]');
  // توزيع: 3 عملات على أرض 0، 4 على أرض 1، 3 على أرض 2
  const splits = [[3, 4, 3, 0], [4, 3, 3, 0], [2, 4, 4, 0]];
  for (let k = 0; k < 3; k += 1) {
    for (let i = 0; i < splits[k].length; i += 1) {
      const plot = pages[k].locator(`.plot[data-plot="${i}"]`);
      for (let n = 0; n < splits[k][i]; n += 1) await plot.tap();
    }
  }
  await sleep(500);
  await shot('e2e-map');
  // القفل
  for (let k = 0; k < 3; k += 1) {
    await pages[k].waitForSelector('[data-action="lock"]:not([disabled])');
    if (k === 2) { await sleep(200); await shot('e2e-map-full', 0); }
    await pages[k].click('[data-action="lock"]');
    if (k === 0) { await sleep(400); await shot('e2e-waiting', 0); }
  }
  await pages[0].waitForSelector('.plot.reveal', { timeout: 20000 });
  await sleep(1600);
  await shot('e2e-reveal-mid');
  await sleep(4200);
  await shot('e2e-reveal-full');
  await pages[0].waitForSelector('.stand-row', { timeout: 25000 });
  await sleep(500);
  await shot('e2e-between');
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
