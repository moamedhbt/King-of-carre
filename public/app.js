'use strict';
/* معركة الطاقة — عميل الهاتف
   السيرفر هو المرجع: هذا الملف يعرض فقط ويرسل النوايا. */

const $ = (sel, root = document) => root.querySelector(sel);
const screenEl = document.getElementById('screen');
const sheetRoot = document.getElementById('sheet-root');
const overlayRoot = document.getElementById('overlay-root');
const toastRoot = document.getElementById('toast-root');

const LS = { identity: 'eb_identity', mute: 'eb_mute', tutorial: 'eb_tutorial' };

const Net = { mode: 'ws', wsFails: 0, sid: null, polling: false, connecting: null };
const pendingOut = [];

const S = {
  ws: null,
  connected: false,
  attempts: 0,
  reconnectTimer: null,
  view: null,
  identity: null,
  name: '',
  pendingCode: null,
  draft: null,
  draftRound: null,
  sheet: null,
  cardFlow: null,
  revealKey: null,
  revealTimers: [],
  lastEmote: 0,
  muted: localStorage.getItem(LS.mute) === '1',
  offset: 0,
  renderedKey: '',
  emoteCooldown: 0,
};

const EMOJIS = ['😂', '🔥', '😱', '🤡'];
const COLOR_FALLBACK = ['#22d3ee', '#c084fc', '#d9f99d', '#fbbf24', '#8b5cf6'];

/* ------------------------------------------------------------------ */
/* أدوات                                                              */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));

function toast(msg, cls = '') {
  if (!domAlive()) return;
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, 2400);
}

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* صوت (WebAudio — بلا ملفات)                                          */
/* ------------------------------------------------------------------ */

const SFX = {
  ctx: null,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  tone(freq, dur, type = 'sine', gain = 0.06, slideTo = null, delay = 0) {
    if (S.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },
  click() { this.tone(720, 0.05, 'square', 0.035); },
  lock() { this.tone(240, 0.16, 'sine', 0.09, 110); },
  reveal() { this.tone(520, 0.12, 'triangle', 0.05, 780); },
  collide() {
    this.tone(300, 0.3, 'sawtooth', 0.07, 90);
    this.tone(180, 0.22, 'square', 0.05, 70, 0.06);
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.06, null, i * 0.09));
  },
  steal() { this.tone(620, 0.12, 'square', 0.05, 320); this.tone(320, 0.16, 'square', 0.05, 180, 0.1); },
  err() { this.tone(200, 0.12, 'square', 0.05, 140); this.tone(150, 0.14, 'square', 0.05, 110, 0.12); },
};

/* ------------------------------------------------------------------ */
/* الشبكة                                                             */
/* ------------------------------------------------------------------ */

function wsSend(obj) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(obj));
    return;
  }
  if (Net.mode === 'poll' && Net.sid) {
    sendPoll(obj).catch(() => { pendingOut.push(obj); });
    return;
  }
  // لا اتصال بعد: نحفظ الرسالة ونكملها فور الاتصال
  pendingOut.push(obj);
  if (Net.mode === 'poll') pollSessionReady().catch(() => {});
  else connect();
}

function onTransportOpen() {
  S.connected = true;
  S.attempts = 0;
  if (S.identity && S.identity.token) {
    wsSend({
      type: 'rejoin', code: S.identity.code, playerId: S.identity.playerId, token: S.identity.token,
    });
  } else if (S.identity && S.identity.code && S.name) {
    wsSend({ type: 'join', code: S.identity.code, name: S.name });
  }
  // إرسال ما تراكم أثناء انتظار الاتصال (بالترتيب)
  if (pendingOut.length) {
    const queued = pendingOut.splice(0);
    queued.forEach((m) => {
      if (m.type === 'createRoom' || m.type === 'join' || m.type === 'practice' || m.type === 'rejoin') {
        S.name = S.name || '';
      }
      wsSend(m);
    });
  }
  render();
}

function connect() {
  if (Net.mode === 'poll') {
    if (!Net.polling) { Net.polling = true; pollLoop(); }
    return;
  }
  if (S.ws && (S.ws.readyState === 0 || S.ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
  } catch {
    fallbackToPoll();
    return;
  }
  S.ws = ws;
  const openGuard = setTimeout(() => {
    // الوسيط قد يحجب ترقية WebSocket ← ننتقل إلى النقل البديل
    if (ws.readyState !== 1) {
      try { ws.close(); } catch { /* تجاهل */ }
    }
  }, 5000);

  ws.onopen = () => {
    clearTimeout(openGuard);
    Net.wsFails = 0;
    onTransportOpen();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  };
  ws.onclose = () => {
    clearTimeout(openGuard);
    S.connected = false;
    if (S.ws === ws) S.ws = null;
    Net.wsFails += 1;
    if (Net.wsFails >= 2) fallbackToPoll();
    else scheduleReconnect();
    render();
  };
  ws.onerror = () => { /* يُعالج في onclose */ };
}

function fallbackToPoll() {
  if (Net.mode === 'poll') return;
  Net.mode = 'poll';
  Net.wsFails = 0;
  S.ws = null;
  Net.polling = true;
  pollLoop();
}

async function pollSessionReady() {
  if (Net.sid) return Net.sid;
  if (Net.connecting) { await Net.connecting; return Net.sid; }
  Net.connecting = (async () => {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sid: null, msg: { type: 'hello' } }),
    });
    if (!res.ok) throw new Error('session failed');
    const data = await res.json();
    Net.sid = data.sid;
    onTransportOpen();
    const queued = pendingOut.splice(0);
    for (const m of queued) {
      // eslint-disable-next-line no-await-in-loop
      await sendPoll(m);
    }
  })();
  try {
    await Net.connecting;
  } finally {
    Net.connecting = null;
  }
  return Net.sid;
}

async function sendPoll(obj) {
  const res = await fetch('/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid: Net.sid, msg: obj }),
  });
  if (!res.ok) throw new Error('send failed');
  const data = await res.json();
  if (!Net.sid && data.sid) {
    Net.sid = data.sid;
    onTransportOpen();
  }
}

async function pollLoop() {
  if (Net.mode !== 'poll') return;
  try {
    await pollSessionReady();
    const res = await fetch(`/api/poll?sid=${encodeURIComponent(Net.sid || '')}`, { cache: 'no-store' });
    if (res.status === 404) { Net.sid = null; throw new Error('expired'); }
    if (!res.ok) throw new Error('poll failed');
    const data = await res.json();
    S.connected = true;
    (data.messages || []).forEach((raw) => {
      try { handleMessage(JSON.parse(raw)); } catch { /* تجاهل */ }
    });
    setTimeout(pollLoop, 15);
  } catch {
    S.connected = false;
    render();
    setTimeout(pollLoop, 900);
  }
}

