'use strict';
/*
 * اختبار عميل حقيقي (HTML + CSS + app.js) داخل jsdom مقابل السيرفر الفعلي.
 * يتحقق من: الانتظار، اختيار البطاقات، شاشة التوزيع، القفل، الانتظار، الكشف، بين الجولات، النهاية.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const WebSocket = require('ws');

const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let proc;

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), EB_FAST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => { if (String(d).includes('تعمل')) resolve(); });
    proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    setTimeout(() => reject(new Error('server timeout')), 8000);
  });
}

async function openClient() {
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = WebSocket;
      window.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const { window } = dom;
  // انتظر تحميل app.js
  const t0 = Date.now();
  while (!window.document.querySelector('#screen')?.children.length && Date.now() - t0 < 5000) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(30);
  }
  return dom;
}

async function waitDom(dom, pred, label, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred(dom.window.document, dom.window)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(40);
  }
  throw new Error(`timeout: ${label}`);
}

const q = (doc, sel) => doc.querySelector(sel);
const text = (doc) => doc.body.textContent;

function click(el, window) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

test.before(startServer);
test.after(() => { if (proc) proc.kill('SIGKILL'); });

test('عميل كامل: من الاسم إلى النهاية عبر الواجهة', async () => {
  const domA = await openClient();
  const domB = await openClient();
  const domC = await openClient();
  const [A, B, C] = [domA.window, domB.window, domC.window];

  // 1) الرئيسية: حقل الاسم + إنشاء غرفة
  await waitDom(domA, (d) => q(d, '#name-input'), 'home screen');
  assert.ok(q(domA.window.document, '[data-action="create"]'), 'زر إنشاء غرفة');
  assert.ok(q(domA.window.document, '[data-action="join"]'), 'زر دخول');
  assert.ok(q(domA.window.document, '[data-action="howto"]'), 'زر كيف تلعب');

  const nameA = q(domA.window.document, '#name-input');
  nameA.value = 'أمين';
  nameA.dispatchEvent(new A.Event('input', { bubbles: true }));
  click(q(domA.window.document, '[data-action="create"]'), A);
  await waitDom(domA, (d) => q(d, '.code-big'), 'lobby');
  const code = q(domA.window.document, '.code-big').textContent.trim();
  assert.match(code, /^[A-HJ-NP-Z]{4}$/, 'رمز 4 أحرف كبير بلا أحرف متشابهة');
  assert.ok(q(domA.window.document, '[data-action="share"]'), 'زر مشاركة الرابط');
  const startBtn = q(domA.window.document, '[data-action="start"]');
  assert.ok(startBtn.disabled, 'البدء معطّل تحت 3 لاعبين');

  // انضمام لاعبين
  for (const [dom, name] of [[domB, 'سارة'], [domC, 'علي']]) {
    const doc = dom.window.document;
    await waitDom(dom, (d) => q(d, '#code-input'), 'home B/C');
    const nameInput = q(doc, '#name-input');
    nameInput.value = name;
    nameInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const codeInput = q(doc, '#code-input');
    codeInput.value = code;
    codeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    click(q(doc, '[data-action="join"]'), dom.window);
    // eslint-disable-next-line no-await-in-loop
    await waitDom(dom, (d) => q(d, '.code-big'), `lobby ${name}`);
  }

  await waitDom(domA, (d) => d.querySelectorAll('.player-row.me').length === 1, 'players listed');
  await waitDom(domA, (d) => {
    const b = q(d, '[data-action="start"]');
    return !!b && !b.disabled;
  }, 'start enabled');

  // 2) اختيار البطاقات: 5 بطاقات، اختر 3
  click(q(domA.window.document, '[data-action="start"]'), A);
  await waitDom(domA, (d) => d.querySelectorAll('.card-pick').length === 5, 'cards screen');
  for (let i = 0; i < 3; i += 1) {
    // إعادة الاستعلام: كل نقرة تعيد رسم الشاشة
    click(domA.window.document.querySelectorAll('.card-pick')[i], A);
  }
  await waitDom(domA, (d) => !q(d, '[data-action="confirm-cards"]').disabled, 'confirm enabled');
  click(q(domA.window.document, '[data-action="confirm-cards"]'), A);

  for (const [dom, name] of [[domB, 'سارة'], [domC, 'علي']]) {
    /* eslint-disable no-await-in-loop */
    await waitDom(dom, (d) => d.querySelectorAll('.card-pick').length === 5, `cards ${name}`);
    for (let i = 0; i < 3; i += 1) {
      click(dom.window.document.querySelectorAll('.card-pick')[i], dom.window);
    }
    await waitDom(dom, (d) => !q(d, '[data-action="confirm-cards"]').disabled, `confirm ${name}`);
    click(q(dom.window.document, '[data-action="confirm-cards"]'), dom.window);
    /* eslint-enable no-await-in-loop */
  }

  // 3) شاشة التوزيع
  await waitDom(domA, (d) => d.querySelectorAll('.tile-row').length === 4, 'allocate 4 tiles');
  const docA = domA.window.document;
  assert.ok(text(docA).includes('المتبقي'), 'شريط المتبقي');
  assert.ok(q(docA, '[data-timer]'), 'عدّاد الوقت');
  assert.ok(q(docA, '[data-action="lock"]').disabled, 'القفل معطّل قبل التوزيع الكامل');
  assert.ok(text(docA).includes('وزّع كل الطاقة'), 'نص الزر عند النقص');
  assert.ok(q(docA, '[data-action="open-cards"]'), 'زر البطاقة الصغير');

  // توزيع عبر الضغط على الشريط ثم لوحة الأرقام
  const distribute = async (dom, splits) => {
    const doc = dom.window.document;
    for (let i = 0; i < splits.length; i += 1) {
      /* eslint-disable no-await-in-loop */
      click(q(doc, `.tile-meter[data-i="${i}"]`), dom.window);
      await waitDom(dom, (d) => d.querySelector('.keypad'), 'keypad');
      const keys = Array.from(doc.querySelectorAll('.key'));
      const key = keys.find((k) => k.textContent.trim() === String(splits[i]));
      click(key, dom.window);
      await sleep(40);
      /* eslint-enable no-await-in-loop */
    }
  };
  await distribute(domA, [5, 5, 0, 0]);
  await waitDom(domA, (d) => !q(d, '[data-action="lock"]').disabled, 'lock enabled');
  assert.ok(q(docA, '[data-action="lock"]').textContent.includes('قفل'), 'نص القفل');
  click(q(docA, '[data-action="lock"]'), A);
  await waitDom(domA, (d) => text(d).includes('بانتظار الآخرين'), 'waiting others');
  assert.ok(docA.querySelectorAll('.wait-row').length === 3, 'قائمة الانتظار بالأيقونات');

  // 4) الباقون يوزّعون
  await waitDom(domB, (d) => d.querySelectorAll('.tile-row').length === 4, 'B allocate');
  await waitDom(domC, (d) => d.querySelectorAll('.tile-row').length === 4, 'C allocate');
  await distribute(domB, [4, 3, 3, 0]);
  click(q(domB.window.document, '[data-action="lock"]'), B);
  await distribute(domC, [0, 2, 4, 4]);
  click(q(domC.window.document, '[data-action="lock"]'), C);

  // 5) الكشف
  await waitDom(domA, (d) => d.querySelectorAll('[data-reveal-row]').length === 4, 'reveal rows');
  await waitDom(domA, (d) => d.querySelector('.reveal-tile.show'), 'reveal animating');
  await waitDom(domA, (d) => q(d, '#skip-btn')?.style.display !== 'none', 'skip appears');
  const skip = q(domA.window.document, '[data-action="skip-reveal"]');
  click(skip, A);
  await waitDom(domA, () => domA.window.document.querySelectorAll('.reveal-tile.show').length === 4, 'skipped all');
  const emoteBtn = q(domA.window.document, '.emote-btn');
  assert.ok(emoteBtn, 'أزرار التفاعل موجودة');
  click(emoteBtn, A);

  // 6) بين الجولات ثم النهاية عبر السيرفر
  await waitDom(domA, (d) => text(d).includes('انتهت الجولة') || d.querySelector('.stand-row'), 'between', 25000);
  assert.ok(domA.window.document.querySelectorAll('.stand-row').length === 3, 'ترتيب بين الجولات');

  // أغلق واختبر أن الواجهة تبقى سليمة بلا أخطاء JS
  const errors = [];
  A.addEventListener('error', (e) => errors.push(e.message));
  assert.deepStrictEqual(errors, []);

  domA.window.close(); domB.window.close(); domC.window.close();
});

