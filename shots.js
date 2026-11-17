/* لقطات شاشة حقيقية بمقاس هاتف — للأراضي والعملات واليد */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const css0 = fs.readFileSync(path.join(__dirname, 'public/styles.css'), 'utf8');
const appjs = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');
const fnt = (f) => 'data:font/ttf;base64,' + fs.readFileSync(`/tmp/fonts/${f}`).toString('base64');
const css = `
@font-face{font-family:'Tajawal';src:url(${fnt('Tajawal-Regular.ttf')}) format('truetype');font-weight:400;font-display:block}
@font-face{font-family:'Tajawal';src:url(${fnt('Tajawal-Bold.ttf')}) format('truetype');font-weight:700 800;font-display:block}
@font-face{font-family:'Tajawal';src:url(${fnt('Tajawal-Black.ttf')}) format('truetype');font-weight:900;font-display:block}
` + css0;

const harness = (viewJson) => `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${css}</style></head><body>
<div id="app"><main id="screen" class="screen"></main></div>
<div id="sheet-root"></div><div id="overlay-root"></div><div id="toast-root"></div>
<script>
  localStorage.setItem('eb_tutorial','1');
  window.__VIEW__ = ${JSON.stringify(viewJson)};
  window.WebSocket = function(){ return {send(){},close(){},readyState:0}; };
  window.fetch = () => Promise.reject(new Error('offline'));
</script>
<script>
${appjs.replace(/\(function boot\(\)[\s\S]*$/, '')}
S.view = window.__VIEW__; S.connected = true; render(); updateTimerNodes();
</script></body></html>`;

const players = [
  { id: 'p1', name: 'أمين', seat: 0, color: '#38E1FF', shape: '●', score: 12, energy: 10, bonus: 0, isBot: false, connected: true, locked: false, isMe: true },
  { id: 'p2', name: 'سارة', seat: 1, color: '#C084FC', shape: '▲', score: 9, energy: 11, bonus: 0, isBot: false, connected: true, locked: true },
  { id: 'p3', name: 'علي', seat: 2, color: '#BEF264', shape: '■', score: 7, energy: 13, bonus: 3, isBot: false, connected: true, locked: false },
  { id: 'p4', name: 'نجم', seat: 3, color: '#FBBF24', shape: '◆', score: 4, energy: 10, bonus: 0, isBot: true, connected: true, locked: false },
];
const cards = [
  { id: 'shield', name: 'الدرع', icon: '🛡️', target: 'tile', desc: '' },
  { id: 'thief', name: 'اللص', icon: '🗡️', target: 'player', desc: '' },
  { id: 'trap', name: 'الفخ', icon: '🪤', target: 'tile', desc: '' },
];
const me = { id: 'p1', name: 'أمين', seat: 0, color: '#38E1FF', shape: '●', isHost: true, energy: 10, alloc: [3, 0, 4, 3], locked: false, bonus: 0, thiefPenalty: 0, cards, usedCards: [], roundCard: null, canActivate: true, cardsConfirmed: true, revenge: false };

const tiles4 = [1, 3, 4, 5].map((v, i) => ({ index: i, value: v, golden: false }));
const tiles6 = [1, 2, 3, 4, 5, 6].map((v, i) => ({ index: i, value: v, golden: v === 6 }));

const base = { type: 'state', code: 'KXRT', phase: 'allocate', round: 2, rounds: 5, minPlayers: 3, maxPlayers: 5,
  event: 'عادي', eventInfo: { id: 'عادي', desc: 'القواعد كما هي' }, deadline: Date.now() + 16000, isSpectator: false };

