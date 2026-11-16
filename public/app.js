'use strict';
/* ============================================================================
   معركة الطاقة — عميل الهاتف (الإصدار ٢: «ساحة»)
   السيرفر هو المرجع الوحيد للحالة والحساب والمؤقت. هذا الملف يعرض ويرسل النوايا فقط.
   ============================================================================ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const screenEl = document.getElementById('screen');
const sheetRoot = document.getElementById('sheet-root');
const overlayRoot = document.getElementById('overlay-root');
const toastRoot = document.getElementById('toast-root');

const LS = { identity: 'eb_identity', mute: 'eb_mute', tutorial: 'eb_tutorial' };
const EMOJIS = ['😂', '🔥', '😱', '🤡'];
const COLOR_FALLBACK = ['#38E1FF', '#C084FC', '#BEF264', '#FBBF24', '#8B5CF6'];

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
  mountKey: null,
  sheet: null,
  cardFlow: null,
  revealKey: null,
  revealTimers: [],
  lastEmote: 0,
  muted: localStorage.getItem(LS.mute) === '1',
  offset: 0,
  scores: {},
  habits: {},
};

/* ------------------------------------------------------------------ أدوات */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));

function domAlive() {
  return typeof document !== 'undefined' && !!document && !!document.body;
}

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
  }, 2300);
}

function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* غير مدعوم */ }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------------ الصوت */
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
  tone(freq, dur, type = 'sine', gain = 0.05, slideTo = null, delay = 0) {
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
  noise(dur = 0.16, gain = 0.07, delay = 0, hp = 500) {
    if (S.muted) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'highpass';
    filt.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filt).connect(g).connect(ctx.destination);
    src.start(t0);
  },
  /* سلّم خماسي: كل كرة ترفع النغمة — الإحساس الذي يجعل التوزيع ممتعاً */
  orb(count) {
    const scale = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.7];
    const f = scale[clamp(count - 1, 0, scale.length - 1)];
    this.tone(f, 0.1, 'triangle', 0.05);
    this.tone(f * 2, 0.06, 'sine', 0.018, null, 0.01);
  },
  unplace() { this.tone(300, 0.07, 'triangle', 0.035, 220); },
  click() { this.tone(700, 0.045, 'square', 0.03); },
  clank() {
    this.tone(180, 0.16, 'square', 0.05, 90);
    this.tone(720, 0.09, 'triangle', 0.04, 520, 0.01);
    this.noise(0.12, 0.035, 0, 1200);
  },
  reveal(i = 0) { this.tone(360 + i * 24, 0.1, 'triangle', 0.045, 420 + i * 24); },
  clash() {
    this.noise(0.22, 0.085, 0, 380);
    this.tone(220, 0.26, 'sawtooth', 0.05, 80);
    this.tone(140, 0.2, 'square', 0.035, 60, 0.04);
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.055, null, i * 0.085));
  },
  steal() { this.tone(620, 0.1, 'square', 0.045, 320); this.tone(320, 0.14, 'square', 0.04, 180, 0.09); },
  err() { this.tone(200, 0.11, 'square', 0.045, 140); this.tone(150, 0.13, 'square', 0.04, 110, 0.11); },
};

/* ------------------------------------------------------- نقوش الأراضي (SVG) */
const TERR_TYPES = {
  mine: { label: 'منجم', names: ['منجم الفحم', 'منجم الملح', 'منجم الحديد'] },
  fort: { label: 'حصن', names: ['حصن الحجر', 'حصن الجبل', 'حصن الرمل'] },
  tower: { label: 'برج', names: ['البرج العالي', 'برج النار'] },
};

/* أيقونات الأراضي: أشكال مسطّحة (بلا تعريفات متدرّجة) — حادّة على أي مقاس وبلا تعارض معرّفات */
const TERR_SVG = {
  mine: (gold) => {
    const base = gold ? '#C9902A' : '#3C7C92';
    const hi = gold ? '#FFE3A1' : '#8FD8EA';
    return `<svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M3 41 L18 14 L27 28 L32 19 L45 41 Z" fill="${base}"/>
      <path d="M3 41 L18 14 L23 22 L13 41 Z" fill="${hi}" opacity=".5"/>
      <rect x="19" y="24" width="11" height="4" rx="2" fill="#05080F" opacity=".6"/>
      <path d="M24.5 24 L24.5 11 L36 15.5 L24.5 20" fill="${hi}"/>
      <circle cx="13" cy="42" r="1.6" fill="${hi}" opacity=".8"/>
    </svg>`;
  },
  fort: (gold) => {
    const base = gold ? '#C9902A' : '#41669B';
    const hi = gold ? '#FFE3A1' : '#A8C6F0';
    return `<svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M6 21 h7 v-5 h6 v5 h10 v-5 h6 v5 h7 v20 H6 Z" fill="${base}"/>
      <path d="M6 21 h7 v-5 h6 v5 h10 Z" fill="${hi}" opacity=".45"/>
      <rect x="21" y="30" width="8" height="11" rx="4" fill="#05080F" opacity=".55"/>
      <rect x="11" y="27" width="5" height="5" rx="1" fill="#05080F" opacity=".4"/>
      <rect x="33" y="27" width="5" height="5" rx="1" fill="#05080F" opacity=".4"/>
      <rect x="6" y="39" width="36" height="2" fill="#05080F" opacity=".35"/>
    </svg>`;
  },
  tower: (gold) => {
    const base = gold ? '#C9902A' : '#5A6DBA';
    const hi = gold ? '#FFEFC9' : '#B9C9FF';
    const ac = gold ? '#FFC65C' : '#A78BFA';
    return `<svg viewBox="0 0 48 48" aria-hidden="true">
      <path d="M18 42 V19 h12 v23 Z" fill="${base}"/>
      <path d="M18 42 V19 h5 v23 Z" fill="${hi}" opacity=".35"/>
      <path d="M15 19 L24 5 L33 19 Z" fill="${ac}"/>
      <path d="M15 19 L24 5 L24 19 Z" fill="#fff" opacity=".28"/>
      <rect x="22" y="23" width="4" height="6" rx="2" fill="#05080F" opacity=".6"/>
      <path d="M24 5 V1" stroke="${hi}" stroke-width="1.6" stroke-linecap="round"/>
      <path d="M24 2 L32 4.5 L24 7 Z" fill="${ac}"/>
      <path d="M11 42 h26" stroke="#05080F" stroke-width="2.4" opacity=".45" stroke-linecap="round"/>
    </svg>`;
  },
};

function kindFor(index, total) {
  const ratio = total <= 1 ? 1 : index / (total - 1);
  if (ratio < 0.34) return 'mine';
  if (ratio < 0.7) return 'fort';
  return 'tower';
}

function territoryFor(index, total) {
  const kind = kindFor(index, total);
  const names = TERR_TYPES[kind].names;
  return { kind, name: names[index % names.length] };
}