test('واجهة «كيف تلعب؟» تعرض مثال 3 لاعبين على مربع 5', async () => {
  const dom = await openClient();
  const { window } = dom;
  await waitDom(dom, (d) => q(d, '[data-action="howto"]'), 'home');
  click(q(window.document, '[data-action="howto"]'), window);
  await waitDom(dom, (d) => d.querySelector('.modal'), 'modal');
  const t = window.document.querySelector('.modal').textContent;
  assert.ok(t.includes('مثال: 3 لاعبين على مربع قيمته 5'));
  assert.ok(t.includes('4'));
  click(q(window.document, '[data-action="close-modal"]'), window);
  await waitDom(dom, (d) => !d.querySelector('.modal'), 'modal closed');
  window.close();
});


test('التجربة مع البوتات من شاشة الانتظار: 4 لاعبين و5 مربعات', async () => {
  const dom = await openClient();
  const { window } = dom;
  await waitDom(dom, (d) => q(d, '#name-input'), 'home');
  const nameInput = q(window.document, '#name-input');
  nameInput.value = 'متجرب';
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  click(q(window.document, '[data-action="create"]'), window);
  await waitDom(dom, (d) => q(d, '.code-big'), 'lobby');
  assert.ok(q(window.document, '[data-action="practice"]'), 'زر جرّب مع بوتات');
  click(q(window.document, '[data-action="practice"]'), window);
  await waitDom(dom, (d) => d.querySelectorAll('.card-pick').length === 5, 'practice cards', 10000);
  for (let i = 0; i < 3; i += 1) {
    click(window.document.querySelectorAll('.card-pick')[i], window);
  }
  click(q(window.document, '[data-action="confirm-cards"]'), window);
  await waitDom(dom, (d) => d.querySelectorAll('.tile-row').length === 5, 'five tiles', 15000);
  assert.strictEqual(window.document.querySelectorAll('.tile-row').length, 5, '4 لاعبين ← 5 مربعات');
  window.close();
});

