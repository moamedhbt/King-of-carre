'use strict';
/* اختبار النقل البديل (HTTP طويل الانتظار) — لضمان اللعب إن حجب الوسيط ترقية WebSocket */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
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

class PollClient {
  constructor(name) {
    this.name = name;
    this.sid = null;
    this.view = null;
    this.running = true;
    this.messages = [];
  }

  async send(msg) {
    const res = await fetch(`${BASE}/api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: this.sid, msg }),
    });
    const data = await res.json();
    if (!this.sid) this.sid = data.sid;
    return data;
  }

  async init() {
    // جلسة واحدة أولاً، ثم كل الرسائل عليها (لا تُرسل قبل وجود sid)
    await this.send({ type: 'hello' });
    assert.ok(this.sid, 'sid created');
    return this;
  }

  async startPolling() {
    while (this.running) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${BASE}/api/poll?sid=${this.sid}`);
        if (res.status === 404) {
          this.sid = null;
          // eslint-disable-next-line no-await-in-loop
          await this.send({ type: 'hello' });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const data = await res.json();
        (data.messages || []).forEach((raw) => {
          const m = JSON.parse(raw);
          this.messages.push(m);
          if (m.type === 'joined') {
            this.playerId = m.playerId;
            this.token = m.token;
            this.code = m.code;
          }
          if (m.type === 'state') this.view = m;
        });
      } catch {
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
      }
    }
  }

  async waitFor(pred, label, timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (pred(this)) return this;
      // eslint-disable-next-line no-await-in-loop
      await sleep(30);
    }
    throw new Error(`timeout: ${label}`);
  }
}

test.before(startServer);
test.after(() => { if (proc) proc.kill('SIGKILL'); });

test('النقل البديل: إنشاء غرفة، انضمام، بدء، توزيع وقفل والكشف', async () => {
  const clients = [new PollClient('A'), new PollClient('B'), new PollClient('C')];
  for (const c of clients) {
    // eslint-disable-next-line no-await-in-loop
    await c.init();
  }
  clients.forEach((c) => { c.startPolling(); });
  await clients[0].send({ type: 'createRoom', name: 'أمين' });
  await clients[0].waitFor((c) => !!c.view, 'created');
  const code = clients[0].code;
  assert.match(code, /^[A-Z]{4}$/);

  for (let i = 1; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await clients[i].send({ type: 'join', code, name: `لاعب${i}` });
    // eslint-disable-next-line no-await-in-loop
    await clients[i].waitFor((c) => c.view && c.view.phase === 'lobby', `join ${i}`);
  }
  await clients[0].send({ type: 'start' });
  await clients[0].waitFor((c) => c.view.phase === 'cards', 'cards');
  const cards = clients.map((c) => c.send({ type: 'pickCards', cards: ['shield', 'trap', 'double'] }));
  await Promise.all(cards);
  await clients[0].waitFor((c) => c.view.phase === 'allocate', 'allocate');
  assert.strictEqual(clients[0].view.tiles.length, 4);

  const allocs = clients.map((c) => {
    const energy = c.view.me.energy;
    const tiles = c.view.tiles.length;
    const alloc = new Array(tiles).fill(0);
    for (let i = 0; i < energy; i += 1) alloc[i % tiles] += 1;
    return c.send({ type: 'lock', alloc });
  });
  await Promise.all(allocs);
  await clients[0].waitFor((c) => c.view.phase === 'reveal', 'reveal', 20000);
  assert.strictEqual(clients[0].view.reveal.tiles.length, 4);
  clients.forEach((c) => { c.running = false; });
});