/* ---------------------------------------------------------------- الشبكة */
function wsSend(obj) {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify(obj));
    return;
  }
  if (Net.mode === 'poll' && Net.sid) {
    sendPoll(obj).catch(() => { pendingOut.push(obj); });
    return;
  }
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
  if (pendingOut.length) {
    const queued = pendingOut.splice(0);
    queued.forEach((m) => wsSend(m));
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
    for (const m of queued) await sendPoll(m); // eslint-disable-line no-await-in-loop
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


/* ------------------------------------------------- أيقونات مرسومة (SVG) */
const CARD_SVG = {
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 3 20 6v6c0 4.4-3.3 7.6-8 9-4.7-1.4-8-4.6-8-9V6l8-3Z"/><path d="M9 12l2.2 2.2L15.5 10" stroke-linecap="round"/></svg>',
  thief: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="M14.5 3.5 20 9l-2 2-1.6-1.6L8 20.6 3.4 16 14 5.1 12.5 3.5l2-0Z"/><path d="M5.5 14.5l4 4"/></svg>',
  trap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><circle cx="12" cy="13" r="7"/><path d="M12 6V3M8 7 6 4.5M16 7l2-2.5M5 13H2.5M19 13h2.5M8 18l-1.5 2.5M16 18l1.5 2.5"/><circle cx="12" cy="13" r="2.2"/></svg>',
  double: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5l6.5 6.5L4 18.5M12.5 5.5L19 12l-6.5 6.5"/></svg>',
  sniper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke-linecap="round"/></svg>',
};
const cardIcon = (id) => CARD_SVG[id] || '';
const timerHtml = () => `<div class="timer">${CLOCK_SVG}<b data-timer>--</b></div>`;

const MUTE_SVG = {
  on: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4 9.5h3.5L13 5v14L7.5 14.5H4z"/><path d="M17 9c1.2 1.6 1.2 4.4 0 6M19.5 6.5c2.2 2.9 2.2 8.1 0 11"/></svg>',
  off: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4 9.5h3.5L13 5v14L7.5 14.5H4z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
};

const CROWN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8Z"/></svg>';
const PEOPLE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.5" r="3.2"/><path d="M2.8 19.5c.5-3.1 3-4.9 6.2-4.9s5.7 1.8 6.2 4.9"/><path d="M16.5 5.6a3.2 3.2 0 0 1 0 6.3M18 14.9c2.2.5 3.6 2.1 4 4.6"/></svg>';
const USER_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.6-3.6 3.6-5.6 7.5-5.6s6.9 2 7.5 5.6"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M2 12s3.8-6 10-6 10 6 10 6-3.8 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>';
const BOT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 13h.01M16 13h.01" stroke-linecap="round"/><path d="M9 17h6" stroke-linecap="round"/></svg>';

/* ------------------------------------------------------------ جدول الرسائل */
function handleMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      S.identity = {
        code: msg.code,
        playerId: msg.playerId,
        token: msg.token,
        name: S.name || (S.identity || {}).name || '',
      };
      if (msg.spectator) S.identity.token = null;
      else saveIdentity();
      S.pendingCode = null;
      if (msg.rejoined) toast('عدت إلى المباراة ✅', 'good');
      render();
      break;
    }
    case 'state': {
      S.offset = (msg.serverNow || Date.now()) - Date.now();
      const prev = S.view;
      S.view = msg;
      if (prev && prev.phase !== msg.phase) onPhaseChange(prev, msg);
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
        setTimeout(() => toast(
          mine ? '🎁 تعويض الأخير: +3 طاقة لك' : `🎁 ${msg.bonusName} أخذ تعويض +3`,
          'good',
        ), 1500);
      }
      break;
    }
    case 'emote': floatEmote(msg.emoji, msg.seat); break;
    default: break;
  }
}

function onPhaseChange(prev, next) {
  if (next.phase === 'end') SFX.win();
  if (next.phase === 'allocate') {
    S.draft = null;
    S.draftRound = null;
  }
  if (next.phase === 'between' && prev.phase === 'reveal') {
    rememberHabits(next);
  }
}

function rememberHabits(v) {
  const rv = v.reveal;
  if (!rv) return;
  const topIndex = rv.tiles.reduce((b, t, i) => (t.value > rv.tiles[b].value ? i : b), 0);
  Object.entries(rv.allocs || {}).forEach(([pid, alloc]) => {
    if (!alloc || !alloc.length) return;
    let max = 0;
    alloc.forEach((x) => { if (x > max) max = x; });
    const focus = alloc.indexOf(max);
    const h = S.habits[pid] || { rounds: 0, top: 0, spread: 0 };
    h.rounds += 1;
    if (focus === topIndex && max > 0) h.top += 1;
    else if (alloc.filter((x) => x > 0).length >= 3) h.spread += 1;
    S.habits[pid] = h;
  });
}

function habitLine(pid, v) {
  const h = S.habits[pid];
  if (!h || !h.rounds) return '';
  const p = v.players.find((x) => x.id === pid);
  if (!p) return '';
  if (h.top >= 2) return `${p.name} يركّز على أكبر مربع (${h.top}/${h.rounds})`;
  if (h.spread >= 2) return `${p.name} يوزّع على عدة مربعات (${h.spread}/${h.rounds})`;
  const h2 = h.top === 1 ? 'مرة واحدة على الأعلى' : 'بلا نمط واضح بعد';
  return `${p.name}: ${h2}`;
}

function showEventBanner(event, desc) {
  if (!domAlive()) return;
  const el = document.createElement('div');
  el.className = `event-banner ${event === 'ذهبي' ? 'gold' : ''}${event === 'مقلوب' ? 'reverse' : ''}`;
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
  el.style.left = `${28 + ((seat ?? 0) * 13) + Math.random() * 14}%`;
  overlayRoot.appendChild(el);
  setTimeout(() => el.remove(), 2100);
}

/* --------------------------------------------------------------- الرسم */
function render() {
  if (!domAlive()) return;
  const v = S.view;
  if (!v || !v.phase) {
    clearRevealTimers();
    S.mountKey = null;
    S.revealKey = null;
    renderHome();
    return;
  }
  if (v.isSpectator) { clearRevealTimers(); S.mountKey = null; renderSpectator(v); return; }
  if (v.phase !== 'reveal') { clearRevealTimers(); S.revealKey = null; }

  switch (v.phase) {
    case 'lobby': S.mountKey = null; renderLobby(v); break;
    case 'cards': S.mountKey = null; renderCards(v); break;
    case 'allocate': renderAllocate(v); break;
    case 'reveal': renderReveal(v); break;
    case 'between': S.mountKey = null; renderBetween(v); break;
    case 'end': S.mountKey = null; renderEnd(v); break;
    default: S.mountKey = null; renderHome();
  }
  updateTimerNodes();
}

function mutedBtn() {
  return `<button class="mute-btn" data-action="toggle-mute" aria-label="كتم الصوت">
    ${S.muted ? MUTE_SVG.off : MUTE_SVG.on}</button>`;
}

function connBanner() {
  if (S.connected) return '';
  return '<div class="conn-banner">انقطع الاتصال… نحاول إعادة الدخول</div>';
}

const colorOf = (p) => p.color || COLOR_FALLBACK[p.seat % 5];

const CARD_NAMES = {
  shield: 'الدرع', thief: 'اللص', trap: 'الفخ', double: 'المضاعف', sniper: 'القناص',
};
const cardName = (id) => CARD_NAMES[id] || id;

function tokenHtml(p, cls = '') {
  return `<span class="token ${cls}" style="--c:${colorOf(p)}">${esc(p.shape || '●')}</span>`;
}

function avatarHtml(p, { me = false } = {}) {
  const locked = !!p.locked;
  const score = S.scores[p.id] ?? p.score;
  return `<div class="avatar ${me ? 'me' : ''} ${locked ? 'locked' : 'thinking'}"
      style="--c:${colorOf(p)}" title="${esc(p.name)}">
      <span class="sh">${esc(p.shape || '●')}</span>
      <span class="sc num">${score}</span>
      <span class="lk">🔒</span>
    </div>`;
}