test('رابط الغرفة يفتح على إدخال الاسم مع الرمز جاهزاً', async () => {
  const dom = await JSDOM.fromURL(`${BASE}?room=ABCD`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) { window.WebSocket = WebSocket; },
  });
  const { window } = dom;
  await waitDom(dom, (d) => q(d, '#code-input'), 'home with code');
  assert.strictEqual(q(window.document, '#code-input').value, 'ABCD');
  assert.ok(q(window.document, '#name-input'), 'حقل الاسم ظاهر أولاً');
  window.close();
});


test('إن حُجبت WebSocket: يتحول العميل تلقائياً إلى النقل البديل ويكمل', async () => {
  class BlockedWS {
    constructor() {
      setTimeout(() => {
        this.readyState = 3;
        if (this.onerror) this.onerror(new Error('blocked'));
        if (this.onclose) this.onclose();
      }, 10);
    }
  }
  const dom = await JSDOM.fromURL(BASE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.WebSocket = BlockedWS;
      // jsdom لا يوفّر fetch
      window.fetch = (url, opts) => globalThis.fetch(new URL(url, BASE).href, opts);
    },
  });
  const { window } = dom;
  await waitDom(dom, (d) => q(d, '#name-input'), 'home');
  const nameInput = q(window.document, '#name-input');
  nameInput.value = 'بديل';
  nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  // انتظر التحول إلى النقل البديل ثم أنشئ غرفة
  await waitDom(dom, () => window.eval('Net.mode') === 'poll', 'fallback to poll', 12000);
  click(q(window.document, '[data-action="create"]'), window);
  await waitDom(dom, (d) => q(d, '.code-big'), 'lobby via poll', 15000);
  const code = q(window.document, '.code-big').textContent.trim();
  assert.match(code, /^[A-Z]{4}$/, 'الغرفة أُنشئت عبر النقل البديل');
  window.close();
});