function scheduleReconnect() {
  if (S.reconnectTimer) return;
  S.attempts += 1;
  const wait = Math.min(4000, 800 + S.attempts * 400);
  S.reconnectTimer = setTimeout(() => {
    S.reconnectTimer = null;
    connect();
  }, wait);
}

function saveIdentity() {
  if (S.identity) localStorage.setItem(LS.identity, JSON.stringify(S.identity));
}

function clearIdentity() {
  S.identity = null;
  localStorage.removeItem(LS.identity);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      S.identity = {
        code: msg.code, playerId: msg.playerId, token: msg.token, name: S.name || (S.identity || {}).name || '',
      };
      if (msg.spectator) {
        S.identity.token = null;
      } else {
        saveIdentity();
      }
      S.pendingCode = null;
      if (msg.rejoined) toast('عدت إلى المباراة ✅', 'good');
      render();
      break;
    }
    case 'state': {
      const v = msg;
      S.offset = (v.serverNow || Date.now()) - Date.now();
      const prev = S.view;
      S.view = v;
      if (prev && prev.phase !== v.phase && v.phase === 'end') SFX.win();
      render();
      break;
    }
    case 'error': {
      toast(msg.message || 'خطأ', 'err');
      SFX.err();
      if (msg.fatal) {
        clearIdentity();
        S.view = null;
        S.name = '';
        render();
      }
      break;
    }
    case 'left': {
      clearIdentity();
      S.view = null;
      S.draft = null;
      S.name = '';
      render();
      break;
    }
    case 'thief': {
      const mine = S.view?.me && msg.targetId === S.view.me.id;
      toast(mine ? `🗡️ لصّ سرق منك ${msg.amount} طاقة!` : `🗡️ ${msg.targetName} فقد ${msg.amount} طاقة`, 'err');
      SFX.steal();
      vibrate(mine ? [40, 60, 40] : 30);
      break;
    }
    case 'round-start': {
      showEventBanner(msg.event, msg.eventDesc);
      if (msg.bonusTo) {
        const mine = S.view?.me && msg.bonusTo === S.view.me.id;
        setTimeout(() => toast(mine ? '🎁 تعويض الأخير: +3 طاقة لك' : `🎁 ${msg.bonusName} أخذ تعويض +3`, 'good'), 1600);
      }
      break;
    }
    case 'emote': {
      floatEmote(msg.emoji, msg.seat);
      break;
    }
    default:
      break;
  }
}

function showEventBanner(event, desc) {
  if (!domAlive()) return;
  const el = document.createElement('div');
  el.className = 'event-banner';
  el.innerHTML = `<div class="inner">${esc(event)}<small>${esc(desc || '')}</small></div>`;
  overlayRoot.appendChild(el);
  SFX.reveal();
  setTimeout(() => el.remove(), 2100);
}

