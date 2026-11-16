'use strict';
/*
 * اختبارات قبول الشبكة: مباراة كاملة، فحص السرّية، الانقطاع والعودة، الغرفة.
 * يشغّل السيرفر بوضع سريع (EB_FAST=1) — تسريع المؤقتات فقط، القواعد كما هي.
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 3999;
const URL = `ws://127.0.0.1:${PORT}/ws`;
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
    proc.on('exit', (c) => { if (c) reject(new Error(`server exit ${c}`)); });
    setTimeout(() => reject(new Error('server timeout')), 8000);
  });
}

class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.view = null;
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => { this.ws.on('open', res); });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      this.messages.push(msg);
      if (msg.type === 'joined') {
        this.playerId = msg.playerId;
        this.token = msg.token;
        this.code = msg.code;
      }
      if (msg.type === 'state') this.view = msg;
    });
  }

  send(o) { this.ws.send(JSON.stringify(o)); }

  close() { this.ws.close(); }

  async waitFor(pred, label = 'condition', timeout = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred(this)) return this;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    throw new Error(`timeout waiting: ${label} (${this.name})`);
  }

  waitPhase(phase, timeout = 20000) {
    return this.waitFor((c) => c.view && c.view.phase === phase, `phase ${phase}`, timeout);
  }
}

test.before(startServer);
test.after(() => { if (proc) proc.kill('SIGKILL'); });

async function makeRoom(count, prefix = 'لاعب') {
  const clients = [];
  for (let i = 0; i < count; i += 1) {
    const c = new Client(`${prefix}${i + 1}`);
    // eslint-disable-next-line no-await-in-loop
    await c.ready;
    clients.push(c);
  }
  clients[0].send({ type: 'createRoom', name: `${prefix}1` });
  await clients[0].waitFor((c) => !!c.view, 'room created');
  const code = clients[0].code;
  for (let i = 1; i < count; i += 1) {
    clients[i].send({ type: 'join', code, name: `${prefix}${i + 1}` });
    // eslint-disable-next-line no-await-in-loop
    await clients[i].waitFor((c) => c.view && c.view.phase === 'lobby', 'joined lobby');
  }
  await clients[0].waitFor(
    (c) => c.view.players.filter((p) => !p.isBot).length === count, 'roster full',
  );
  return { clients, code };
}

function allocationFor(energy, tiles, offset = 0) {
  const alloc = new Array(tiles).fill(0);
  let left = energy;
  let i = offset;
  while (left > 0) { alloc[i % tiles] += 1; left -= 1; i += 1; }
  return alloc;
}

async function lockEveryone(clients, offset = 0) {
  clients.forEach((c, idx) => {
    setTimeout(() => {
      if (!c.view || c.view.phase !== 'allocate' || c.view.me.locked) return;
      c.send({ type: 'lock', alloc: allocationFor(c.view.me.energy, c.view.tiles.length, offset + idx) });
    }, 40 * idx);
  });
  await sleep(120 + clients.length * 45);
  // محاولة ثانية إن تغيّرت الطاقة (بعد سرقة مثلاً)
  clients.forEach((c) => {
    if (c.view?.phase === 'allocate' && c.view.me && !c.view.me.locked) {
      c.send({ type: 'lock', alloc: allocationFor(c.view.me.energy, c.view.tiles.length, offset) });
    }
  });
  await sleep(120);
}

test('مباراة كاملة 3 لاعبين: 5 جولات، سرّية، بطاقات، ألقاب، ثأر', async () => {
  const { clients } = await makeRoom(3, 'لاعب');
  const [A, B, C] = clients;
  await A.waitFor((c) => c.view.hostId === c.playerId, 'host');
  assert.strictEqual(A.view.players.length, 3);

  // فحص السرّية: لا تظهر اختيارات أحد في رسائل الآخرين قبل الكشف
  const secretLeak = [];
  clients.forEach((c) => {
    const origPush = c.messages.push.bind(c.messages);
    c.messages.push = (m) => {
      if (m.type === 'state' && ['lobby', 'cards', 'allocate'].includes(m.phase)) {
        // السرّية: لا توزيع ولا بطاقات لأي لاعب آخر، ولا كشف قبل أوانه
        const others = (m.players || []).filter((p) => p.id !== c.playerId);
        const bad = others.some((p) => 'alloc' in p || 'roundCard' in p || 'cards' in p
          || 'usedCards' in p || 'energy' in p);
        if (bad || 'reveal' in m || 'allocs' in m || 'perPlayer' in m) {
          secretLeak.push({ player: c.name, phase: m.phase });
        }
      }
      return origPush(m);
    };
  });

  A.send({ type: 'start' });
  await A.waitPhase('cards');
  A.send({ type: 'pickCards', cards: ['thief', 'shield', 'trap'] });
  B.send({ type: 'pickCards', cards: ['double', 'shield', 'trap'] });
  C.send({ type: 'pickCards', cards: ['sniper', 'trap', 'shield'] });

  for (let r = 1; r <= 5; r += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(clients.map((c) => c.waitPhase('allocate', 25000)));
    if (r === 2) {
      // اللص: A يسرق B
      A.send({ type: 'activate', card: 'thief', target: { playerId: B.playerId } });
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
      assert.strictEqual(A.messages.filter((m) => m.type === 'error').length, 0, 'اللص نجح');
      assert.ok(B.view.me.thiefPenalty === 2, 'الضحية فقدت طاقتين');
      assert.strictEqual(A.view.me.roundCard?.card, 'thief');
    }
    if (r === 3) {
      // الدرع على مربع، والسيرفر يرفض بطاقة ثانية في نفس الجولة
      A.send({ type: 'activate', card: 'shield', target: { tile: 0 } });
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
      A.send({ type: 'activate', card: 'trap', target: { tile: 1 } });
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
      const err = A.messages.filter((m) => m.type === 'error').pop();
      assert.ok(err && err.message.includes('بطاقة واحدة'), 'بطاقة واحدة كحد أقصى في الجولة');
    }
    // eslint-disable-next-line no-await-in-loop
    await lockEveryone(clients, r);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(clients.map((c) => c.waitPhase('reveal', 25000)));
    const rv = A.view.reveal;
    assert.strictEqual(rv.tiles.length, 4, '3 لاعبين ← 4 مربعات');
    rv.tiles.forEach((t) => {
      assert.strictEqual(Object.keys(t.energies).length, 3);
      assert.ok(typeof t.value === 'number');
      assert.ok(t.decidedBy);
    });
    // مجموع الطاقة الموزعة = الطاقة المتاحة في الجولة
    if (r === 1) {
      clients.forEach((c) => {
        const alloc = rv.allocs[c.playerId];
        assert.strictEqual(alloc.reduce((s, v) => s + v, 0), 10, 'الجولة الأولى 10 طاقة');
      });
      assert.strictEqual(rv.event, 'عادي', 'الجولة الأولى عادية دائماً');
    }
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(clients.map((c) => c.waitPhase('between', 20000)));
  }
  assert.deepStrictEqual(secretLeak, [], 'لا تسريب لاختيارات الآخرين قبل الكشف');

  await Promise.all(clients.map((c) => c.waitPhase('end', 25000)));
  const end = A.view.end;
  assert.strictEqual(Object.values(end.titles).length, 3, 'لقب لكل لاعب');
  assert.strictEqual(new Set(Object.values(end.titles)).size, 3, 'ألقاب بلا تكرار');
  assert.ok(A.view.end.summary[A.playerId], 'ملخص اللاعب');
  assert.ok(Array.isArray(A.view.end.h2h[A.playerId]), 'جدول المواجهات');
  assert.ok(A.view.end.winners.length >= 1, 'فائز واحد على الأقل');

  // ثأر: 3 ضغطات تبدأ مباراة جديدة في نفس الغرفة
  clients.forEach((c) => c.send({ type: 'revenge' }));
  await A.waitPhase('cards', 20000);
  assert.strictEqual(A.view.matchNo, 2, 'مباراة ثانية');
  assert.strictEqual(A.view.players.length, 3);
  clients.forEach((c) => c.close());
});

test('انقطاع أثناء التوزيع: البوت يلعب ثم يعود اللاعب', async () => {
  const { clients, code } = await makeRoom(3, 'غائب');
  const [A, B, C] = clients;
  A.send({ type: 'start' });
  await A.waitPhase('cards');
  clients.forEach((c) => c.send({ type: 'pickCards', cards: ['shield', 'thief', 'trap'] }));
  await A.waitPhase('allocate');

  const cId = C.playerId;
  const cToken = C.token;
  C.close();
  await sleep(400);
  assert.strictEqual(A.view.players.find((p) => p.id === cId).connected, false);

  // A و B يقفلان ← بعد انتهاء المهلة يلعب البوت عن C
  [A, B].forEach((c) => {
    c.send({ type: 'lock', alloc: allocationFor(c.view.me.energy, c.view.tiles.length) });
  });
  await A.waitPhase('reveal', 25000);
  assert.strictEqual(A.view.reveal.botPlayed[cId], true, 'البوت لعب بدل الغائب');
  const cAlloc = A.view.reveal.allocs[cId];
  assert.strictEqual(cAlloc.reduce((s, v) => s + v, 0), 10, 'البوت وزّع كل طاقة الغائب');

  // العودة بنفس الاسم والرمز المخزّن على الجهاز
  const C2 = new Client('غائب3');
  await C2.ready;
  C2.send({ type: 'rejoin', code, playerId: cId, token: cToken });
  await C2.waitFor((c) => !!c.view, 'rejoined view');
  assert.ok(C2.view.me, 'عاد كمي');
  assert.strictEqual(C2.view.me.id, cId);
  assert.strictEqual(C2.view.players.find((p) => p.id === cId).connected, true);
  // الجولة التالية: يوزّع من جديد
  await C2.waitPhase('between', 25000);
  await C2.waitPhase('allocate', 25000);
  assert.strictEqual(C2.view.me.locked, false);
  assert.strictEqual(C2.view.me.energy > 0, true);
  [A, B, C2].forEach((c) => c.close());
});

test('لا دخول بعد بدء المباراة: متفرج فقط', async () => {
  const { clients, code } = await makeRoom(3, 'متفرج');
  const [A, B, C] = clients;
  A.send({ type: 'start' });
  await A.waitPhase('cards');
  const D = new Client('متأخر');
  await D.ready;
  D.send({ type: 'join', code, name: 'متأخر' });
  await D.waitFor((c) => !!c.view, 'spectator view');
  assert.strictEqual(D.view.isSpectator, true);
  assert.strictEqual(D.view.me, null);
  [A, B, C, D].forEach((c) => c.close());
});

test('الغرفة: الأسماء الفريدة، الحد 5، انتقال الإدارة', async () => {
  const { clients, code } = await makeRoom(5, 'مكرر');
  assert.strictEqual(clients[0].view.players.length, 5);
  const names = clients[0].view.players.map((p) => p.name);
  assert.strictEqual(new Set(names).size, 5, 'الأسماء فريدة');

  const F = new Client('زائد');
  await F.ready;
  F.send({ type: 'join', code, name: 'زائد' });
  await F.waitFor((c) => !!c.view, 'sixth');
  assert.strictEqual(F.view.isSpectator, true, 'السادس متفرج');

  const hostId = clients[0].view.hostId;
  clients[0].send({ type: 'leave' });
  await clients[1].waitFor((c) => c.view.hostId && c.view.hostId !== hostId, 'host moved');
  assert.strictEqual(clients[1].view.players.filter((p) => p.id === hostId).length, 0);
  [...clients, F].forEach((c) => c.close());
});

test('التجربة مع البوتات: مباراة كاملة بضغطة واحدة', async () => {
  const solo = new Client('متجرب');
  await solo.ready;
  solo.send({ type: 'practice', name: 'متجرب' });
  await solo.waitFor((c) => c.view && c.view.phase === 'cards', 'practice cards');
  assert.strictEqual(solo.view.players.length, 4, '3 بوتات + أنت');
  solo.send({ type: 'pickCards', cards: ['shield', 'sniper', 'double'] });
  await solo.waitPhase('allocate');
  assert.strictEqual(solo.view.tiles.length, 5, '5 مربعات');
  await lockEveryone([solo]);
  await solo.waitPhase('reveal', 25000);
  assert.strictEqual(solo.view.reveal.tiles.length, 5);
  solo.close();
});


test('مباراة كاملة بلا تدخل بشري: المؤقتات والبوتات تنهيها حتى النهاية', async () => {
  const solo = new Client('صامت');
  await solo.ready;
  solo.send({ type: 'practice', name: 'صامت' });
  await solo.waitFor((c) => c.view && c.view.phase === 'cards', 'cards');
  // لا نرسل أي شيء: السيرفر يختار البطاقات عشوائياً ويكمل
  await solo.waitPhase('end', 90000);
  const end = solo.view.end;
  assert.strictEqual(solo.view.round, 5, '5 جولات');
  assert.strictEqual(Object.keys(end.titles).length, 4, 'لقب لكل لاعب');
  assert.ok(end.standings.length === 4);
  solo.close();
});