const views = {
  map4: { ...base, players, tiles: tiles4, me },
  map6: { ...base, round: 1, players: [...players, { id: 'p5', name: 'هدى', seat: 4, color: '#8B5CF6', shape: '★', score: 3, energy: 14, bonus: 0, isBot: false, connected: true, locked: false }],
    tiles: tiles6, me: { ...me, energy: 14, alloc: [0, 0, 0, 0, 0, 0] } },
  map6filled: { ...base, round: 1, players: [...players, { id: 'p5', name: 'هدى', seat: 4, color: '#8B5CF6', shape: '★', score: 3, energy: 14, bonus: 0, isBot: false, connected: true, locked: false }],
    tiles: tiles6, me: { ...me, energy: 14, alloc: [4, 0, 3, 0, 3, 4] } },
  goldenMap: { ...base, round: 3, event: 'ذهبي', eventInfo: { id: 'ذهبي', desc: 'قيمة أعلى أرض تتضاعف' }, tiles: tiles6, players,
    me: { ...me, energy: 10, alloc: [2, 2, 0, 0, 6, 0] } },
  markMap: { ...base, round: 2, players, tiles: tiles4,
    me: { ...me, energy: 10, alloc: [3, 0, 4, 3], roundCard: { card: 'trap', target: { tile: 2 } }, usedCards: ['trap'] } },
  endMap: { ...base, phase: 'end', round: 5, deadline: 0, players,
    end: {
      winners: ['p1'],
      standings: [
        { id: 'p1', name: 'أمين', score: 41, rank: 1 },
        { id: 'p2', name: 'سارة', score: 33, rank: 2 },
        { id: 'p3', name: 'علي', score: 28, rank: 3 },
        { id: 'p4', name: 'نجم', score: 19, rank: 4 },
      ],
      titles: { p1: 'سيد الخريطة', p2: 'القناص', p3: 'المتصادم', p4: 'الجريء' },
      summary: { p1: { focusedTopTile: 4, tilesWon: 7, collisions: 3, trapLoss: 2, cardsUsed: ['shield', 'trap'] } },
      h2h: { p1: [{ name: 'سارة', w: 3, l: 2, d: 0 }, { name: 'علي', w: 4, l: 1, d: 1 }] },
      revengeVotes: [],
    } },
  revealMap: { ...base, phase: 'reveal', round: 3, deadline: Date.now() + 9000, players, tiles: tiles4, me: { id: 'p1' },
    reveal: { round: 3, event: 'ذهبي', tiles: [
      { index: 0, value: 1, golden: false, energies: { p1: 2, p2: 3, p4: 1 }, winnerId: 'p2', decidedBy: 'highest', collision: false, doubled: false },
      { index: 1, value: 3, golden: false, energies: { p1: 4, p3: 4, p4: 2 }, winnerId: 'p3', decidedBy: 'points', collision: true, doubled: false },
      { index: 2, value: 8, golden: true, energies: { p2: 4, p3: 2, p4: 4 }, winnerId: null, decidedBy: 'annulled', collision: true, doubled: false },
      { index: 3, value: 10, golden: true, energies: { p1: 4, p2: 3, p3: 4, p4: 3 }, winnerId: 'p1', decidedBy: 'shield', collision: true, doubled: true },
    ], perPlayer: { p1: { scoreBefore: 12, scoreAfter: 32, gain: 20, trapLoss: 0, tilesWon: [3], collisions: 2 }, p2: { scoreBefore: 9, scoreAfter: 10, gain: 1, trapLoss: 0, tilesWon: [0], collisions: 1 }, p3: { scoreBefore: 7, scoreAfter: 10, gain: 3, trapLoss: 0, tilesWon: [1], collisions: 2 }, p4: { scoreBefore: 4, scoreAfter: 4, gain: 0, trapLoss: 0, tilesWon: [], collisions: 1 } }, allocs: {} } },
};

(async () => {
  const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1134/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-gpu'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: Number(process.env.OUT_SCALE || 2) });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const dir = path.join(__dirname, 'public', '__shots');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, view] of Object.entries(views)) {
    fs.writeFileSync(path.join(dir, `${name}.html`), harness(view));
  }
  const URL = (n) => `http://127.0.0.1:3000/__shots/${n}.html`;
  for (const name of Object.keys(views)) {
    await page.goto(URL(name), { waitUntil: 'load' });
    await page.waitForTimeout(name === 'revealMap' ? 5200 : 700);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  }
  // لمسة على الأرض + تسليح بطاقة
  await page.goto(URL('map4'), { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.click('.plot[data-plot="2"]');
  await page.waitForTimeout(250);
  await page.click('.plot[data-plot="3"]');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'map-tap.png') });
  await page.click('.hand-card[data-id="shield"]');
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(OUT, 'map-armed.png') });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