function floatEmote(emoji, seat) {
  if (!domAlive()) return;
  const el = document.createElement('div');
  el.className = 'float-emote';
  el.textContent = emoji;
  el.style.left = `${30 + ((seat ?? 0) * 14) + Math.random() * 16}%`;
  overlayRoot.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

/* ------------------------------------------------------------------ */
/* الرسم العام                                                        */
/* ------------------------------------------------------------------ */

// حماية من مؤقتات تعمل بعد إغلاق الصفحة/التبويب
function domAlive() {
  return typeof document !== 'undefined' && !!document && !!document.body;
}

function render() {
  if (!domAlive()) return;
  const v = S.view;
  if (!v || !v.phase) { clearRevealTimers(); S.revealKey = null; renderHome(); return; }
  if (v.isSpectator) { clearRevealTimers(); renderSpectator(v); return; }
  if (v.phase !== 'reveal') { clearRevealTimers(); S.revealKey = null; }
  switch (v.phase) {
    case 'lobby': renderLobby(v); break;
    case 'cards': renderCards(v); break;
    case 'allocate': renderAllocate(v); break;
    case 'reveal': renderReveal(v); break;
    case 'between': renderBetween(v); break;
    case 'end': renderEnd(v); break;
    default: renderHome();
  }
  updateTimerNodes();
}

function mutedBtn() {
  return `<button class="mute-btn" data-action="toggle-mute" aria-label="كتم الصوت">${S.muted ? '🔇' : '🔊'}</button>`;
}

function connBanner() {
  if (S.connected) return '';
  return '<div class="conn-banner">انقطع الاتصال… نحاول إعادة الدخول</div>';
}

function playerChip(p, extra = '') {
  const color = p.color || COLOR_FALLBACK[p.seat % 5];
  return `<span class="row" style="gap:6px;min-width:0">
    <span class="shape" style="color:${color}">${esc(p.shape || '●')}</span>
    <span class="ellipsis" style="color:${color}">${esc(p.name)}</span>${extra}
  </span>`;
}

/* ------------------------------------------------------------------ */
/* 1) الرئيسية                                                        */
/* ------------------------------------------------------------------ */

function renderHome() {
  S.renderedKey = 'home';
  const preCode = S.pendingCode || '';
  screenEl.innerHTML = `
    <div class="screen-inner home">
      <div class="hero">
        <div class="logo-bolt">⚡</div>
        <div class="brand">معركة الطاقة</div>
        <p>وزّع ١٠ طاقة سراً… الأعلى يفوز بالمربع</p>
      </div>

      <div class="field">
        <span>👤</span>
        <input id="name-input" type="text" maxlength="14" placeholder="اسمك"
               value="${esc(S.name)}" autocomplete="off" enterkeyhint="go" />
      </div>

      ${connBanner()}

      <div class="stack">
        <button class="btn btn-primary" data-action="create">أنشئ غرفة</button>
        <div class="divider">أو</div>
        <div class="field code-field">
          <input id="code-input" type="text" inputmode="latin" maxlength="4" placeholder="رمز الغرفة"
                 value="${esc(preCode)}" autocomplete="off" autocapitalize="characters" />
        </div>
        <button class="btn" data-action="join">ادخل</button>
        <button class="btn btn-ghost" data-action="howto">كيف تلعب؟</button>
      </div>

      <div class="row" style="justify-content:center;margin-top:4px">${mutedBtn()}</div>
    </div>`;
  const nameInput = $('#name-input');
  if (nameInput) {
    nameInput.addEventListener('input', () => { S.name = nameInput.value; });
  }
  const codeInput = $('#code-input');
  if (codeInput && preCode) S.name = S.name || '';
  if (codeInput) {
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  }
  if (nameInput && !preCode) nameInput.focus({ preventScroll: true });
}

function readName() {
  const input = $('#name-input');
  if (input) S.name = input.value.trim();
  return S.name;
}

function doCreate() {
  const name = readName();
  if (!name) { toast('اكتب اسمك أولاً', 'err'); return; }
  if (!S.connected) toast('نتصل… سيُنفَّذ تلقائياً', 'good');
  wsSend({ type: 'createRoom', name });
}

function doJoin() {
  const name = readName();
  const codeInput = $('#code-input');
  const code = (codeInput ? codeInput.value : (S.pendingCode || '')).toUpperCase().trim();
  if (!name) { toast('اكتب اسمك أولاً', 'err'); return; }
  if (code.length !== 4) { toast('رمز الغرفة 4 أحرف', 'err'); return; }
  if (!S.connected) toast('نتصل… سيُنفَّذ تلقائياً', 'good');
  wsSend({ type: 'join', code, name });
  S.name = name;
}

/* ------------------------------------------------------------------ */
/* 2) الانتظار                                                        */
/* ------------------------------------------------------------------ */

function renderLobby(v) {
  S.renderedKey = `lobby|${v.players.length}|${v.hostId}`;
  const isHost = v.me && v.me.isHost;
  const enough = v.players.length >= v.minPlayers;
  const link = `${location.origin}${location.pathname}?room=${v.code}`;
  const slots = [];
  for (let i = 0; i < v.maxPlayers; i += 1) {
    const p = v.players[i];
    if (p) {
      slots.push(`<div class="player-row ${p.isMe ? 'me' : ''}">
        <span class="dot" style="background:${p.color};color:${p.color}"></span>
        <span class="shape" style="color:${p.color}">${esc(p.shape)}</span>
        <span class="name grow ellipsis">${esc(p.name)}${p.isMe ? ' <span class="tiny dim">(أنت)</span>' : ''}${p.isBot ? ' 🤖' : ''}</span>
        ${p.isHost ? '<span class="badge-crown">👑</span>' : ''}
        ${p.connected ? '' : '<span class="tiny dim">غير متصل</span>'}
      </div>`);
    } else {
      slots.push(`<div class="player-row seat-empty"><span class="dim">مقعد فارغ</span></div>`);
    }
  }

  screenEl.innerHTML = `
    <div class="screen-inner lobby">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <span class="pill">الغرفة ${esc(v.code)}</span>
        <div class="row" style="gap:6px">
          ${mutedBtn()}
          <button class="btn btn-ghost btn-small" data-action="howto">؟</button>
        </div>
      </div>

      <div class="code-box">
        <div class="tiny dim">رمز الغرفة</div>
        <div class="code-big">${esc(v.code)}</div>
        <button class="btn btn-small" data-action="share">📤 شارك الرابط</button>
      </div>

      <div class="row" style="justify-content:space-between">
        <span class="section-title">اللاعبون (${v.players.length}/${v.maxPlayers})</span>
        <span class="tiny dim">${enough ? 'جاهزون للبدء' : `تحتاج ${v.minPlayers} لاعبين على الأقل`}</span>
      </div>
      <div class="player-list">${slots.join('')}</div>

      <div class="stack">
        ${isHost
    ? `<button class="btn btn-primary" data-action="start" ${enough ? '' : 'disabled'}>ابدأ</button>`
    : '<div class="card center small dim">بانتظار المضيف ليبدأ…</div>'}
        <button class="btn btn-ghost" data-action="practice">🤖 جرّب مع بوتات</button>
        <button class="btn btn-ghost btn-small" data-action="leave">خروج</button>
      </div>
      <div class="tiny dim center">شارك الرابط: ${esc(link)}</div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 3) اختيار البطاقات                                                  */
/* ------------------------------------------------------------------ */

function renderCards(v) {
  const chosen = v.me?.cards || [];
  const chosenIds = chosen.map((c) => c.id);
  const key = `cards|${chosenIds.join(',')}`;
  S.renderedKey = key;
  const list = v.cardChoices || [];
  screenEl.innerHTML = `
    <div class="screen-inner">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <div class="title" style="font-size:20px">اختر 3 بطاقات</div>
        <div class="row" style="gap:6px">
          <div class="timer" data-timer>--</div>
          ${mutedBtn()}
        </div>
      </div>
      <div class="hint">بطاقة واحدة كحد أقصى في الجولة — استعمالها سري حتى الكشف</div>
      <div class="cards-grid">
        ${list.map((c) => `
          <button class="card-pick ${chosenIds.includes(c.id) ? 'sel' : ''}" data-action="pick-card" data-id="${c.id}">
            <span class="tick">✓</span>
            <span class="ico">${c.icon}</span>
            <span class="nm">${esc(c.name)}</span>
            <span class="ds">${esc(c.desc)}</span>
          </button>`).join('')}
      </div>
      <div class="pick-count">
        <span>${chosenIds.length}/3</span>
        <span class="dim tiny">مختارة</span>
      </div>
      <button class="btn btn-primary" data-action="confirm-cards" ${chosenIds.length === 3 ? '' : 'disabled'}>
        ${v.me?.cardsConfirmed ? 'جاهز ✓' : 'تأكيد الاختيار'}
      </button>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 4) التوزيع                                                         */
/* ------------------------------------------------------------------ */

function ensureDraft(v) {
  const me = v.me;
  if (!me) return [];
  const n = v.tiles.length;
  const sameRound = S.draftRound === v.round && Array.isArray(S.draft) && S.draft.length === n;
  if (!sameRound) {
    const base = (me.alloc && me.alloc.slice(0, n)) || [];
    S.draft = Array.from({ length: n }, (_, i) => Number(base[i] || 0));
    S.draftRound = v.round;
  }
  // قص الزائد (بعد سرقة مثلاً)
  let sum = S.draft.reduce((s, x) => s + x, 0);
  while (sum > me.energy) {
    let idx = 0;
    S.draft.forEach((x, i) => { if (x > S.draft[idx]) idx = i; });
    if (S.draft[idx] <= 0) break;
    S.draft[idx] -= 1;
    sum -= 1;
  }
  return S.draft;
}

function renderAllocate(v) {
  const me = v.me;
  const draft = ensureDraft(v);
  const total = me.energy;
  const used = draft.reduce((s, x) => s + x, 0);
  const remaining = total - used;
  S.renderedKey = `allocate|${v.round}|${me.locked}|${v.players.filter((p) => p.locked).length}|${S.sheet ? 'sheet' : ''}`;

  const topbar = `
    <div class="topbar">
      <span class="energy-pill ${remaining === 0 ? '' : 'low'}">المتبقي: <b data-remaining>${remaining}</b> ⚡</span>
      <div class="timer" data-timer>--</div>
      <div class="grow"></div>
      ${mutedBtn()}
    </div>`;

  if (me.locked) {
    const rows = v.players.map((p) => `
      <div class="wait-row ${p.locked ? 'ok' : ''}">
        <span class="dot" style="background:${p.color};color:${p.color}"></span>
        <span class="shape" style="color:${p.color}">${esc(p.shape)}</span>
        <span class="grow ellipsis">${esc(p.name)}${p.isMe ? ' (أنت)' : ''}${p.botPlayed ? ' 🤖' : ''}</span>
        <span>${p.locked ? '🔒' : '⏳'}</span>
      </div>`).join('');
    screenEl.innerHTML = `
      <div class="screen-inner allocate">
        ${connBanner()}
        ${topbar}
        <div class="cardline">${cardButton(v)}</div>
        <div class="card center" style="display:flex;flex-direction:column;gap:4px">
          <div class="bold" style="color:#d9f99d">قفلت توزيعك ✓</div>
          <div class="tiny dim">الجولة ${v.round} — بانتظار الآخرين…</div>
        </div>
        <div class="waiting-list">${rows}</div>
        <div class="tiny dim center">ستُكشف كل الاختيارات معاً بعد قفل الجميع</div>
      </div>`;
    updateTimerNodes();
    return;
  }

  const tileRows = v.tiles.map((t, i) => {
    const val = draft[i] || 0;
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;
    return `<div class="tile-row ${t.golden ? 'golden' : ''}" data-tile="${i}">
      <div class="value-badge">${t.value}</div>
      <button class="step-btn minus" data-step="-1" data-i="${i}" ${val <= 0 ? 'disabled' : ''} aria-label="إنقاص">−</button>
      <div class="tile-meter" data-action="set" data-i="${i}" role="button" aria-label="اضبط الرقم">
        <span class="fill" style="width:${pct}%"></span>
        <span class="num">${val}</span>
        <span class="lbl">⚡</span>
      </div>
      <button class="step-btn" data-step="1" data-i="${i}" ${remaining <= 0 ? 'disabled' : ''} aria-label="زيادة">+</button>
    </div>`;
  }).join('');

  screenEl.innerHTML = `
    <div class="screen-inner allocate">
      ${connBanner()}
      ${topbar}
      <div class="cardline">${cardButton(v)}</div>
      <div class="tiles">${tileRows}</div>
      <div class="lockbar">
        <button class="lock-btn ${remaining === 0 ? 'ready' : ''}" data-action="lock" ${remaining === 0 ? '' : 'disabled'}>
          ${remaining === 0 ? 'قفل ✔' : `وزّع كل الطاقة (${remaining})`}
        </button>
      </div>
    </div>`;

  bindStepButtons();
  maybeTutorial();
  updateTimerNodes();
}

function cardButton(v) {
  const me = v.me;
  const usable = (me.cards || []).filter((c) => !(me.usedCards || []).includes(c.id));
  if (me.roundCard) {
    const c = (me.cards || []).find((x) => x.id === me.roundCard.card);
    return `<span class="card-open-btn used">${c ? c.icon : '🎴'} مُفعّلة</span>`;
  }
  if (!usable.length) return '<span class="card-open-btn used">لا بطاقات</span>';
  return `<button class="card-open-btn" data-action="open-cards" ${me.canActivate ? '' : 'disabled'}>
    🎴 بطاقتك (${usable.length})
  </button>`;
}

function bindStepButtons() {
  screenEl.querySelectorAll('[data-step]').forEach((btn) => {
    const step = Number(btn.dataset.step);
    const i = Number(btn.dataset.i);
    let holdTimer = null;
    let repeatTimer = null;
    const apply = () => {
      const v = S.view;
      if (!v || v.phase !== 'allocate' || v.me.locked) return;
      const draft = S.draft;
      const used = draft.reduce((s, x) => s + x, 0);
      if (step > 0) {
        if (used >= v.me.energy) { toast('وزّعت كل طاقتك', 'err'); stop(); return; }
        draft[i] += 1;
        SFX.click();
      } else {
        if (draft[i] <= 0) { stop(); return; }
        draft[i] -= 1;
        SFX.click();
      }
      refreshAllocateNumbers();
      vibrate(8);
      if (step > 0 && used + 1 >= v.me.energy) { vibrate([12, 40, 18]); stop(); }
    };
    const start = (e) => {
      e.preventDefault();
      apply();
      holdTimer = setTimeout(() => {
        repeatTimer = setInterval(apply, 85);
      }, 420);
    };
    const stop = () => {
      if (holdTimer) clearTimeout(holdTimer);
      if (repeatTimer) clearInterval(repeatTimer);
      holdTimer = null;
      repeatTimer = null;
    };
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

function refreshAllocateNumbers() {
  const v = S.view;
  if (!v || v.phase !== 'allocate' || !S.draft) return;
  const total = v.me.energy;
  const used = S.draft.reduce((s, x) => s + x, 0);
  const remaining = total - used;
  const remEl = $('[data-remaining]');
  if (remEl) remEl.textContent = String(remaining);
  const wrap = $('.energy-pill');
  if (wrap) wrap.classList.toggle('low', remaining !== 0);
  S.draft.forEach((val, i) => {
    const row = $(`.tile-row[data-tile="${i}"]`);
    if (!row) return;
    const num = row.querySelector('.num');
    if (num) num.textContent = String(val);
    const fill = row.querySelector('.fill');
    if (fill) fill.style.width = `${total > 0 ? Math.round((val / total) * 100) : 0}%`;
    const minus = row.querySelector('[data-step="-1"]');
    if (minus) minus.disabled = val <= 0;
    const plus = row.querySelector('[data-step="1"]');
    if (plus) plus.disabled = remaining <= 0;
  });
  const lock = $('[data-action="lock"]');
  if (lock) {
    lock.disabled = remaining !== 0;
    lock.classList.toggle('ready', remaining === 0);
    lock.textContent = remaining === 0 ? 'قفل ✔' : `وزّع كل الطاقة (${remaining})`;
  }
}

/* فقاعات التعليم في أول مباراة */
function maybeTutorial() {
  if (!domAlive()) return;
  if (localStorage.getItem(LS.tutorial) === '1') return;
  localStorage.setItem(LS.tutorial, '1');
  const texts = ['وزّع طاقتك سراً', 'الأعلى يفوز', 'التساوي يضيّع المربع'];
  const box = document.createElement('div');
  box.className = 'bubbles';
  overlayRoot.appendChild(box);
  texts.forEach((t, i) => {
    setTimeout(() => {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = t;
      box.appendChild(b);
      setTimeout(() => b.remove(), 2100);
      if (i === texts.length - 1) setTimeout(() => box.remove(), 2300);
    }, i * 2200);
  });
}

/* ------------------------------------------------------------------ */
/* 5) الكشف                                                           */
/* ------------------------------------------------------------------ */

function clearRevealTimers() {
  (S.revealTimers || []).forEach((t) => clearTimeout(t));
  S.revealTimers = [];
}

function renderReveal(v) {
  const rv = v.reveal;
  if (!rv) { screenEl.innerHTML = '<div class="screen-inner center">…</div>'; return; }
  const key = `reveal|${v.matchNo}|${v.round}`;
  if (S.revealKey === key) return; // لا نعيد بناء الأنيميشن عند تحديث الحالة
  clearRevealTimers();
  S.revealKey = key;
  S.renderedKey = key;
  clearRevealTimers();

  const players = v.players;
  const byId = (id) => players.find((p) => p.id === id) || { name: '؟', color: '#888', shape: '●' };
  const rowsHtml = rv.tiles.map((t) => {
    const totalE = Object.values(t.energies).reduce((s, x) => s + x, 0) || 1;
    const segs = players
      .filter((p) => (t.energies[p.id] || 0) > 0)
      .map((p) => `<span style="width:${((t.energies[p.id] || 0) / totalE) * 100}%;background:${p.color}"></span>`)
      .join('');
    const chips = players.map((p) => {
      const e = t.energies[p.id] || 0;
      const isWin = t.winnerId === p.id;
      return `<span class="rv-chip ${isWin ? 'win' : ''}" style="${e ? '' : 'opacity:.4'}">
        <span style="color:${p.color}">${esc(p.shape)}</span>${esc(p.name)} · ${e}${isWin ? ' 👑' : ''}
      </span>`;
    }).join('');
    let label = '';
    if (t.winnerId) label = `يفوز: ${esc(byId(t.winnerId).name)} +${t.value}`;
    else if (t.decidedBy === 'annulled') label = 'تصادم — ضاع المربع';
    else if (t.decidedBy === 'sniper') label = 'قناص ألغى الفوز';
    else label = 'لا أحد';
    return `<div class="reveal-tile ${t.golden ? 'golden' : ''}" data-reveal-row="${t.index}">
      <div class="reveal-head">
        <div class="rv-value ${t.golden ? 'golden' : ''}">${t.value}</div>
        <span class="rv-win-label grow">${label}</span>
        ${t.doubled ? '<span class="pill tiny">×2 مضاعف</span>' : ''}
        ${t.sniper ? '<span class="pill tiny">🎯</span>' : ''}
      </div>
      <div class="row" style="margin-top:6px;gap:6px">
        <div class="rv-seg">${segs}</div>
      </div>
      <div class="rv-players">${chips}</div>
    </div>`;
  }).join('');

  screenEl.innerHTML = `
    <div class="screen-inner reveal-screen">
      ${connBanner()}
      <div class="topbar">
        <span class="pill">الجولة ${v.round}/${v.rounds} · ${esc(rv.event)}</span>
        <div class="grow"></div>
        <button class="btn btn-ghost btn-small" data-action="skip-reveal" style="display:none" id="skip-btn">تخطّي</button>
        ${mutedBtn()}
      </div>
      <div class="reveal-list" id="reveal-list">${rowsHtml}</div>
      <div class="emote-bar">
        ${EMOJIS.map((e) => `<button class="emote-btn" data-action="emote" data-emoji="${e}">${e}</button>`).join('')}
      </div>
    </div>`;

  const rows = Array.from(screenEl.querySelectorAll('[data-reveal-row]'));
  const step = 1200;
  rows.forEach((row, i) => {
    const t = rv.tiles[i];
    const tm = setTimeout(() => {
      row.classList.add('show');
      SFX.reveal();
      if (t.winnerId) {
        row.classList.add('winner-glow');
        const float = document.createElement('div');
        float.className = 'float-points';
        float.textContent = `+${t.value}`;
        row.appendChild(float);
        setTimeout(() => float.remove(), 1200);
        vibrate(14);
      }
      if (t.collision) {
        row.classList.add('collision');
        SFX.collide();
        vibrate([25, 50, 25]);
      }
      if (i === 0) {
        const skip = $('#skip-btn');
        if (skip) skip.style.display = '';
      }
    }, i * step + 60);
    S.revealTimers.push(tm);
  });
}

function skipReveal() {
  clearRevealTimers();
  screenEl.querySelectorAll('[data-reveal-row]').forEach((row) => {
    row.classList.add('show');
    if ($('.float-points', row)) return;
  });
}

/* ------------------------------------------------------------------ */
/* 6) بين الجولات                                                     */
/* ------------------------------------------------------------------ */

function renderBetween(v) {
  const b = v.between || {};
  const st = b.standings || v.standings || [];
  S.renderedKey = `between|${v.round}`;
  screenEl.innerHTML = `
    <div class="screen-inner">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <div class="title" style="font-size:19px">انتهت الجولة ${v.round}</div>
        <div class="timer" data-timer>--</div>
      </div>
      ${b.bonusName ? `<div class="card center small"><b style="color:#d9f99d">🎁 ${esc(b.bonusName)}</b> يأخذ تعويض الأخير +${b.bonusAmount} طاقة في الجولة القادمة</div>` : ''}
      <div class="standings">
        ${st.map((row) => {
    const p = v.players.find((x) => x.id === row.id) || row;
    return `<div class="stand-row ${row.rank === 1 ? 'lead' : ''}">
          <span class="stand-rank">${row.rank}</span>
          <span class="dot" style="background:${p.color};color:${p.color}"></span>
          <span class="shape" style="color:${p.color}">${esc(p.shape)}</span>
          <span class="grow ellipsis">${esc(row.name)}${row.id === v.me?.id ? ' (أنت)' : ''}${row.isBot ? ' 🤖' : ''}</span>
          <span class="stand-score">${row.score}</span>
        </div>`;
  }).join('')}
      </div>
      <div class="emote-bar" style="position:static;justify-content:center;opacity:.9">
        ${EMOJIS.map((e) => `<button class="emote-btn" data-action="emote" data-emoji="${e}">${e}</button>`).join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* 7) النهاية                                                         */
/* ------------------------------------------------------------------ */

function renderEnd(v) {
  const e = v.end;
  if (!e) return;
  const st = e.standings || [];
  const meId = v.me?.id;
  const mySummary = e.summary?.[meId];
  const myH2H = e.h2h?.[meId] || [];
  const votes = (e.revengeVotes || []).length;
  S.renderedKey = `end|${votes}|${v.matchNo}`;
  const winnerNames = e.winners.map((id) => (st.find((s) => s.id === id) || {}).name).filter(Boolean);

  screenEl.innerHTML = `
    <div class="screen-inner end-screen">
      ${connBanner()}
      <div class="center" style="flex:none">
        <div class="brand" style="font-size:24px">${winnerNames.length > 1 ? 'تعادل في القمة!' : 'الفائز'}</div>
        <div class="bold" style="font-size:19px;color:#ffd166">${esc(winnerNames.join(' و '))}</div>
      </div>

      <div class="standings">
        ${st.map((row) => {
    const p = v.players.find((x) => x.id === row.id) || row;
    const title = e.titles[row.id];
    return `<div class="stand-row ${row.rank === 1 ? 'lead' : ''}">
          <span class="stand-rank">${row.rank}</span>
          <span class="dot" style="background:${p.color};color:${p.color}"></span>
          <span class="shape" style="color:${p.color}">${esc(p.shape)}</span>
          <div class="grow" style="min-width:0">
            <div class="ellipsis bold">${esc(row.name)}${row.id === meId ? ' (أنت)' : ''}${row.isBot ? ' 🤖' : ''}</div>
            <div class="tiny"><span class="title-chip">${esc(title || '')}</span></div>
          </div>
          <span class="stand-score">${row.score}</span>
        </div>`;
  }).join('')}
      </div>

      ${mySummary ? `<div class="card small">
        <div class="section-title">ملخصك</div>
        <div>ركّزت على أكبر مربع <b>${mySummary.focusedTopTile}</b> مرات.</div>
        <div class="dim tiny">مربعات فزت بها: ${mySummary.tilesWon} · تصادمات: ${mySummary.collisions} · خسارة من فخاخ: ${mySummary.trapLoss}</div>
      </div>` : ''}

      ${myH2H.length ? `<div class="card small">
        <div class="section-title">مواجهات الغرفة</div>
        <div class="h2h-table">
          ${myH2H.map((r) => `<div class="h2h-row"><span class="ellipsis">${esc(r.name)}</span><span class="nowrap">أنت ${r.w} · ${esc(r.name)} ${r.l}${r.d ? ` (تعادل ${r.d})` : ''}</span></div>`).join('')}
        </div>
      </div>` : ''}

      <div class="stack">
        <button class="btn btn-primary" data-action="revenge">
          🔁 ثأر ${votes ? `(${votes}/3)` : ''}
        </button>
        <button class="btn btn-ghost btn-small" data-action="leave">خروج</button>
      </div>
      <div class="tiny dim center">ثأر يبدأ عندما يضغطه 3 لاعبين</div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* المتفرج                                                            */
/* ------------------------------------------------------------------ */

function renderSpectator(v) {
  S.renderedKey = `spec|${v.phase}|${v.round}`;
  const st = v.standings || [];
  screenEl.innerHTML = `
    <div class="screen-inner">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <span class="pill">👀 متفرج · ${esc(v.code)}</span>
        ${mutedBtn()}
      </div>
      <div class="spectate-note">المباراة بدأت — يمكنك المشاهدة فقط</div>
      ${v.phase === 'allocate' ? `<div class="card center small dim">اللاعبون يوزّعون الطاقة سراً…</div>` : ''}
      ${v.phase === 'reveal' && v.reveal ? `<div class="reveal-list scroll">
        ${v.reveal.tiles.map((t) => `<div class="card small">
          <div class="row"><div class="rv-value ${t.golden ? 'golden' : ''}">${t.value}</div>
            <span class="small grow">${t.winnerId ? `يفوز ${esc((v.players.find((p) => p.id === t.winnerId) || {}).name || '')} +${t.value}` : 'لا أحد'}</span></div>
        </div>`).join('')}</div>` : ''}
      ${st.length ? `<div class="standings">
        ${st.map((row) => `<div class="stand-row"><span class="stand-rank">${row.rank}</span>
          <span class="grow ellipsis">${esc(row.name)}</span><span class="stand-score">${row.score}</span></div>`).join('')}
      </div>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* المؤقت (عرض فقط — المصدر السيرفر)                                   */
/* ------------------------------------------------------------------ */

function updateTimerNodes() {
  if (!domAlive()) return;
  const v = S.view;
  const nodes = document.querySelectorAll('[data-timer]');
  if (!v || !v.deadline) {
    nodes.forEach((n) => { n.textContent = '--'; });
    return;
  }
  const remain = Math.max(0, v.deadline - (Date.now() + S.offset));
  const s = secs(remain);
  nodes.forEach((n) => {
    n.textContent = `⏱ ${s}`;
    n.classList.toggle('urgent', remain <= 5000);
  });
}

setInterval(() => { try { updateTimerNodes(); } catch { /* صفحة مغلقة */ } }, 250);

/* ------------------------------------------------------------------ */
/* الأوراق السفلية                                                    */
/* ------------------------------------------------------------------ */

function closeSheet() {
  S.sheet = null;
  S.cardFlow = null;
  sheetRoot.innerHTML = '';
}

function openSheet(html) {
  sheetRoot.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet">
      <div class="sheet-handle"></div>
      ${html}
    </div>`;
  requestAnimationFrame(() => {
    if (!domAlive()) return;
    sheetRoot.querySelector('.sheet-backdrop')?.classList.add('show');
    sheetRoot.querySelector('.sheet')?.classList.add('show');
  });
}

function openCardsSheet() {
  const v = S.view;
  if (!v || v.phase !== 'allocate' || v.me.locked || v.me.roundCard) return;
  const usable = (v.me.cards || []).filter((c) => !(v.me.usedCards || []).includes(c.id));
  if (!usable.length) { toast('لا بطاقات متاحة', 'err'); return; }
  S.cardFlow = { step: 'card', card: null, target: {} };
  openSheet(`
    <div class="sheet-title">بطاقتك — اختر بطاقة</div>
    <div class="tiny dim center">تُفعَّل قبل القفل · استعمالها سري حتى الكشف</div>
    <div class="stack">
      ${usable.map((c) => `<button class="pick-card-row" data-action="choose-card" data-id="${c.id}">
        <span class="ico">${c.icon}</span>
        <span class="grow" style="min-width:0;text-align:right">
          <span class="bold">${esc(c.name)}</span>
          <span class="ds">${esc(c.desc)}</span>
        </span>
      </button>`).join('')}
    </div>
    <button class="btn btn-ghost btn-small" data-action="close-sheet">إلغاء</button>
  `);
}

function openCardTargetSheet() {
  const v = S.view;
  const flow = S.cardFlow;
  if (!v || !flow || !flow.card) return;
  const card = flow.card;
  const tiles = v.tiles;
  const others = v.players.filter((p) => p.id !== v.me.id);
  if (card.target === 'player') {
    openSheet(`
      <div class="sheet-title">${card.icon} ${esc(card.name)} — اختر خصماً</div>
      <div class="tiny dim center">يخسر 2 طاقة هذه الجولة ويُعلَم قبل أن يوزّع</div>
      <div class="stack">
        ${others.map((p) => `<button class="pick-card-row" data-action="target-player" data-id="${p.id}">
          <span class="dot" style="background:${p.color};color:${p.color}"></span>
          <span class="grow bold">${esc(p.name)}${p.isBot ? ' 🤖' : ''}</span>
          <span class="dim small">${p.locked ? '🔒' : ''}</span>
        </button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-small" data-action="back-to-cards">رجوع</button>
    `);
    return;
  }
  if (flow.step === 'player') {
    openSheet(`
      <div class="sheet-title">${card.icon} ${esc(card.name)} — اختر اللاعب</div>
      <div class="tiny dim center">إذا فاز بالمربع رقم ${Number(flow.target.tile) + 1} يُلغى فوزه</div>
      <div class="stack">
        ${others.map((p) => `<button class="pick-card-row" data-action="target-player" data-id="${p.id}">
          <span class="dot" style="background:${p.color};color:${p.color}"></span>
          <span class="grow bold">${esc(p.name)}</span>
        </button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-small" data-action="back-to-cards">رجوع</button>
    `);
    return;
  }
  openSheet(`
    <div class="sheet-title">${card.icon} ${esc(card.name)} — اختر مربعاً</div>
    <div class="tiny dim center">${esc(card.desc)}</div>
    <div class="opt-grid">
      ${tiles.map((t) => `<button class="opt" data-action="target-tile" data-i="${t.index}">
        ${t.value}${t.golden ? ' ×2' : ''}
      </button>`).join('')}
    </div>
    <button class="btn btn-ghost btn-small" data-action="back-to-cards">رجوع</button>
  `);
}

function openKeypadSheet(index) {
  const v = S.view;
  if (!v || v.phase !== 'allocate' || v.me.locked) return;
  const draft = S.draft;
  const usedOthers = draft.reduce((s, x) => s + x, 0) - (draft[index] || 0);
  const max = Math.min(v.me.energy, v.me.energy - usedOthers);
  S.sheet = { kind: 'keypad', index, value: draft[index] || 0 };
  const keys = [];
  for (let n = 0; n <= v.me.energy; n += 1) keys.push(n);
  openSheet(`
    <div class="sheet-title">المربع ${v.tiles[index].value}${v.tiles[index].golden ? ' ×2' : ''} — ضع طاقة</div>
    <div class="val-preview">القيمة: <b>${draft[index] || 0}</b> ⚡ <span class="tiny dim">(الحد ${max})</span></div>
    <div class="keypad">
      ${keys.map((n) => `<button class="key ${n === (draft[index] || 0) ? 'sel' : ''}" data-action="set-value" data-n="${n}" ${n > max ? 'disabled style="opacity:.3"' : ''}>${n}</button>`).join('')}
    </div>
    <button class="btn btn-primary" data-action="close-sheet">تم</button>
  `);
}

/* ------------------------------------------------------------------ */
/* الأحداث                                                            */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const v = S.view;
  SFX.ensure();

  switch (action) {
    case 'toggle-mute': {
      S.muted = !S.muted;
      localStorage.setItem(LS.mute, S.muted ? '1' : '0');
      render();
      if (!S.muted) SFX.click();
      break;
    }
    case 'create': doCreate(); break;
    case 'join': doJoin(); break;
    case 'howto': openHowTo(); break;
    case 'share': shareLink(); break;
    case 'start': wsSend({ type: 'start' }); break;
    case 'practice': {
      const name = S.name || readName();
      if (!name) { toast('اكتب اسمك أولاً', 'err'); break; }
      wsSend({ type: 'practice', name });
      break;
    }
    case 'leave': wsSend({ type: 'leave' }); break;

    case 'pick-card': {
      if (!v || v.phase !== 'cards') break;
      const id = el.dataset.id;
      const cur = (v.me?.cards || []).map((c) => c.id);
      let next;
      if (cur.includes(id)) next = cur.filter((x) => x !== id);
      else if (cur.length >= 3) { toast('اخترت 3 فقط — أزل واحدة أولاً', 'err'); break; } else next = [...cur, id];
      SFX.click();
      v.me.cards = next.map((x) => (v.cardChoices || []).find((cc) => cc.id === x) || { id: x });
      renderCards(v);
      updateTimerNodes();
      break;
    }
    case 'confirm-cards': {
      if (!v || v.phase !== 'cards') break;
      const ids = (v.me?.cards || []).map((c) => c.id);
      if (ids.length !== 3) { toast('اختر 3 بطاقات', 'err'); break; }
      SFX.lock();
      wsSend({ type: 'pickCards', cards: ids });
      break;
    }

    case 'set': openKeypadSheet(Number(el.dataset.i)); break;
    case 'set-value': {
      const sheet = S.sheet;
      if (!sheet || sheet.kind !== 'keypad') break;
      const draft = S.draft;
      const usedOthers = draft.reduce((s, x) => s + x, 0) - (draft[sheet.index] || 0);
      const val = Number(el.dataset.n);
      if (usedOthers + val > v.me.energy) break;
      draft[sheet.index] = val;
      SFX.click();
      closeSheet();
      refreshAllocateNumbers();
      vibrate(10);
      break;
    }
    case 'lock': {
      if (!v || v.phase !== 'allocate' || v.me.locked) break;
      const used = S.draft.reduce((s, x) => s + x, 0);
      if (used !== v.me.energy) { toast('وزّع كل الطاقة أولاً', 'err'); break; }
      SFX.lock();
      vibrate(20);
      wsSend({ type: 'lock', alloc: S.draft.slice() });
      break;
    }
    case 'open-cards': openCardsSheet(); break;
    case 'choose-card': {
      const flow = S.cardFlow;
      if (!flow || !v) break;
      const card = (v.me.cards || []).find((c) => c.id === el.dataset.id);
      if (!card) break;
      flow.card = card;
      flow.target = {};
      flow.step = 'tile';
      SFX.click();
      openCardTargetSheet();
      break;
    }
    case 'target-tile': {
      const flow = S.cardFlow;
      if (!flow) break;
      flow.target.tile = Number(el.dataset.i);
      if (flow.card.target === 'tilePlayer') {
        flow.step = 'player';
        openCardTargetSheet();
      } else {
        sendActivate(flow.card.id, flow.target);
      }
      break;
    }
    case 'target-player': {
      const flow = S.cardFlow;
      if (!flow) break;
      flow.target.playerId = el.dataset.id;
      sendActivate(flow.card.id, flow.target);
      break;
    }
    case 'back-to-cards': openCardsSheet(); break;
    case 'close-sheet': closeSheet(); break;

    case 'emote': {
      const now = Date.now();
      if (now - S.lastEmote < 1000) { toast('مهلاً — واحد في الثانية', 'err'); break; }
      S.lastEmote = now;
      wsSend({ type: 'emote', emoji: el.dataset.emoji });
      floatEmote(el.dataset.emoji, v?.me?.seat || 0);
      SFX.click();
      break;
    }
    case 'skip-reveal': skipReveal(); break;
    case 'revenge': wsSend({ type: 'revenge' }); break;
    case 'close-modal': {
      const modal = overlayRoot.querySelector('.modal');
      if (modal) modal.remove();
      break;
    }
    default: break;
  }
});

function sendActivate(cardId, target) {
  SFX.lock();
  vibrate(15);
  wsSend({ type: 'activate', card: cardId, target });
  closeSheet();
}

function shareLink() {
  const v = S.view;
  if (!v) return;
  const url = `${location.origin}${location.pathname}?room=${v.code}`;
  const text = `تعال نلعب معركة الطاقة! رمز الغرفة: ${v.code}`;
  if (navigator.share) {
    navigator.share({ title: 'معركة الطاقة', text, url }).catch(() => {});
    return;
  }
  const done = () => toast('نُسخ الرابط ✅', 'good');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast(text); }
  ta.remove();
}

/* ------------------------------------------------------------------ */
/* كيف تلعب؟                                                          */
/* ------------------------------------------------------------------ */

function openHowTo() {
  overlayRoot.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <button class="btn btn-ghost btn-small" data-action="close-modal">✕</button>
        <h2>كيف تلعب؟</h2>
      </div>
      <div class="ex-box">
        <div class="bold">مثال: 3 لاعبين على مربع قيمته 5</div>
        <div class="row" style="justify-content:space-around">
          <div class="center"><div class="rv-value" style="margin:0 auto">5</div><div class="tiny dim">قيمة المربع</div></div>
        </div>
        <div class="small">
          عمر وضع <b>4</b> طاقة، سارة وضعت <b>4</b>، أنت وضعت <b>2</b>.
          أعلى طاقة 4 مناصفةً ← التعادل يُحسم لصاحب <b>أقل نقاط</b> في الترتيب.
          إن تساوت نقاطهما يضيع المربع (حركة تصادم).
        </div>
      </div>
      <div class="ex-box small">
        <div class="bold">كل جولة</div>
        <div>• تملك 10 طاقة توزّعها سراً على المربعات (وفرة = 14).</div>
        <div>• على كل مربع: أعلى طاقة يفوز بقيمته.</div>
        <div>• الطاقة لا تُرحَّل: كل جولة تبدأ من جديد.</div>
        <div>• المؤقت 25 ثانية في الجولة الأولى ثم 20، ينتهي مبكراً إذا قفل الجميع.</div>
        <div>• الأخير في الترتيب يأخذ +3 طاقة في الجولة التالية.</div>
      </div>
      <div class="ex-box small">
        <div class="bold">الحدث (لافتة بداية الجولة)</div>
        <div>عادي 40% · ذهبي 20% (قيمة أعلى مربع ×2) · مقلوب 20% (الأقل يفوز) · وفرة 20% (14 طاقة).</div>
      </div>
      <div class="ex-box small">
        <div class="bold">البطاقات</div>
        <div>🛡️ الدرع: تفوز بالتعادل على مربع · 🗡️ اللص: خصم يخسر 2 طاقة · 🪤 الفخ: من يضع 6+ على المربع يخسر 3 نقاط · ✖️2 المضاعف: قيمته مضاعفة إن فزت · 🎯 القناص: يُلغي فوز لاعب على مربع.</div>
        <div class="dim tiny">بطاقة واحدة كحد أقصى في الجولة، وكل بطاقة مرة واحدة فقط.</div>
      </div>
      <div class="ex-box small">
        <div class="bold">المباراة</div>
        <div>5 جولات · عدد المربعات = عدد اللاعبين + 1 · أكثر نقاط يفوز (التعادل يتقاسم الفوز).</div>
      </div>
      <button class="btn btn-primary" data-action="close-modal">فهمت</button>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* منع تكبير الصفحة + Wake Lock                                       */
/* ------------------------------------------------------------------ */

let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* المتصفح قد يرفض */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
});
document.addEventListener('pointerdown', () => {
  SFX.ensure();
  if (!wakeLock) requestWakeLock();
}, { once: true });

/* ------------------------------------------------------------------ */
/* الإقلاع                                                            */
/* ------------------------------------------------------------------ */

(function boot() {
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const stored = localStorage.getItem(LS.identity);
  if (stored) {
    try {
      const id = JSON.parse(stored);
      if (id && id.code && id.playerId && id.token) {
        S.identity = id;
        S.name = id.name || '';
      }
    } catch { /* تجاهل */ }
  }

  if (roomParam) {
    if (S.identity && S.identity.code === roomParam) {
      // استعادة الجلسة تلقائياً
    } else {
      S.identity = null;
      localStorage.removeItem(LS.identity);
      S.pendingCode = roomParam;
    }
  } else if (S.identity) {
    S.pendingCode = S.identity.code;
  }

  render();
  connect();
})();

// في حال العودة للصفحة من الخلفية
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !S.ws) connect();
});