/* ------------------------------------------------------------- ١) الرئيسية */
function renderHome() {
  screenEl.innerHTML = `
    <div class="screen-inner home">
      <div class="hero">
        <div class="bolt"><svg viewBox="0 0 24 24" fill="none"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"
          fill="#8BF3FF" stroke="#38E1FF" stroke-width="1.2" stroke-linejoin="round"/></svg></div>
        <div class="brand">معركة الطاقة</div>
        <p>عشر كرات طاقة، عدة أراضٍ… وزّعها سراً. الأعلى يفوز بكل أرض</p>
      </div>

      <div class="field">
        <span class="ico">${USER_SVG}</span>
        <input id="name-input" type="text" maxlength="14" placeholder="اسمك" value="${esc(S.name)}"
               autocomplete="off" enterkeyhint="go" />
      </div>

      ${connBanner()}

      <div class="stack">
        <button class="btn btn-primary" data-action="create">أنشئ غرفة</button>
        <div class="divider">أو ادخل برمز</div>
        <div class="field code-field">
          <input id="code-input" type="text" inputmode="latin" maxlength="4" placeholder="رمز الغرفة"
                 value="${esc(S.pendingCode || '')}" autocomplete="off" autocapitalize="characters" />
        </div>
        <button class="btn" data-action="join">ادخل</button>
        <button class="btn btn-ghost" data-action="howto">كيف تلعب؟</button>
      </div>

      <div class="row" style="justify-content:center">${mutedBtn()}</div>
    </div>`;

  const nameInput = $('#name-input');
  if (nameInput) {
    nameInput.addEventListener('input', () => { S.name = nameInput.value; });
    if (!S.pendingCode) nameInput.focus({ preventScroll: true });
  }
  const codeInput = $('#code-input');
  if (codeInput) {
    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    });
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  }
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
  S.name = name;
  wsSend({ type: 'join', code, name });
}

