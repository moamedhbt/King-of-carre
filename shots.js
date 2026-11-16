/* يلتقط لقطات للشاشات على مقاس هاتف 360×640 باستخدام مشروع HTML ثابت */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT_DIR || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const css0 = fs.readFileSync(path.join(__dirname, 'public/styles.css'), 'utf8');
// خط تجوال مضمّن (base64) ليعمل العرض بلا إنترنت
const fnt = (f) => 'data:font/ttf;base64,' + fs.readFileSync(`/tmp/fonts/${f}`).toString('base64');
const css = `
@font-face{font-family:'Tajawal';src:url(${fnt('Tajawal-Regular.ttf')}) format('truetype');font-weight:400;font-display:block}
@font-face{font-family:'Tajawal';src:url(${fnt('Tajawal-Bold.ttf')}) format('truetype');font-weight:700 800;font-display:block}
@font-face{font-family:'Tajawal';src:url(${fnt('Tajawal-Black.ttf')}) format('truetype');font-weight:900;font-display:block}
` + css0;
const appjs = fs.readFileSync(path.join(__dirname, 'public/app.js'), 'utf8');

// مشروع مصغّر: نحقن CSS + نسخة معدّلة من app.js بلا شبكة
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
// رسم الحالة المحقونة
S.view = window.__VIEW__; S.connected = true; render(); updateTimerNodes();
</script></body></html>`;

const players = [
  { id: 'p1', name: 'أمين', seat: 0, color: '#38E1FF', shape: '●', score: 12, energy: 10, bonus: 0, isBot: false, connected: true, locked: true, isMe: true },
  { id: 'p2', name: 'سارة', seat: 1, color: '#C084FC', shape: '▲', score: 9, energy: 11, bonus: 0, isBot: false, connected: true, locked: false },
  { id: 'p3', name: 'علي', seat: 2, color: '#BEF264', shape: '■', score: 7, energy: 13, bonus: 3, isBot: false, connected: true, locked: false },
  { id: 'p4', name: 'بوت نجم', seat: 3, color: '#FBBF24', shape: '◆', score: 4, energy: 10, bonus: 0, isBot: true, connected: true, locked: false },
];
const tiles = [ { index: 0, value: 1, golden: false }, { index: 1, value: 3, golden: false },
  { index: 2, value: 4, golden: false }, { index: 3, value: 5, golden: true } ];
const me = { ...players[0], locked: false, alloc: null,
  cards: [ {id:'shield',name:'الدرع',icon:'🛡️',target:'tile',desc:'تفوز بالتعادل'}, {id:'thief',name:'اللص',icon:'🗡️',target:'player',desc:'خصم يخسر 2'}, {id:'trap',name:'الفخ',icon:'🪤',target:'tile',desc:'6+ يخسر 3'} ],
  usedCards: [], roundCard: null, canActivate: true };

const views = {
  home: null,
  lobby: { type:'state', code:'KXRT', phase:'lobby', round:0, rounds:5, hostId:'p1', minPlayers:3, maxPlayers:5,
    players: players.slice(0,3).map((p,i)=>({...p, locked:false, isMe:i===0, isHost:i===0})), standings:[], deadline:null,
    me: { id:'p1', name:'أمين', isHost:true }, isSpectator:false, tiles:[], event:null },
  cards: { type:'state', code:'KXRT', phase:'cards', round:0, rounds:5, minPlayers:3, maxPlayers:5,
    players: players.slice(0,4), deadline: Date.now()+12000, tiles:[], me:{ id:'p1', cards:[{id:'shield'},{id:'trap'}] },
    cardChoices: [
      {id:'shield',name:'الدرع',icon:'🛡️',target:'tile',desc:'اختر أرضاً. إذا تعادلت في الأعلى تفوز بها.'},
      {id:'thief',name:'اللص',icon:'🗡️',target:'player',desc:'خصم يخسر ٢ طاقة هذه الجولة ويُعلَم قبل أن يوزّع.'},
      {id:'trap',name:'الفخ',icon:'🪤',target:'tile',desc:'كل من يضع ٦+ على الأرض يخسر ٣ نقاط.'},
      {id:'double',name:'المضاعف',icon:'✖️2',target:'tile',desc:'إذا فزت بالأرض تأخذ قيمتها مضاعفة.'},
      {id:'sniper',name:'القناص',icon:'🎯',target:'tilePlayer',desc:'يُلغي فوز لاعب على أرض محددة.'}
    ], isSpectator:false },
  allocate5: { type:'state', code:'KXRT', phase:'allocate', round:1, rounds:5, minPlayers:3, maxPlayers:5,
    players: [...players, { id:'p5', name:'هدى', seat:4, color:'#8B5CF6', shape:'★', score:3, energy:14, bonus:0, isBot:false, connected:true, locked:false }],
    tiles: [1,2,3,4,5,6].map((v,i)=>({ index:i, value:v, golden:v===6 })),
    event:'وفرة', eventInfo:{id:'وفرة',desc:'الجميع 14 طاقة'}, deadline: Date.now()+20000,
    me: { ...me, energy:14, isHost:true }, isSpectator:false },
  allocate: { type:'state', code:'KXRT', phase:'allocate', round:2, rounds:5, minPlayers:3, maxPlayers:5,
    players, tiles, event:'عادي', eventInfo:{id:'عادي',desc:'القواعد كما هي'}, deadline: Date.now()+15000,
    me: { ...me, isHost:true }, isSpectator:false },
  reveal: { type:'state', phase:'reveal', round:3, rounds:5, players, deadline: Date.now()+9000, isSpectator:false,
    me:{ id:'p1' }, tiles,
    reveal: { round:3, event:'ذهبي', tiles: [
      { index:0, baseValue:1, value:1, golden:false, energies:{p1:2,p2:3,p3:0,p4:1}, winnerId:'p2', decidedBy:'highest', collision:false, tiedIds:['p2'], doubled:false, points:{p2:1} },
      { index:1, baseValue:3, value:3, golden:false, energies:{p1:4,p2:0,p3:4,p4:2}, winnerId:'p3', decidedBy:'points', collision:true, tiedIds:['p1','p3'], doubled:false, points:{p3:3} },
      { index:2, baseValue:4, value:8, golden:true, energies:{p1:0,p2:4,p3:2,p4:4}, winnerId:null, decidedBy:'annulled', collision:true, tiedIds:['p2','p4'], doubled:false, points:{} },
      { index:3, baseValue:5, value:10, golden:true, energies:{p1:4,p2:3,p3:4,p4:3}, winnerId:'p1', decidedBy:'shield', collision:true, tiedIds:['p1','p3'], doubled:true, points:{p1:20}, sniper:null }
    ], perPlayer: { p1:{scoreBefore:12,scoreAfter:32,gain:20,trapLoss:0,delta:20,tilesWon:[3],collisions:2,winsByShield:1},
      p2:{scoreBefore:9,scoreAfter:10,gain:1,trapLoss:0,delta:1,tilesWon:[0],collisions:1,winsByShield:0},
      p3:{scoreBefore:7,scoreAfter:10,gain:3,trapLoss:0,delta:3,tilesWon:[1],collisions:2,winsByShield:0},
      p4:{scoreBefore:4,scoreAfter:4,gain:0,trapLoss:0,delta:0,tilesWon:[],collisions:1,winsByShield:0} },
      allocs:{}, summary:{} } },
  between: { type:'state', phase:'between', round:3, rounds:5, players, deadline: Date.now()+2600, isSpectator:false,
    me:{id:'p1'}, tiles,
    standings: [ {id:'p1',name:'أمين',score:32,rank:1},{id:'p3',name:'علي',score:10,rank:2},
      {id:'p2',name:'سارة',score:10,rank:2},{id:'p4',name:'بوت نجم',score:4,rank:4} ],
    between: { standings: [ {id:'p1',name:'أمين',score:32,rank:1},{id:'p3',name:'علي',score:10,rank:2},
      {id:'p2',name:'سارة',score:10,rank:2},{id:'p4',name:'بوت نجم',score:4,rank:4} ],
      bonusTo:'p4', bonusName:'بوت نجم', bonusAmount:3, lastRound:false },
    reveal: { tiles: [
      { index:0, value:1, golden:false, energies:{p1:2,p2:3,p4:1}, winnerId:'p2' },
      { index:1, value:3, golden:false, energies:{p1:4,p3:4,p4:2}, winnerId:'p3' },
      { index:2, value:8, golden:true, energies:{p2:4,p3:2,p4:4}, winnerId:null },
      { index:3, value:10, golden:true, energies:{p1:4,p2:3,p3:4,p4:3}, winnerId:'p1' } ], allocs:{} } },
  end: { type:'state', phase:'end', round:5, rounds:5, players, deadline:null, isSpectator:false, me:{id:'p1'},
    end: { standings: [ {id:'p1',name:'أمين',score:48,rank:1},{id:'p3',name:'علي',score:31,rank:2},
      {id:'p2',name:'سارة',score:22,rank:3},{id:'p4',name:'بوت نجم',score:14,rank:4} ],
      winners:['p1'], titles:{ p1:'الثعلب', p2:'الشجاع الأحمق', p3:'المسالم', p4:'الحصن' },
      summary:{ p1:{ focusedTopTile:3, tilesWon:7, collisions:2, trapLoss:0, cardsUsed:['shield','double'] } },
      h2h:{ p1:[ {id:'p2',name:'سارة',w:4,l:1,d:0},{id:'p3',name:'علي',w:3,l:2,d:0} ] },
      revengeVotes:['p2'], revengeNeeded:3 } }
};

(async () => {
  const exe = require('os').homedir() + '/.cache/ms-playwright/chromium-1134/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath: exe,
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 },
    deviceScaleFactor: Number(process.env.OUT_SCALE || 2) });
  const page = await ctx.newPage();
  // بديل localStorage في الصفحات المعزولة (setContent بلا أصل)
  await page.addInitScript(() => {
    const mem = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k) => (k in mem ? mem[k] : null),
        setItem: (k, v) => { mem[k] = String(v); },
        removeItem: (k) => { delete mem[k]; },
      },
    });
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const dir = path.join(__dirname, 'public', '__shots'); // مجلد مؤقت للعرض فقط
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, view] of Object.entries(views)) {
    fs.writeFileSync(path.join(dir, `${name}.html`), harness(view));
  }
  const URL = (n) => `http://127.0.0.1:3000/__shots/${n}.html`;
  for (const name of Object.keys(views)) {
    await page.goto(URL(name), { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  }
  // التوزيع بعد وضع كرتين
  await page.goto(URL('allocate'), { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.click('.tile-row[data-tile="3"] .tile-meter');
  await page.waitForTimeout(150);
  await page.click('.tile-row[data-tile="3"] .tile-meter');
  await page.click('.tile-row[data-tile="1"] .tile-meter');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'allocate-filled.png') });
  // الكشف بعد الكشف الكامل (زر التخطي)
  await page.goto(URL('reveal'), { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.click('#skip-btn', { timeout: 4000 }).catch((e) => console.log('skip click failed', e.message));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, 'reveal-full.png') });
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