/* ------------------------------------------------------------- ٢) الانتظار */
function renderLobby(v) {
  const isHost = v.me && v.me.isHost;
  const enough = v.players.length >= v.minPlayers;
  const link = `${location.origin}${location.pathname}?room=${v.code}`;
  const seats = [];
  for (let i = 0; i < v.maxPlayers; i += 1) {
    const p = v.players[i];
    if (p) {
      seats.push(`<div class="player-row ${p.isMe ? 'me' : ''}">
        ${tokenHtml(p, 'round')}
        <span class="name grow ellipsis">${esc(p.name)}${p.isMe ? ' <span class="tiny dim">(أنت)</span>' : ''}${p.isBot ? ' · بوت' : ''}</span>
        ${p.isHost ? `<span class="badge-crown">${CROWN_SVG}</span>` : ''}
        ${p.connected ? '' : '<span class="tiny dim">غير متصل</span>'}
      </div>`);
    } else {
      seats.push('<div class="player-row seat-empty">مقعد فارغ</div>');
    }
  }

  screenEl.innerHTML = `
    <div class="screen-inner lobby">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <span class="pill">${PEOPLE_SVG} ${v.players.length}/${v.maxPlayers}</span>
        <div class="row" style="gap:6px">${mutedBtn()}
          <button class="btn btn-ghost btn-small" data-action="howto">؟</button></div>
      </div>

      <div class="code-box">
        <div class="tiny dim">رمز الغرفة</div>
        <div class="code-big">${esc(v.code)}</div>
        <button class="btn btn-small btn-violet" data-action="share">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M8 8l4-4 4 4M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/></svg>
          شارك الرابط</button>
      </div>

      <div class="row" style="justify-content:space-between">
        <span class="section-title">اللاعبون</span>
        <span class="tiny dim">${enough ? 'جاهزون للبدء ✓' : `تحتاج ${v.minPlayers} لاعبين`}</span>
      </div>
      <div class="player-list">${seats.join('')}</div>

      <div class="stack">
        ${isHost
    ? `<button class="btn btn-primary" data-action="start" ${enough ? '' : 'disabled'}>ابدأ المباراة</button>`
    : '<div class="card center small dim">بانتظار المضيف…</div>'}
        <button class="btn btn-ghost" data-action="practice">
          <span class="ico-inline">${BOT_SVG}</span> جرّب مع بوتات</button>
        <button class="btn btn-ghost btn-small" data-action="leave">خروج</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------- ٣) اختيار البطاقات */
function renderCards(v) {
  const chosen = (v.me?.cards || []).map((c) => c.id);
  const list = v.cardChoices || [];
  screenEl.innerHTML = `
    <div class="screen-inner">
      ${connBanner()}
      <div class="cards-head">
        <span class="bold grow">اختر ٣ بطاقات</span>
        ${timerHtml()}
        ${mutedBtn()}
      </div>
      <div class="tiny dim center">بطاقة واحدة في الجولة · استعمالها سري حتى الكشف</div>
      <div class="cards-grid">
        ${list.map((c) => `
          <button class="card-pick ${chosen.includes(c.id) ? 'sel' : ''}" data-action="pick-card" data-id="${c.id}">
            <span class="tick">✓</span>
            <span class="ico">${cardIcon(c.id)}</span>
            <span class="nm">${esc(c.name)}</span>
            <span class="ds">${esc(c.desc)}</span>
          </button>`).join('')}
      </div>
      <div class="pick-dots">
        ${[0, 1, 2].map((i) => `<i class="${i < chosen.length ? 'on' : ''}"></i>`).join('')}
        <span class="tiny dim">${chosen.length}/3</span>
      </div>
      <button class="btn btn-primary" data-action="confirm-cards" ${chosen.length === 3 ? '' : 'disabled'}>
        ${v.me?.cardsConfirmed ? 'جاهز ✓' : 'تأكيد الاختيار'}
      </button>
    </div>`;
}

/* ------------------------------------------------------------- ٤) التوزيع */
function ensureDraft(v) {
  const me = v.me;
  if (!me) return [];
  const n = v.tiles.length;
  if (S.draftRound !== v.round || !Array.isArray(S.draft) || S.draft.length !== n) {
    const base = (me.alloc && me.alloc.slice(0, n)) || [];
    S.draft = Array.from({ length: n }, (_, i) => Number(base[i] || 0));
    S.draftRound = v.round;
  }
  S.draft = S.draft.map((x) => Math.max(0, Math.floor(Number(x) || 0)));
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

function tileRowHtml(t, i, draftVal, territory) {
  const isGolden = t.golden;
  const army = Array.from({ length: draftVal }, (_, k) => `<i class="orb ${isGolden ? 'gold' : ''}" style="animation-delay:${k * 10}ms"></i>`).join('');
  return `<div class="tile-row ${isGolden ? 'golden' : ''} ${draftVal > 0 ? 'has' : ''}" data-tile="${i}">
    <div class="tile-top">
      <div class="t-art">${TERR_SVG[territory.kind](isGolden ? 1 : 0)}</div>
      <div class="t-meta">
        <span class="t-name">${esc(territory.name)}</span>
        <span class="t-val num"><b>${t.value}</b><small>${isGolden ? '×2' : ''}</small></span>
      </div>
      <button class="meter-set" data-action="set" data-i="${i}"
        aria-label="اكتب رقم ${esc(territory.name)}">✎</button>
      <span class="grow"></span>
    </div>
    <div class="tile-bottom">
      <button class="step-btn minus" data-step="-1" data-i="${i}" aria-label="إنقاص" ${draftVal <= 0 ? 'disabled' : ''}>−</button>
      <div class="tile-meter" data-action="add" data-i="${i}" role="button"
           aria-label="أضف كرة إلى ${esc(territory.name)} (${draftVal})">
        <span class="t-inline">
          <span class="t-art">${TERR_SVG[territory.kind](isGolden ? 1 : 0)}</span>
          <b class="num">${t.value}${isGolden ? '×2' : ''}</b>
        </span>
        <span class="cnt num ${draftVal === 0 ? 'zero' : ''}">${draftVal}</span>
        <span class="army" data-val="${draftVal}">${army}</span>
        ${draftVal === 0 ? '<span class="army-empty">كراتك هنا</span>' : ''}
      </div>
      <button class="step-btn" data-step="1" data-i="${i}" aria-label="زيادة">+</button>
    </div>
  </div>`;
}

function buildAllocate(v) {
  const me = v.me;
  const draft = ensureDraft(v);
  const unitEnergy = me.energy;
  const total = draft.reduce((s, x) => s + x, 0);
  const remaining = unitEnergy - total;
  const territories = v.tiles.map((t, i) => territoryFor(i, v.tiles.length));

  screenEl.innerHTML = `
    <div class="screen-inner allocate">
      ${connBanner()}
      <div class="hud">
        <div class="avatars" id="hud-avatars"></div>
        ${timerHtml()}
        ${mutedBtn()}
      </div>
      <div class="progress" id="hud-progress"><i></i></div>
      <div class="cardline">${cardButton(v)}</div>

      <div class="tiles" id="tiles">
        ${v.tiles.map((t, i) => tileRowHtml(t, i, draft[i], territories[i])).join('')}
      </div>

      <div class="well ${remaining === 0 ? 'ready' : ''}" id="well">
        <div class="well-info">
          <div class="well-num"><b data-remaining class="num">${remaining}</b><small>متبقٍ</small></div>
          <div class="tiny dim" data-energy-label>من ${unitEnergy} ⚡</div>
        </div>
        <div class="well-orbs" id="well-orbs" data-action="pour-hint">
          ${Array.from({ length: unitEnergy }, (_, k) => `<i class="orb ${k >= total ? '' : 'spent'}"></i>`).join('')}
        </div>
        <button class="lock-btn ${remaining === 0 ? 'ready' : ''}" data-action="lock" ${remaining === 0 ? '' : 'disabled'}>
          ${remaining === 0 ? 'اقفل ✔' : `وزّع ${remaining}`}
        </button>
      </div>

      <div class="waiting-list" id="alloc-wait" style="display:none"></div>
    </div>`;

  bindStepButtons();
  bindWellDrag();
  maybeTutorial();
}

function cardButton(v) {
  const me = v.me;
  const usable = (me.cards || []).filter((c) => !(me.usedCards || []).includes(c.id));
  if (me.roundCard) {
    return `<span class="card-open-btn used">${cardIcon(me.roundCard.card)} مفعّلة</span>`;
  }
  if (!usable.length) return '<span class="card-open-btn used">لا بطاقات متبقية</span>';
  return `<button class="card-open-btn" data-action="open-cards" ${me.canActivate ? '' : 'disabled'}>
    ${cardIcon(usable[0].id)} بطاقتك · ${usable.length}
  </button>`;
}

function renderAllocate(v) {
  const key = `alloc:${v.matchNo}:${v.round}`;
  if (S.mountKey !== key) {
    S.mountKey = key;
    buildAllocate(v);
  }
  patchAllocate(v);
}

function patchAllocate(v) {
  const me = v.me;
  if (!me) return;
  const draft = ensureDraft(v);
  const total = draft.reduce((s, x) => s + x, 0);
  const remaining = me.energy - total;

  // الشريط العلوي: خصوم + نقاط + حالة القفل
  const avatars = $('#hud-avatars');
  if (avatars) {
    const sig = v.players.map((p) => `${p.id}:${p.score}:${p.locked ? 1 : 0}`).join('|');
    if (avatars.dataset.sig !== sig) {
      const prev = avatars.dataset.sig || '';
      avatars.innerHTML = v.players.map((p) => avatarHtml(p, { me: p.id === me.id })).join('');
      avatars.dataset.sig = sig;
      // نبضة على من قفل للتوّ (بالمقعد، بلا اعتماد على CSS.escape)
      if (prev) {
        const before = prev.split('|');
        v.players.forEach((p, idx) => {
          const now = `${p.id}:${p.score}:${p.locked ? 1 : 0}`;
          if (p.locked && before[idx] && before[idx] !== now) {
            const el = avatars.children[idx];
            if (el) el.classList.add('just-locked');
          }
        });
      }
    }
  }

  const waitList = $('#alloc-wait');
  const tilesEl = $('#tiles');
  const well = $('#well');

  if (me.locked) {
    if (tilesEl) tilesEl.style.display = 'none';
    if (well) well.style.display = 'none';
    const line = $('.cardline');
    if (line) line.style.display = 'none';
    if (waitList) {
      waitList.style.display = 'flex';
      const lockedCount = v.players.filter((p) => p.locked).length;
      waitList.innerHTML = `
        <div class="card center" style="display:flex;flex-direction:column;gap:2px">
          <div class="bold" style="color:#BEF264">قفلت توزيعك ✓</div>
          <div class="tiny dim">الجولة ${v.round} · ${lockedCount}/${v.players.length} قفلوا</div>
        </div>
        ${v.players.map((p) => `
          <div class="wait-row ${p.locked ? 'ok' : ''}">
            ${tokenHtml(p, 'round')}
            <span class="grow ellipsis">${esc(p.name)}${p.id === me.id ? ' (أنت)' : ''}${p.botPlayed ? ' · بوت' : ''}</span>
            <span>${p.locked ? '🔒' : '⏳'}</span>
          </div>`).join('')}
        <div class="tiny dim center">تُكشف كل الاختيارات معاً بعد قفل الجميع</div>`;
    }
    return;
  }

  if (tilesEl) tilesEl.style.display = '';
  if (well) { well.style.display = ''; well.classList.toggle('ready', remaining === 0); }
  if (waitList) waitList.style.display = 'none';

  const remEl = $('[data-remaining]');
  if (remEl) remEl.textContent = String(remaining);
  const energyLabel = $('[data-energy-label]');
  if (energyLabel) energyLabel.textContent = `من ${me.energy} ⚡${me.bonus ? ' (+3 تعويض)' : ''}`;

  const orbs = $('#well-orbs');
  if (orbs) {
    if (orbs.children.length !== me.energy) {
      orbs.innerHTML = Array.from({ length: me.energy }, () => '<i class="orb"></i>').join('');
    }
    Array.from(orbs.children).forEach((el, k) => {
      el.classList.toggle('spent', k < total);
    });
  }

  draft.forEach((val, i) => {
    const row = $(`.tile-row[data-tile="${i}"]`);
    if (!row) return;
    row.classList.toggle('has', val > 0);
    const army = row.querySelector('.army');
    const cnt = row.querySelector('.cnt');
    const empty = row.querySelector('.army-empty');
    if (empty) empty.style.display = val === 0 ? '' : 'none';
    if (army && Number(army.dataset.val || -1) !== val) {
      const golden = row.classList.contains('golden');
      army.innerHTML = Array.from({ length: val }, (_, k) => `<i class="orb ${golden ? 'gold' : ''}" style="animation-delay:${k * 10}ms"></i>`).join('');
      army.dataset.val = String(val);
    }
    if (cnt) {
      cnt.textContent = String(val);
      cnt.classList.toggle('zero', val === 0);
    }
    const minus = row.querySelector('[data-step="-1"]');
    if (minus) minus.disabled = val <= 0;
    const plus = row.querySelector('[data-step="1"]');
    if (plus) plus.disabled = remaining <= 0;
  });

  const lock = $('[data-action="lock"]');
  if (lock) {
    lock.disabled = remaining !== 0;
    lock.classList.toggle('ready', remaining === 0);
    lock.textContent = remaining === 0 ? 'اقفل ✔' : `وزّع ${remaining}`;
  }

  const cardline = $('.cardline');
  if (cardline) {
    cardline.style.display = '';
    const html = cardButton(v);
    if (cardline.innerHTML.trim() !== html.trim()) cardline.innerHTML = html;
  }
}

function bindStepButtons() {
  $$('[data-step]', screenEl).forEach((btn) => {
    const step = Number(btn.dataset.step);
    const i = Number(btn.dataset.i);
    let hold = null;
    let rep = null;
    const apply = (silent = false) => {
      const v = S.view;
      if (!v || v.phase !== 'allocate' || v.me.locked) return;
      const used = S.draft.reduce((s, x) => s + x, 0);
      if (step > 0) {
        if (used >= v.me.energy) { stop(); return; }
        S.draft[i] += 1;
        if (!silent) SFX.orb(used + 1);
      } else {
        if (S.draft[i] <= 0) { stop(); return; }
        S.draft[i] -= 1;
        if (!silent) SFX.unplace();
      }
      patchAllocate(v);
      vibrate(7);
      if (step > 0 && used + 1 >= v.me.energy) { vibrate([10, 36, 16]); stop(); }
    };
    const start = (e) => {
      e.preventDefault();
      apply();
      hold = setTimeout(() => { rep = setInterval(() => apply(true), 80); }, 380);
    };
    const stop = () => {
      if (hold) clearTimeout(hold);
      if (rep) clearInterval(rep);
      hold = null;
      rep = null;
    };
    btn.addEventListener('pointerdown', start);
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  });
}

/* سحب كرة من البئر إلى الأرض — يعمل بالإصبع، مع بقاء النقر بديلاً */
function bindWellDrag() {
  const orbs = $('#well-orbs');
  if (!orbs) return;
  let ghost = null;
  let dragging = false;

  const onDown = (e) => {
    const v = S.view;
    if (!v || v.phase !== 'allocate' || v.me.locked) return;
    const used = S.draft.reduce((s, x) => s + x, 0);
    if (used >= v.me.energy) { toast('وزّعت كل طاقتك', 'err'); return; }
    dragging = true;
    orbs.setPointerCapture?.(e.pointerId);
    ghost = document.createElement('i');
    ghost.className = 'orb';
    ghost.style.cssText = `position:fixed;z-index:75;width:16px;height:16px;left:${e.clientX - 8}px;top:${e.clientY - 8}px;pointer-events:none`;
    document.body.appendChild(ghost);
  };
  const onMove = (e) => {
    if (!dragging || !ghost) return;
    ghost.style.left = `${e.clientX - 8}px`;
    ghost.style.top = `${e.clientY - 8}px`;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    $$('.tile-row', screenEl).forEach((r) => r.classList.remove('drop-hover'));
    el?.closest('.tile-row')?.classList.add('drop-hover');
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    ghost?.remove();
    ghost = null;
    $$('.tile-row', screenEl).forEach((r) => r.classList.remove('drop-hover'));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el?.closest('.tile-row');
    if (!row) return;
    const i = Number(row.dataset.tile);
    const v = S.view;
    const used = S.draft.reduce((s, x) => s + x, 0);
    if (used >= v.me.energy) return;
    S.draft[i] += 1;
    SFX.orb(used + 1);
    vibrate(9);
    patchAllocate(v);
    row.classList.add('pop');
    setTimeout(() => row.classList.remove('pop'), 240);
  };
  orbs.addEventListener('pointerdown', onDown);
  orbs.addEventListener('pointermove', onMove);
  orbs.addEventListener('pointerup', onUp);
  orbs.addEventListener('pointercancel', onUp);
}

function maybeTutorial() {
  if (!domAlive()) return;
  if (localStorage.getItem(LS.tutorial) === '1') return;
  localStorage.setItem(LS.tutorial, '1');
  const texts = ['اضغط الأرض لتضع كرة', 'الأعلى طاقة يفوز بقيمتها', 'التساوي يضيّع الأرض'];
  const box = document.createElement('div');
  box.className = 'bubbles';
  overlayRoot.appendChild(box);
  texts.forEach((t, i) => {
    setTimeout(() => {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = t;
      box.appendChild(b);
      setTimeout(() => b.remove(), 1900);
      if (i === texts.length - 1) setTimeout(() => box.remove(), 2100);
    }, i * 2000);
  });
}

/* ---------------------------------------------------------------- ٥) الكشف */
function clearRevealTimers() {
  (S.revealTimers || []).forEach((t) => clearTimeout(t));
  S.revealTimers = [];
}

function renderReveal(v) {
  const rv = v.reveal;
  if (!rv) { screenEl.innerHTML = '<div class="screen-inner center dim">…</div>'; return; }
  const key = `reveal|${v.matchNo}|${v.round}`;
  if (S.revealKey === key) return;
  clearRevealTimers();
  S.revealKey = key;
  S.mountKey = null;

  const players = v.players;
  const byId = (id) => players.find((p) => p.id === id) || { name: '؟', color: '#888', shape: '●' };
  const meId = v.me?.id;

  // نتيجة كل أرض بترتيب القيم تصاعدياً (كما يصل من السيرفر)
  const rows = rv.tiles.map((t) => {
    const idx = t.index;
    const terr = territoryFor(idx, rv.tiles.length);
    const totalE = Object.values(t.energies).reduce((s, x) => s + x, 0) || 1;
    const segs = players
      .filter((p) => (t.energies[p.id] || 0) > 0)
      .map((p) => `<span style="width:0;background:${colorOf(p)}" data-w="${((t.energies[p.id] || 0) / totalE) * 100}"></span>`)
      .join('');
    const chips = players.map((p) => {
      const e = t.energies[p.id] || 0;
      const win = t.winnerId === p.id;
      return `<span class="rv-chip ${win ? 'win' : ''}" style="${e ? '' : 'opacity:.35'}">
        <span class="sh" style="color:${colorOf(p)}">${esc(p.shape)}</span>${esc(p.name)} ${e}${win ? ' 👑' : ''}
      </span>`;
    }).join('');
    let label = 'لا أحد';
    let labelCls = '';
    if (t.winnerId) { label = `${byId(t.winnerId).name} +${t.value}`; labelCls = 'win'; }
    else if (t.decidedBy === 'annulled') { label = 'تصادم — ضاعت'; labelCls = 'lose'; }
    else if (t.decidedBy === 'sniper') { label = '🎯 أُلغي الفوز'; labelCls = 'lose'; }
    return `<div class="reveal-tile ${t.golden ? 'golden' : ''} ${t.collision ? 'collision' : ''}"
        data-reveal-row="${idx}" data-winner="${t.winnerId || ''}">
      <div class="rv-head">
        <div class="rv-art">${TERR_SVG[terr.kind](t.golden ? 1 : 0)}</div>
        <div class="rv-value ${t.golden ? 'golden' : ''} num">${t.value}</div>
        <div class="rv-seg">${segs}</div>
        <div class="rv-label ${labelCls}">
          ${t.winnerId ? `<span class="flag" style="--c:${colorOf(byId(t.winnerId))}"><i class="pole"></i><i class="pen"></i></span>` : ''}
          <span>${esc(label)}</span>
        </div>
      </div>
      <div class="rv-players">${chips}${t.doubled ? '<span class="rv-chip">×2 مضاعف</span>' : ''}</div>
    </div>`;
  }).join('');

  screenEl.innerHTML = `
    <div class="screen-inner reveal-screen">
      ${connBanner()}
      <div class="hud">
        <div class="avatars" id="hud-avatars"></div>
        <span class="pill">الجولة ${v.round}/${v.rounds}</span>
        ${timerHtml()}
        <button class="btn btn-ghost btn-small" data-action="skip-reveal" id="skip-btn"
          style="display:none">تخطّي</button>
      </div>
      <div class="progress" id="hud-progress"><i></i></div>
      <div class="reveal-list" id="reveal-list">${rows}</div>
      <div class="emote-bar">
        ${EMOJIS.map((e) => `<button class="emote-btn" data-action="emote" data-emoji="${e}">${e}</button>`).join('')}
        ${mutedBtn()}
      </div>
    </div>`;

  // شريط النقاط يعرض نقاط ما قبل الجولة ثم يتصاعد
  S.scores = {};
  players.forEach((p) => {
    S.scores[p.id] = rv.perPlayer[p.id]?.scoreBefore ?? p.score;
  });
  refreshRevealAvatars(v);

  const rowEls = $$('[data-reveal-row]', screenEl);
  const step = 1200;
  rowEls.forEach((row, order) => {
    const t = rv.tiles[order];
    const tm = setTimeout(() => {
      row.classList.add('show');
      $$('.rv-seg span', row).forEach((s) => { s.style.width = `${s.dataset.w}%`; });
      SFX.reveal(order);
      if (t.winnerId) {
        row.classList.add('winner-glow');
        const pts = document.createElement('div');
        pts.className = 'float-points';
        pts.textContent = `+${t.value}`;
        row.appendChild(pts);
        setTimeout(() => pts.remove(), 1200);
        const after = rv.perPlayer[t.winnerId]?.scoreBefore ?? 0;
        S.scores[t.winnerId] = after + t.value - (rv.perPlayer[t.winnerId]?.trapLoss ? 0 : 0);
        refreshRevealAvatars(v);
        vibrate(14);
      }
      if (t.collision) {
        row.classList.add('clash');
        SFX.clash();
        vibrate([26, 46, 26]);
      }
      if (t.sniper) SFX.steal();
      if (order === 0) {
        const skip = $('#skip-btn');
        if (skip) skip.style.display = '';
      }
      if (order === rowEls.length - 1) {
        // النقاط النهائية بعد كل الآثار (فخ/مضاعف)
        setTimeout(() => {
          players.forEach((p) => {
            S.scores[p.id] = rv.perPlayer[p.id]?.scoreAfter ?? p.score;
          });
          refreshRevealAvatars(v);
        }, 420);
      }
    }, order * step + 60);
    S.revealTimers.push(tm);
  });
}

function refreshRevealAvatars(v) {
  const el = $('#hud-avatars');
  if (!el) return;
  el.innerHTML = v.players.map((p) => avatarHtml(p, { me: p.id === v.me?.id })).join('');
}

function skipReveal() {
  clearRevealTimers();
  const v = S.view;
  const rv = v?.reveal;
  $$('[data-reveal-row]', screenEl).forEach((row, order) => {
    row.classList.add('show');
    if (rv && rv.tiles[order]?.winnerId) row.classList.add('winner-glow');
    $$('.rv-seg span', row).forEach((s) => { s.style.width = `${s.dataset.w}%`; });
  });
  if (rv) {
    v.players.forEach((p) => {
      S.scores[p.id] = rv.perPlayer[p.id]?.scoreAfter ?? p.score;
    });
    refreshRevealAvatars(v);
  }
  SFX.click();
}

/* -------------------------------------------------------- ٦) بين الجولات */
function renderBetween(v) {
  const b = v.between || {};
  const st = b.standings || v.standings || [];
  const rv = v.reveal;
  const topIndex = rv ? rv.tiles.reduce((bi, t, i) => (t.value > rv.tiles[bi].value ? i : bi), 0) : -1;
  const habits = v.players
    .filter((p) => p.id !== v.me?.id)
    .map((p) => habitLine(p.id, v))
    .filter(Boolean)
    .slice(0, 3);

  screenEl.innerHTML = `
    <div class="screen-inner">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <span class="bold">انتهت الجولة ${v.round}</span>
        ${timerHtml()}
      </div>
      ${b.bonusName ? `<div class="card center small" style="padding:9px">
        <b style="color:#BEF264">🎁 ${esc(b.bonusName)}</b> يأخذ تعويض الأخير +${b.bonusAmount}
      </div>` : ''}

      <div class="standings">
        ${st.map((row) => {
    const p = v.players.find((x) => x.id === row.id) || row;
    return `<div class="stand-row ${row.rank === 1 ? 'lead' : ''} ${row.id === v.me?.id ? 'me' : ''}">
          <span class="stand-rank">${row.rank}</span>
          ${tokenHtml(p, 'round')}
          <span class="grow ellipsis">${esc(row.name)}${row.id === v.me?.id ? ' (أنت)' : ''}${row.isBot ? ' · بوت' : ''}</span>
          ${row.id === b.bonusTo ? '<span class="bonus-badge">+3</span>' : ''}
          <span class="stand-score num">${row.score}</span>
        </div>`;
  }).join('')}
      </div>

      ${rv ? `<div class="card small" style="padding:10px">
        <div class="section-title">خريطة الجولة — أين وضعوا طاقتهم</div>
        <div class="map">
          ${rv.tiles.map((t, i) => {
    const totalE = Object.values(t.energies).reduce((s, x) => s + x, 0) || 1;
    return `<div class="map-row">
              <span class="map-val ${i === topIndex ? 'bold' : ''}" style="${i === topIndex ? 'color:#FFC65C' : ''}">${t.value}</span>
              <div class="map-bars">
                ${v.players.filter((p) => (t.energies[p.id] || 0) > 0).map((p) => `<i style="width:${((t.energies[p.id] || 0) / totalE) * 100}%;background:${colorOf(p)}"></i>`).join('')}
              </div>
            </div>`;
  }).join('')}
        </div>
        ${habits.length ? `<div class="habit" style="margin-top:6px"><span class="eye">${EYE_SVG}</span> ${esc(habits[0])}</div>` : ''}
      </div>` : ''}

      <div class="emote-bar">
        ${EMOJIS.map((e) => `<button class="emote-btn" data-action="emote" data-emoji="${e}">${e}</button>`).join('')}
        ${mutedBtn()}
      </div>
    </div>`;
}

/* ------------------------------------------------------------- ٧) النهاية */
function renderEnd(v) {
  const e = v.end;
  if (!e) return;
  const st = e.standings || [];
  const meId = v.me?.id;
  const mySummary = e.summary?.[meId];
  const myH2H = e.h2h?.[meId] || [];
  const votes = (e.revengeVotes || []).length;
  const winnerNames = e.winners.map((id) => (st.find((s) => s.id === id) || {}).name).filter(Boolean);
  const top = st.slice(0, 3);
  const order = [1, 0, 2].filter((i) => top[i]);
  const heights = [58, 78, 44];

  screenEl.innerHTML = `
    <div class="screen-inner end-screen">
      ${connBanner()}
      <div class="center">
        <div class="tiny dim">${e.winners.length > 1 ? 'تعادل في القمة' : 'الفائز'}</div>
        <div class="bold" style="font-size:18px;color:#FFC65C">${esc(winnerNames.join(' و '))}</div>
      </div>

      <div class="podium">
        ${order.map((i, k) => {
    const row = top[i];
    const p = v.players.find((x) => x.id === row.id) || row;
    return `<div class="pod">
            <div class="nm">${esc(row.name)}</div>
            <div class="ttl">${esc(e.titles[row.id] || '')}</div>
            <div class="cap" style="--c:${colorOf(p)};height:${heights[k]}px">${row.score}</div>
          </div>`;
  }).join('')}
      </div>

      <div class="titles">
        ${st.map((row) => {
    const p = v.players.find((x) => x.id === row.id) || row;
    return `<div class="title-row">
          ${tokenHtml(p, 'round')}
          <span class="grow ellipsis bold small">${esc(row.name)}${row.id === meId ? ' (أنت)' : ''}</span>
          <span class="title-chip">${esc(e.titles[row.id] || '')}</span>
          <span class="stand-score num">${row.score}</span>
        </div>`;
  }).join('')}
      </div>

      ${mySummary ? `<div class="card small" style="padding:10px">
        <div class="section-title">ملخصك</div>
        <div>ركّزت على أكبر مربع <b>${mySummary.focusedTopTile}</b> مرات.</div>
        <div class="dim tiny">أراضٍ فزت بها ${mySummary.tilesWon} · تصادمات ${mySummary.collisions} · خسارة من فخاخ ${mySummary.trapLoss}</div>
        ${mySummary.cardsUsed?.length ? `<div class="dim tiny">بطاقات استعملتها: ${esc(mySummary.cardsUsed.map(cardName).join(' · '))}</div>` : ''}
      </div>` : ''}

      ${myH2H.length ? `<div class="card small" style="padding:10px">
        <div class="section-title">مواجهات الغرفة</div>
        <div class="h2h-table">
          ${myH2H.map((r) => `<div class="h2h-row"><span class="ellipsis">${esc(r.name)}</span>
            <span class="nowrap">أنت ${r.w} · ${esc(r.name)} ${r.l}${r.d ? ` · تعادل ${r.d}` : ''}</span></div>`).join('')}
        </div>
      </div>` : ''}

      <div class="stack">
        <button class="btn btn-primary" data-action="revenge">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/></svg>
          ثأر ${votes ? `(${votes}/3)` : ''}</button>
        <button class="btn btn-ghost btn-small" data-action="leave">خروج</button>
      </div>
    </div>`;
}

/* --------------------------------------------------------------- المتفرج */
function renderSpectator(v) {
  const st = v.standings || [];
  screenEl.innerHTML = `
    <div class="screen-inner">
      ${connBanner()}
      <div class="row" style="justify-content:space-between">
        <span class="pill" style="color:var(--vi)">${EYE_SVG} متفرج · ${esc(v.code)}</span>
        ${mutedBtn()}
      </div>
      <div class="spectate-note">المباراة جارية — مشاهدة فقط</div>
      ${v.phase === 'allocate' ? '<div class="card center small dim">اللاعبون يوزّعون طاقتهم سراً…</div>' : ''}
      ${v.phase === 'reveal' && v.reveal ? `<div class="reveal-list scroll">
        ${v.reveal.tiles.map((t) => `<div class="card small" style="padding:9px">
          <div class="row"><div class="rv-value ${t.golden ? 'golden' : ''} num">${t.value}</div>
            <span class="small grow">${t.winnerId ? `يفوز ${esc((v.players.find((p) => p.id === t.winnerId) || {}).name || '')} +${t.value}` : 'لا أحد'}</span></div>
        </div>`).join('')}</div>` : ''}
      ${st.length ? `<div class="standings">
        ${st.map((row) => `<div class="stand-row"><span class="stand-rank">${row.rank}</span>
          <span class="grow ellipsis">${esc(row.name)}</span><span class="stand-score num">${row.score}</span></div>`).join('')}
      </div>` : ''}
    </div>`;
}

/* --------------------------------------------------- المؤقت (عرض السيرفر) */
const PHASE_MAX = {
  cards: 15000, allocate: 25000, between: 3000, reveal: 14000, end: 0, lobby: 0,
};

function updateTimerNodes() {
  if (!domAlive()) return;
  const v = S.view;
  const timerNodes = $$('[data-timer]');
  const bar = $('#hud-progress > i');
  if (!v || !v.deadline) {
    timerNodes.forEach((n) => { n.textContent = '--'; });
    if (bar) bar.style.width = '0%';
    return;
  }
  const remain = Math.max(0, v.deadline - (Date.now() + S.offset));
  const s = secs(remain);
  timerNodes.forEach((n) => {
    n.textContent = String(s);
    n.closest('.timer')?.classList.toggle('urgent', remain <= 5000);
  });
  if (bar) {
    const max = v.phase === 'allocate' && v.round === 1 ? 25000 : (PHASE_MAX[v.phase] || 20000);
    bar.style.width = `${clamp((remain / max) * 100, 0, 100)}%`;
    bar.parentElement.classList.toggle('urgent', remain <= 5000);
  }
}

setInterval(() => { try { updateTimerNodes(); } catch { /* صفحة مغلقة */ } }, 250);

/* ------------------------------------------------------- الأوراق السفلية */
function closeSheet() {
  S.sheet = null;
  S.cardFlow = null;
  sheetRoot.innerHTML = '';
}

function openSheet(html) {
  sheetRoot.innerHTML = `<div class="sheet-backdrop" data-action="close-sheet"></div>
    <div class="sheet"><div class="sheet-handle"></div>${html}</div>`;
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
    <div class="sheet-title">بطاقتك — اختر واحدة</div>
    <div class="tiny dim center">تُفعَّل قبل القفل · سريّة حتى الكشف</div>
    <div class="stack">
      ${usable.map((c) => `<button class="pick-card-row" data-action="choose-card" data-id="${c.id}">
        <span class="ico">${cardIcon(c.id)}</span>
        <span class="grow"><span class="bold">${esc(c.name)}</span><span class="ds">${esc(c.desc)}</span></span>
      </button>`).join('')}
    </div>
    <button class="btn btn-ghost btn-small" data-action="close-sheet">إلغاء</button>`);
}

function openCardTargetSheet() {
  const v = S.view;
  const flow = S.cardFlow;
  if (!v || !flow || !flow.card) return;
  const card = flow.card;
  const others = v.players.filter((p) => p.id !== v.me.id);

  if (card.target === 'player') {
    openSheet(`
      <div class="sheet-title">${card.icon} ${esc(card.name)} — اختر خصماً</div>
      <div class="tiny dim center">يخسر ٢ طاقة هذه الجولة ويُعلَم قبل أن يوزّع</div>
      <div class="stack">
        ${others.map((p) => `<button class="pick-card-row" data-action="target-player" data-id="${p.id}">
          ${tokenHtml(p, 'round')}
          <span class="grow bold">${esc(p.name)}${p.isBot ? ' · بوت' : ''}</span>
          <span class="dim small">${p.energy} ⚡</span>
        </button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-small" data-action="back-to-cards">رجوع</button>`);
    return;
  }
  if (flow.step === 'player') {
    openSheet(`
      <div class="sheet-title">${card.icon} — اختر اللاعب المستهدف</div>
      <div class="tiny dim center">إذا فاز بالأرض رقم ${Number(flow.target.tile) + 1} يُلغى فوزه</div>
      <div class="stack">
        ${others.map((p) => `<button class="pick-card-row" data-action="target-player" data-id="${p.id}">
          ${tokenHtml(p, 'round')}<span class="grow bold">${esc(p.name)}</span>
        </button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-small" data-action="back-to-cards">رجوع</button>`);
    return;
  }
  openSheet(`
    <div class="sheet-title">${card.icon} ${esc(card.name)} — اختر أرضاً</div>
    <div class="tiny dim center">${esc(card.desc)}</div>
    <div class="opt-grid">
      ${v.tiles.map((t, i) => {
    const terr = territoryFor(i, v.tiles.length);
    return `<button class="opt" data-action="target-tile" data-i="${t.index}">
        ${t.value}${t.golden ? ' <small>×2</small>' : ''}</button>`;
  }).join('')}
    </div>
    <button class="btn btn-ghost btn-small" data-action="back-to-cards">رجوع</button>`);
}

function openKeypadSheet(index) {
  const v = S.view;
  if (!v || v.phase !== 'allocate' || v.me.locked) return;
  const draft = S.draft;
  const usedOthers = draft.reduce((s, x) => s + x, 0) - (draft[index] || 0);
  const max = Math.min(v.me.energy, v.me.energy - usedOthers);
  const terr = territoryFor(index, v.tiles.length);
  S.sheet = { kind: 'keypad', index };
  const keys = Array.from({ length: v.me.energy + 1 }, (_, n) => n);
  openSheet(`
    <div class="sheet-title">${esc(terr.name)} · قيمته ${v.tiles[index].value}${v.tiles[index].golden ? ' ×2' : ''}</div>
    <div class="val-preview">الطاقة هنا: <b>${draft[index] || 0}</b> — الحد ${max}</div>
    <div class="keypad">
      ${keys.map((n) => `<button class="key ${n === (draft[index] || 0) ? 'sel' : ''}" data-action="set-value"
        data-n="${n}" ${n > max ? 'disabled style="opacity:.3"' : ''}>${n}</button>`).join('')}
    </div>
    <button class="btn btn-primary" data-action="close-sheet">تم</button>`);
}

/* --------------------------------------------------------------- الأحداث */
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
      else if (cur.length >= 3) { toast('اخترت ٣ — أزل واحدة أولاً', 'err'); break; }
      else next = [...cur, id];
      SFX.click();
      v.me.cards = next.map((x) => (v.cardChoices || []).find((cc) => cc.id === x) || { id: x });
      renderCards(v);
      updateTimerNodes();
      break;
    }
    case 'confirm-cards': {
      if (!v || v.phase !== 'cards') break;
      const ids = (v.me?.cards || []).map((c) => c.id);
      if (ids.length !== 3) { toast('اختر ٣ بطاقات', 'err'); break; }
      SFX.clank();
      wsSend({ type: 'pickCards', cards: ids });
      break;
    }

    case 'add': {
      if (!v || v.phase !== 'allocate' || v.me.locked) break;
      const i = Number(el.dataset.i);
      const used = S.draft.reduce((s, x) => s + x, 0);
      if (used >= v.me.energy) { toast('وزّعت كل طاقتك — اضغط − لتعديل', 'err'); break; }
      S.draft[i] += 1;
      SFX.orb(used + 1);
      vibrate(9);
      patchAllocate(v);
      const row = el.closest('.tile-row');
      if (row) { row.classList.add('pop'); setTimeout(() => row.classList.remove('pop'), 240); }
      break;
    }
    case 'set': openKeypadSheet(Number(el.dataset.i)); break;
    case 'set-value': {
      const sheet = S.sheet;
      if (!sheet || sheet.kind !== 'keypad') break;
      const usedOthers = S.draft.reduce((s, x) => s + x, 0) - (S.draft[sheet.index] || 0);
      const val = Number(el.dataset.n);
      if (usedOthers + val > v.me.energy) break;
      S.draft[sheet.index] = val;
      SFX.click();
      closeSheet();
      patchAllocate(v);
      vibrate(10);
      break;
    }
    case 'lock': {
      if (!v || v.phase !== 'allocate' || v.me.locked) break;
      const used = S.draft.reduce((s, x) => s + x, 0);
      if (used !== v.me.energy) { toast('وزّع كل الطاقة أولاً', 'err'); break; }
      SFX.clank();
      vibrate(22);
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
      } else sendActivate(flow.card.id, flow.target);
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
      overlayRoot.querySelector('.modal')?.remove();
      break;
    }
    default: break;
  }
});

function sendActivate(cardId, target) {
  SFX.clank();
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
  } else fallbackCopy(url, done);
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

/* ----------------------------------------------------------- كيف تلعب؟ */
function openHowTo() {
  overlayRoot.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <button class="btn btn-ghost btn-small" data-action="close-modal">✕</button>
        <h2>كيف تلعب؟</h2>
      </div>

      <div class="ex-box">
        <div class="bold">مثال: ٣ لاعبين على أرض قيمتها ٥</div>
        <div class="ex-bars">
          <div class="ex-bar" style="height:70%;background:linear-gradient(180deg,#8FE6FF,#38E1FF)">4</div>
          <div class="ex-bar" style="height:70%;background:linear-gradient(180deg,#E3C8FF,#C084FC)">4</div>
          <div class="ex-bar" style="height:35%;background:linear-gradient(180deg,#E6FFB0,#BEF264)">2</div>
        </div>
        <div class="small">عمر وسارة تعادلا في الأعلى (٤ لكل منهما) — تفوز <b>الأقل نقاطاً</b> في الترتيب.
        وإن تساوت نقاطهما تضيع الأرض (حركة تصادم). أنت وضعت ٢ فلا شيء لك هنا.</div>
      </div>

      <div class="ex-box small">
        <div class="bold">كل جولة</div>
        <div>• معك ١٠ كرات طاقة (وفرة = ١٤)، تتجدد كل جولة ولا تُرحّل.</div>
        <div>• اضغط الأرض لتضع كرة، واسحب من البئر للأرض، أو ＝ لكتابة الرقم.</div>
        <div>• على كل أرض: الأعلى طاقة يفوز بقيمتها المكتوبة عليها.</div>
        <div>• المؤقت ٢٥ ثانية في الأولى ثم ٢٠ — ينتهي مبكراً إذا قفل الجميع.</div>
        <div>• صاحب المركز الأخير يأخذ +٣ طاقة في الجولة التالية.</div>
      </div>

      <div class="ex-box small">
        <div class="bold">الحدث (لافتة بداية الجولة)</div>
        <div>عادي ٤٠٪ · ذهبي ٢٠٪ (قيمة أعلى أرض ×٢) · مقلوب ٢٠٪ (الأقل يفوز) · وفرة ٢٠٪ (١٤ طاقة).</div>
        <div>• درس اللعبة: لا أسلوب واحد ينفع دائماً — غيّر توزيعك كل جولة.</div>
      </div>

      <div class="ex-box small">
        <div class="bold">البطاقات</div>
        <div class="how-cards">
          ${Object.entries({ shield: 'الدرع: تفوز بالتعادل على أرض', thief: 'اللص: خصم يخسر ٢ طاقة هذه الجولة',
    trap: 'الفخ: من يضع ٦+ يخسر ٣ نقاط', double: 'المضاعف: قيمة مضاعفة إن فزت',
    sniper: 'القناص: يُلغي فوز لاعب على أرض' })
    .map(([id, txt]) => `<div class="how-card"><span class="ic">${CARD_SVG[id]}</span><span>${txt}</span></div>`).join('')}
        </div>
        <div class="dim tiny">بطاقة واحدة كحد أقصى في الجولة، وكل بطاقة مرة واحدة في المباراة.</div>
      </div>

      <div class="ex-box small">
        <div class="bold">المباراة</div>
        <div>٥ جولات · عدد الأراضي = عدد اللاعبين + ١ · أعلى مجموع نقاط يفوز (التعادل يتقاسم الفوز).</div>
      </div>

      <button class="btn btn-primary" data-action="close-modal">فهمت</button>
    </div>`;
}

/* --------------------------------------------- منع التكبير + إبقاء الشاشة */
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
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* قد يرفض */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  if (document.visibilityState === 'visible' && !S.ws && Net.mode === 'ws') connect();
});
document.addEventListener('pointerdown', () => {
  SFX.ensure();
  if (!wakeLock) requestWakeLock();
}, { once: true });

/* --------------------------------------------------------------- الإقلاع */
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
    if (!(S.identity && S.identity.code === roomParam)) {
      S.identity = null;
      localStorage.removeItem(LS.identity);
    }
    S.pendingCode = roomParam;
  } else if (S.identity) {
    S.pendingCode = S.identity.code;
  }
  render();
  connect();
})();
