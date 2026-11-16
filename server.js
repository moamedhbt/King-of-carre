'use strict';
/*
 * معركة الطاقة — سيرفر المرجع الوحيد
 * الحالة والحساب والمؤقت كلها هنا. العميل يعرض فقط.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = process.env.PORT || 3000;
// تسريع المؤقتات للاختبارات الآلية فقط (لا يغيّر أي قاعدة)
const FAST = process.env.EB_FAST === '1';
const T = (ms) => (FAST ? Math.max(500, Math.round(ms * 0.12)) : ms);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(__dirname, 'logs');
const MATCH_LOG = path.join(LOG_DIR, 'matches.jsonl');

const COLORS = [
  { name: 'سماوي', hex: '#22d3ee' },
  { name: 'أرجواني', hex: '#c084fc' },
  { name: 'ليموني', hex: '#d9f99d' },
  { name: 'كهرماني', hex: '#fbbf24' },
  { name: 'بنفسجي', hex: '#8b5cf6' },
];
const SHAPES = ['●', '▲', '■', '◆', '★'];
const EMOJIS = ['😂', '🔥', '😱', '🤡'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // بلا I و O (أحرف متشابهة)
const BOT_NAMES = ['بوت نجم', 'بوت صقر', 'بوت ثعلب', 'بوت فهد'];

const rooms = new Map(); // code -> room
let nextPlayerSeq = 1;

/* ------------------------------------------------------------------ */
/* أدوات                                                               */
/* ------------------------------------------------------------------ */

const rid = () => crypto.randomBytes(8).toString('hex');

function makeCode() {
  let code;
  let guard = 0;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    guard += 1;
  } while (rooms.has(code) && guard < 500);
  return code;
}

function cleanName(raw) {
  const n = String(raw ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return n || 'لاعب';
}

function uniqueName(room, base) {
  const taken = new Set(room.players.map((p) => p.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

function freeSeat(room) {
  const used = new Set(room.players.map((p) => p.seat));
  for (let s = 0; s < 5; s += 1) if (!used.has(s)) return s;
  return -1;
}

function newPlayer(room, name, { isBot = false, style = null } = {}) {
  const seat = freeSeat(room);
  if (seat < 0) return null;
  const p = {
    id: `p${nextPlayerSeq++}`,
    token: rid(),
    name: uniqueName(room, name),
    seat,
    isBot,
    style: style || G.BOT_STYLES[seat % G.BOT_STYLES.length],
    socket: null,
    connected: isBot,
    disconnectedAt: null,
    score: 0,
    agg: G.emptyAgg(),
    aggFocused: 0,
    cardsChosen: [],
    usedCards: [],
    roundCard: null,
    alloc: null,
    locked: false,
    energy: 0,
    thiefPenalty: 0,
    bonus: 0,
    botPlayed: false,
    joinedAt: Date.now(),
  };
  room.players.push(p);
  return p;
}

function playersSorted(room) {
  return room.players.slice().sort((a, b) => a.seat - b.seat);
}

function humans(room) {
  return room.players.filter((p) => !p.isBot);
}

function standingsOf(room) {
  const arr = playersSorted(room).map((p) => ({
    id: p.id, name: p.name, seat: p.seat, score: p.score, isBot: p.isBot, connected: p.connected,
  }));
  arr.sort((a, b) => b.score - a.score || a.seat - b.seat);
  let rank = 0;
  let prev = null;
  arr.forEach((row, i) => {
    if (prev === null || row.score !== prev) { rank = i + 1; prev = row.score; }
    row.rank = rank;
  });
  return arr;
}

function send(socket, obj) {
  if (!socket || socket.readyState !== 1) return;
  try { socket.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

function clearRoomTimers(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  (room.botTimers || []).forEach((t) => clearTimeout(t));
  room.botTimers = [];
  if (room.botVoteTimer) clearTimeout(room.botVoteTimer);
  room.botVoteTimer = null;
}

function setPhaseTimer(room, ms, fn) {
  if (room.timer) clearTimeout(room.timer);
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.timer = null;
    try { fn(); } catch (e) { console.error('timer error', e); }
  }, ms);
}

/* ------------------------------------------------------------------ */
/* العرض المُعقَّم لكل لاعب (لا أسرار قبل الكشف)                        */
/* ------------------------------------------------------------------ */

function cardDefPublic(id) {
  const c = G.CARDS[id];
  return c ? { id: c.id, name: c.name, icon: c.icon, target: c.target, desc: c.desc } : null;
}

function viewFor(room, viewer) {
  const isPlayer = viewer && room.players.includes(viewer);
  const inMatch = ['cards', 'allocate', 'reveal', 'between', 'end'].includes(room.phase);
  const publicPlayers = playersSorted(room).map((p) => ({
    id: p.id,
    name: p.name,
    seat: p.seat,
    color: COLORS[p.seat].hex,
    colorName: COLORS[p.seat].name,
    shape: SHAPES[p.seat],
    score: p.score,
    isBot: p.isBot,
    connected: p.connected,
    locked: !!p.locked,
    botPlayed: !!p.botPlayed,
    cardsChosenCount: p.cardsChosen.length,
    isHost: p.id === room.hostId,
    isMe: !!viewer && p.id === viewer.id,
  }));

  const view = {
    type: 'state',
    serverNow: Date.now(),
    code: room.code,
    phase: room.phase,
    round: room.round,
    rounds: G.CONFIG.ROUNDS,
    hostId: room.hostId,
    matchNo: room.matchNo,
    minPlayers: G.CONFIG.MIN_PLAYERS,
    maxPlayers: G.CONFIG.MAX_PLAYERS,
    deadline: room.deadline || null,
    players: publicPlayers,
    standings: inMatch ? standingsOf(room) : [],
    spectators: room.spectators.length,
    event: null,
    eventInfo: null,
    tiles: [],
    me: null,
    isSpectator: !isPlayer,
  };

  if (room.tiles && ['allocate', 'reveal', 'between', 'end'].includes(room.phase)) {
    view.tiles = room.tiles.map((t, index) => ({ index, value: t.value, golden: t.golden }));
    view.event = room.event;
    const info = G.eventInfo(room.event);
    view.eventInfo = { id: info.id, desc: info.desc };
  }

  if (isPlayer) {
    const me = viewer;
    view.me = {
      id: me.id,
      name: me.name,
      seat: me.seat,
      color: COLORS[me.seat].hex,
      shape: SHAPES[me.seat],
      isHost: me.id === room.hostId,
      energy: me.energy,
      alloc: me.alloc ? me.alloc.slice() : null,
      locked: me.locked,
      bonus: me.bonus,
      thiefPenalty: me.thiefPenalty,
      cards: me.cardsChosen.map(cardDefPublic),
      usedCards: me.usedCards.slice(),
      roundCard: me.roundCard ? { card: me.roundCard.card, target: me.roundCard.target } : null,
      canActivate: room.phase === 'allocate' && !me.locked && !me.roundCard
        && me.cardsChosen.some((c) => !me.usedCards.includes(c)),
      cardsConfirmed: me.cardsChosen.length === 3,
      revenge: room.revengeVotes.includes(me.id),
    };
    if (room.phase === 'cards') {
      view.cardChoices = G.CARD_ORDER.map(cardDefPublic);
      view.cardPickTimer = true;
    }
  }

  if (room.phase === 'reveal' || room.phase === 'between' || room.phase === 'end') {
    view.reveal = room.reveal;
  }
  if (room.phase === 'between' && room.betweenInfo) view.between = room.betweenInfo;
  if (room.phase === 'end' && room.endInfo) view.end = room.endInfo;
  return view;
}

function broadcast(room) {
  room.players.forEach((p) => {
    if (p.socket) send(p.socket, viewFor(room, p));
  });
  room.spectators.forEach((s) => send(s.socket, viewFor(room, null)));
}

function sendError(player, message) {
  send(player.socket, { type: 'error', message });
}

function broadcastEvent(room, payload) {
  room.players.forEach((p) => { if (p.socket) send(p.socket, payload); });
  room.spectators.forEach((s) => send(s.socket, payload));
}

/* ------------------------------------------------------------------ */
/* الغرف                                                               */
/* ------------------------------------------------------------------ */

function createRoom() {
  const room = {
    code: makeCode(),
    players: [],
    spectators: [],
    phase: 'lobby',
    hostId: null,
    round: 0,
    matchNo: 0,
    tiles: [],
    event: null,
    prevEvent: null,
    deadline: null,
    timer: null,
    botTimers: [],
    botVoteTimer: null,
    reveal: null,
    betweenInfo: null,
    endInfo: null,
    pendingBonus: null,
    revengeVotes: [],
    h2h: {},
    emptySince: Date.now(),
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function destroyRoom(room) {
  clearRoomTimers(room);
  room.players.forEach((p) => { if (p.socket) { try { p.socket.close(); } catch { /* noop */ } } });
  room.spectators.forEach((s) => { try { s.socket.close(); } catch { /* noop */ } });
  rooms.delete(room.code);
}

function transferHost(room) {
  const host = room.players.find((p) => p.id === room.hostId);
  if (host && !host.isBot && host.connected) return;
  const cands = playersSorted(room).filter((p) => !p.isBot && p.connected);
  room.hostId = cands.length ? cands[0].id : (room.players[0] ? room.players[0].id : null);
}

function markBot(room, player) {
  player.isBot = true;
  player.connected = false;
  player.socket = null;
  transferHost(room);
}

function removePlayer(room, player) {
  room.players = room.players.filter((p) => p !== player);
  room.revengeVotes = room.revengeVotes.filter((id) => id !== player.id);
  transferHost(room);
  if (room.phase === 'lobby') return;
  // في المباراة: يبقى مقعده بوتاً حتى لا تتعطل المباراة، إلا إذا لم يبقَ لاعب بشري
  if (!humans(room).length) { /* تبقى الغرفة للتنظيف */ }
}

/* ------------------------------------------------------------------ */
/* سير المباراة                                                        */
/* ------------------------------------------------------------------ */

function addBots(room, count) {
  for (let i = 0; i < count; i += 1) {
    if (room.players.length >= G.CONFIG.MAX_PLAYERS) break;
    const name = BOT_NAMES[(room.players.length) % BOT_NAMES.length];
    newPlayer(room, uniqueName(room, name), { isBot: true });
  }
}

function startMatch(room) {
  room.matchNo += 1;
  room.round = 0;
  room.pendingBonus = null;
  room.prevEvent = null;
  room.reveal = null;
  room.betweenInfo = null;
  room.endInfo = null;
  room.revengeVotes = [];
  room.tiles = [];
  room.event = null;
  room.players.forEach((p) => {
    p.score = 0;
    p.agg = G.emptyAgg();
    p.aggFocused = 0;
    p.cardsChosen = [];
    p.usedCards = [];
    p.roundCard = null;
    p.alloc = null;
    p.locked = false;
    p.energy = 0;
    p.thiefPenalty = 0;
    p.bonus = 0;
    p.botPlayed = false;
  });
  // بوتات الغرفة العادية تُكمل العدد عند الحاجة (مباراة تستمر بالبوتات)
  if (room.players.length < G.CONFIG.MIN_PLAYERS) addBots(room, G.CONFIG.MIN_PLAYERS - room.players.length);
  room.phase = 'cards';
  room.deadline = null;
  setPhaseTimer(room, T(G.CONFIG.CARD_PICK_MS), () => finishCards(room));
  botPickCards(room);
  broadcast(room);
}

function finishCards(room) {
  room.players.forEach((p) => {
    if (p.cardsChosen.length !== 3) {
      p.cardsChosen = G.shuffle(Math.random, G.CARD_ORDER).slice(0, 3);
    }
  });
  startRound(room, 1);
}

function botPickCards(room) {
  room.players.forEach((p) => {
    if (!p.isBot) return;
    const t = setTimeout(() => {
      if (room.phase !== 'cards' || p.cardsChosen.length === 3) return;
      p.cardsChosen = G.shuffle(Math.random, G.CARD_ORDER).slice(0, 3);
      broadcast(room);
    }, T(1200 + Math.random() * 3500));
    room.botTimers.push(t);
  });
}

function lossBonusTarget(room) {
  const st = standingsOf(room);
  const lowest = st[st.length - 1];
  const tied = st.filter((r) => r.score === lowest.score);
  return G.pickOne(Math.random, tied).id;
}

function startRound(room, roundNo) {
  clearRoomTimers(room);
  room.round = roundNo;
  room.reveal = null;
  room.betweenInfo = null;
  room.endInfo = null;
  room.tiles = G.drawTiles(room.players.length, Math.random);
  room.event = G.drawEvent(roundNo, room.prevEvent, Math.random);
  room.prevEvent = room.event;
  const base = G.baseEnergyForEvent(room.event);
  const bonusTo = roundNo > 1 ? room.pendingBonus : null;

  room.players.forEach((p) => {
    p.bonus = p.id === bonusTo ? G.CONFIG.LOSS_BONUS : 0;
    p.energy = base + p.bonus;
    p.thiefPenalty = 0;
    p.alloc = null;
    p.locked = false;
    p.roundCard = null;
    p.botPlayed = p.isBot || !p.connected;
  });
  room.pendingBonus = null;
  room.phase = 'allocate';
  const ms = roundNo === 1 ? G.CONFIG.FIRST_TIMER_MS : G.CONFIG.TIMER_MS;
  setPhaseTimer(room, T(ms), () => onAllocateTimeout(room));
  scheduleBots(room);
  broadcast(room);
  broadcastEvent(room, {
    type: 'round-start',
    round: roundNo,
    event: room.event,
    eventDesc: G.eventInfo(room.event).desc,
    bonusTo: bonusTo || null,
    bonusName: bonusTo ? (room.players.find((p) => p.id === bonusTo) || {}).name : null,
  });
}

function scheduleBots(room) {
  room.players.filter((p) => p.isBot || !p.connected).forEach((p) => {
    const isAbsentHuman = !p.isBot;
    // اللص: يفعّله البوت أحياناً قبل التوزيع
    if (!isAbsentHuman && Math.random() < 0.45) {
      const usable = p.cardsChosen.filter((c) => !p.usedCards.includes(c));
      if (usable.includes('thief')) {
        const t = setTimeout(() => {
          if (room.phase !== 'allocate' || p.locked || p.roundCard) return;
          const others = room.players.filter((o) => o.id !== p.id);
          if (!others.length) return;
          applyCard(room, p, { card: 'thief', target: { playerId: G.pickOne(Math.random, others).id } });
        }, T(800 + Math.random() * 2200));
        room.botTimers.push(t);
      }
    }
    const delay = 2500 + Math.random() * 8000;
    const t = setTimeout(() => {
      if (room.phase !== 'allocate' || p.locked) return;
      if (!isAbsentHuman && Math.random() < 0.4) {
        const usable = p.cardsChosen.filter((c) => !p.usedCards.includes(c));
        if (usable.length) {
          const card = G.pickOne(Math.random, usable);
          const target = botTargetFor(room, p, card);
          if (target) applyCard(room, p, { card, target });
        }
      }
      const alloc = G.botAllocate(p.style, p.energy, room.tiles, Math.random);
      lockPlayer(room, p, alloc, true);
    }, T(delay));
    room.botTimers.push(t);
  });
}

function botTargetFor(room, bot, card) {
  const tile = G.randInt(Math.random, room.tiles.length);
  if (card === 'thief') {
    const others = room.players.filter((o) => o.id !== bot.id);
    return others.length ? { playerId: G.pickOne(Math.random, others).id } : null;
  }
  if (card === 'sniper') {
    const others = room.players.filter((o) => o.id !== bot.id);
    return others.length ? { tile, playerId: G.pickOne(Math.random, others).id } : null;
  }
  return { tile };
}

function applyCard(room, player, payload) {
  const result = validateCard(room, player, payload);
  if (result.error) return result;
  player.roundCard = { card: payload.card, target: result.target };
  player.usedCards.push(payload.card);
  if (payload.card === 'thief') {
    const victim = room.players.find((p) => p.id === result.target.playerId);
    victim.energy = Math.max(0, victim.energy - G.CONFIG.THIEF_COST);
    victim.thiefPenalty += G.CONFIG.THIEF_COST;
    if (victim.locked && victim.alloc) {
      victim.alloc = G.completeAllocation(victim.alloc, victim.energy, room.tiles.length, Math.random);
    }
    broadcastEvent(room, {
      type: 'thief',
      targetId: victim.id,
      targetName: victim.name,
      amount: G.CONFIG.THIEF_COST,
    });
    broadcast(room);
  }
  return { ok: true };
}

function validateCard(room, player, payload) {
  if (room.phase !== 'allocate') return { error: 'لا يمكن استخدام البطاقة الآن' };
  if (player.locked) return { error: 'قفلت توزيعك، البطاقة تُفعَّل قبل القفل' };
  if (player.roundCard) return { error: 'بطاقة واحدة كحد أقصى في الجولة' };
  const card = String(payload?.card || '');
  if (!G.CARDS[card]) return { error: 'بطاقة غير معروفة' };
  if (!player.cardsChosen.includes(card)) return { error: 'لم تختر هذه البطاقة' };
  if (player.usedCards.includes(card)) return { error: 'استعملت هذه البطاقة سابقاً' };
  const t = payload.target || {};
  const target = {};
  const needTile = ['shield', 'trap', 'double', 'sniper'].includes(card);
  if (needTile) {
    const tile = Number(t.tile);
    if (!Number.isInteger(tile) || tile < 0 || tile >= room.tiles.length) return { error: 'اختر مربعاً صحيحاً' };
    target.tile = tile;
  }
  if (card === 'thief' || card === 'sniper') {
    const other = room.players.find((p) => p.id === t.playerId && p.id !== player.id);
    if (!other) return { error: 'اختر لاعباً صحيحاً' };
    target.playerId = other.id;
  }
  return { target };
}

function trimAlloc(alloc, max) {
  return G.completeAllocation(alloc, max, alloc.length, Math.random);
}

function lockPlayer(room, player, alloc, isBotFill) {
  if (room.phase !== 'allocate' || player.locked) return false;
  const tiles = room.tiles.length;
  if (!Array.isArray(alloc) || alloc.length !== tiles) return false;
  const clean = alloc.map((v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  let sum = clean.reduce((s, v) => s + v, 0);
  if (sum < player.energy) {
    // توزيع ناقص من لاعب حقيقي: لا يُقبل، إلا عند ملء البوت أو انتهاء الوقت
    if (!isBotFill) return false;
    player.alloc = G.completeAllocation(clean, player.energy, tiles, Math.random);
  } else {
    player.alloc = G.completeAllocation(clean, player.energy, tiles, Math.random);
  }
  player.locked = true;
  if (isBotFill && (player.isBot || !player.connected)) player.botPlayed = true;
  maybeResolve(room);
  broadcast(room);
  return true;
}

function connectedHumansPending(room) {
  return room.players.filter((p) => !p.isBot && p.connected && !p.locked);
}

function absentPending(room) {
  const now = Date.now();
  return room.players.filter((p) => {
    if (p.locked) return false;
    if (p.isBot) return false;
    if (p.connected) return false;
    return p.disconnectedAt && (now - p.disconnectedAt) >= T(G.CONFIG.REJOIN_GRACE_MS);
  });
}

function maybeResolve(room) {
  if (room.phase !== 'allocate') return;
  if (room.players.every((p) => p.locked)) { resolveNow(room); return; }
  if (connectedHumansPending(room).length === 0) {
    // كل الحاضرين قفلوا: من غاب بعد المهلة يلعب عنه البوت فوراً
    const absents = absentPending(room);
    if (absents.length && room.players.filter((p) => !p.locked).every((p) => absents.includes(p))) {
      absents.forEach((p) => {
        const alloc = G.absentBotAllocate(p.energy, room.tiles, Math.random);
        p.alloc = G.completeAllocation(alloc, p.energy, room.tiles.length, Math.random);
        p.locked = true;
        p.botPlayed = true;
      });
      resolveNow(room);
    }
  }
}

function onAllocateTimeout(room) {
  if (room.phase !== 'allocate') return;
  room.players.forEach((p) => {
    if (p.locked) return;
    // قاعدة 3.5: الباقي يُوزَّع عشوائياً على ما وضعه اللاعب (أو بالتساوي)
    const energy = p.energy;
    const partial = p.isBot || !p.connected
      ? G.absentBotAllocate(energy, room.tiles, Math.random)
      : (p.alloc || new Array(room.tiles.length).fill(0));
    p.alloc = G.completeAllocation(partial, energy, room.tiles.length, Math.random);
    p.locked = true;
    p.botPlayed = p.botPlayed || p.isBot || !p.connected;
  });
  resolveNow(room);
}

function resolveNow(room) {
  clearRoomTimers(room);
  const players = room.players.map((p) => ({ id: p.id, score: p.score }));
  const allocs = {};
  const cards = {};
  room.players.forEach((p) => {
    allocs[p.id] = p.alloc || new Array(room.tiles.length).fill(0);
    if (p.roundCard) cards[p.id] = { card: p.roundCard.card, target: p.roundCard.target };
  });
  const resolution = G.resolveRound({
    players, tiles: room.tiles, event: room.event, allocs, cards, rng: Math.random,
  });
  const summary = G.roundSummary({
    players, tiles: room.tiles, allocs, resolutions: resolution,
  });

  // تحديث النقاط (بعد ضم الجولة) + إحصاءات الألقاب
  room.players.forEach((p) => {
    const after = resolution.perPlayer[p.id].scoreAfter;
    p.score = after;
    G.mergeAgg({ [p.id]: p.agg }, summary, { [p.id]: after });
    p.aggFocused += summary[p.id].focusedTopTile ? 1 : 0;
  });

  const energyUsed = {};
  room.players.forEach((p) => {
    energyUsed[p.id] = (p.alloc || []).slice();
  });

  room.reveal = {
    round: room.round,
    event: room.event,
    eventDesc: G.eventInfo(room.event).desc,
    tiles: resolution.tiles,
    perPlayer: resolution.perPlayer,
    allocs: energyUsed,
    energies: room.players.reduce((acc, p) => {
      acc[p.id] = p.alloc.slice();
      return acc;
    }, {}),
    cards: room.players.reduce((acc, p) => {
      acc[p.id] = p.roundCard ? { card: p.roundCard.card, target: p.roundCard.target } : null;
      return acc;
    }, {}),
    usedCards: room.players.reduce((acc, p) => { acc[p.id] = p.usedCards.slice(); return acc; }, {}),
    cardsChosen: room.players.reduce((acc, p) => { acc[p.id] = p.cardsChosen.slice(); return acc; }, {}),
    botPlayed: room.players.reduce((acc, p) => { acc[p.id] = !!p.botPlayed; return acc; }, {}),
    thiefHits: room.players.reduce((acc, p) => { acc[p.id] = p.thiefPenalty; return acc; }, {}),
    summary,
  };

  room.phase = 'reveal';
  const revealMs = Math.min(
    room.tiles.length * G.CONFIG.REVEAL_TILE_MS + 1800,
    G.CONFIG.REVEAL_MAX_MS,
  );
  setPhaseTimer(room, T(revealMs), () => endReveal(room));
  broadcast(room);
}

function endReveal(room) {
  const wasLast = room.round >= G.CONFIG.ROUNDS;
  if (!wasLast) room.pendingBonus = lossBonusTarget(room);
  const bonusName = room.pendingBonus
    ? (room.players.find((p) => p.id === room.pendingBonus) || {}).name
    : null;
  room.betweenInfo = {
    standings: standingsOf(room),
    bonusTo: room.pendingBonus,
    bonusName: bonusName || null,
    bonusAmount: G.CONFIG.LOSS_BONUS,
    lastRound: wasLast,
  };
  room.phase = 'between';
  setPhaseTimer(room, T(G.CONFIG.BETWEEN_MS), () => {
    if (wasLast) finishMatch(room);
    else startRound(room, room.round + 1);
  });
  broadcast(room);
}

/* ------------------------------------------------------------------ */
/* هدفيّات الغرفة (جدول المواجهات)                                     */
/* ------------------------------------------------------------------ */

function h2hPair(room, a, b) {
  room.h2h[a] = room.h2h[a] || {};
  room.h2h[a][b] = room.h2h[a][b] || { w: 0, l: 0, d: 0 };
  return room.h2h[a][b];
}

function updateH2H(room) {
  const ps = room.players;
  for (let i = 0; i < ps.length; i += 1) {
    for (let j = i + 1; j < ps.length; j += 1) {
      const a = ps[i].id;
      const b = ps[j].id;
      const rec = h2hPair(room, a, b);
      h2hPair(room, b, a);
      const sa = ps[i].score;
      const sb = ps[j].score;
      if (sa > sb) {
        rec.w += 1;
        room.h2h[b][a].l += 1;
      } else if (sb > sa) {
        rec.l += 1;
        room.h2h[b][a].w += 1;
      } else {
        rec.d += 1;
        room.h2h[b][a].d += 1;
      }
    }
  }
}

function logMatch(room) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const row = {
      at: new Date().toISOString(),
      code: room.code,
      matchNo: room.matchNo,
      rounds: G.CONFIG.ROUNDS,
      players: room.players.map((p) => ({
        score: p.score,
        chosen: p.cardsChosen.slice().sort(),
        used: p.usedCards.slice().sort(),
        bot: p.isBot,
      })),
    };
    fs.appendFileSync(MATCH_LOG, `${JSON.stringify(row)}\n`);
  } catch (e) {
    console.error('log failed', e.message);
  }
}

function finishMatch(room) {
  const standings = standingsOf(room);
  const top = standings[0].score;
  const winners = standings.filter((s) => s.score === top).map((s) => s.id);
  const agg = {};
  room.players.forEach((p) => {
    agg[p.id] = { ...p.agg, score: p.score };
  });
  const titles = G.computeTitles(room.players.map((p) => ({ id: p.id, score: p.score })), agg);
  updateH2H(room);
  logMatch(room);

  room.endInfo = {
    standings,
    winners,
    titles,
    summary: room.players.reduce((acc, p) => {
      acc[p.id] = {
        focusedTopTile: p.aggFocused,
        tilesWon: p.agg.tilesWon,
        minWinningEnergy: p.agg.minWinningEnergy,
        collisions: p.agg.collisions,
        trapLoss: p.agg.trapLoss,
        winsByShield: p.agg.winsByShield,
        cardsChosen: p.cardsChosen.slice(),
        cardsUsed: p.usedCards.slice(),
      };
      return acc;
    }, {}),
    h2h: room.players.reduce((acc, p) => {
      acc[p.id] = playersSorted(room)
        .filter((o) => o.id !== p.id)
        .map((o) => {
          const rec = (room.h2h[p.id] || {})[o.id] || { w: 0, l: 0, d: 0 };
          return { id: o.id, name: o.name, ...rec };
        });
      return acc;
    }, {}),
    revengeVotes: room.revengeVotes.slice(),
    revengeNeeded: 3,
  };
  room.phase = 'end';
  room.deadline = null;
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  broadcast(room);

  // البوتات تصوّت للثأر بعد مهلة قصيرة
  if (room.players.some((p) => p.isBot)) {
    room.botVoteTimer = setTimeout(() => {
      room.botVoteTimer = null;
      if (room.phase !== 'end') return;
      room.players.filter((p) => p.isBot).forEach((p) => {
        if (!room.revengeVotes.includes(p.id)) room.revengeVotes.push(p.id);
      });
      room.endInfo.revengeVotes = room.revengeVotes.slice();
      maybeRevenge(room, true);
      broadcast(room);
    }, T(12000));
  }
}

function maybeRevenge(room, fromBots = false) {
  if (room.phase !== 'end') return;
  if (room.revengeVotes.length < 3) return;
  // من بقي من البشر؟ الأصوات البشرية مطلوبة إن وُجدوا
  const humanVotes = room.revengeVotes.filter((id) => {
    const p = room.players.find((x) => x.id === id);
    return p && !p.isBot && p.connected;
  });
  // لا ثأر تلقائي بلا لاعب بشري واحد على الأقل
  if (!humanVotes.length) return;
  if (!fromBots && humanVotes.length < Math.min(3, humans(room).length)) return;
  room.players = room.players.filter((p) => p.isBot || p.connected);
  if (!room.players.length) return;
  if (room.players.length < G.CONFIG.MIN_PLAYERS) addBots(room, G.CONFIG.MIN_PLAYERS - room.players.length);
  startMatch(room);
}

/* ------------------------------------------------------------------ */
/* الرسائل                                                             */
/* ------------------------------------------------------------------ */

function leaveCurrent(socket) {
  const prevCode = socket._roomCode;
  if (!prevCode) return;
  const room = rooms.get(prevCode);
  socket._playerId = null;
  socket._roomCode = null;
  if (socket._spectator) {
    if (room) room.spectators = room.spectators.filter((x) => x !== socket._spectator);
    socket._spectator = null;
  }
  if (!room) return;
  const pl = room.players.find((p) => p.socket === socket);
  if (pl) {
    if (room.phase === 'lobby') removePlayer(room, pl);
    else markBot(room, pl);
  }
  if (!humans(room).some((p) => p.connected)) room.emptySince = Date.now();
  broadcast(room);
}

function handleCreate(socket, msg) {
  leaveCurrent(socket);
  const room = createRoom();
  const player = newPlayer(room, cleanName(msg.name));
  player.socket = socket;
  player.connected = true;
  socket._playerId = player.id;
  socket._roomCode = room.code;
  room.hostId = player.id;
  room.emptySince = null;
  send(socket, {
    type: 'joined', code: room.code, playerId: player.id, token: player.token, spectator: false,
  });
  broadcast(room);
}

function handleJoin(socket, msg) {
  leaveCurrent(socket);
  const code = String(msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return send(socket, { type: 'error', message: 'الغرفة غير موجودة', fatal: true });
  const name = cleanName(msg.name);
  const inMatch = room.phase !== 'lobby';
  if (inMatch || room.players.length >= G.CONFIG.MAX_PLAYERS) {
    // لا دخول بعد بدء المباراة: متفرج فقط
    const spec = { socket, name, id: `s${nextPlayerSeq++}` };
    room.spectators.push(spec);
    socket._spectator = spec;
    send(socket, { type: 'joined', code: room.code, spectator: true, playerId: null, token: null });
    send(socket, viewFor(room, null));
    socket._roomCode = room.code;
    return undefined;
  }
  const player = newPlayer(room, name);
  player.socket = socket;
  player.connected = true;
  player.disconnectedAt = null;
  socket._playerId = player.id;
  socket._roomCode = room.code;
  if (!room.hostId) room.hostId = player.id;
  room.emptySince = null;
  send(socket, {
    type: 'joined',
    code: room.code,
    playerId: player.id,
    token: player.token,
    spectator: false,
  });
  broadcast(room);
  return undefined;
}

function handleRejoin(socket, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  if (socket._roomCode && socket._roomCode !== code) leaveCurrent(socket);
  const room = rooms.get(code);
  if (!room) return send(socket, { type: 'error', message: 'انتهت الغرفة', fatal: true });
  const player = room.players.find((p) => p.id === msg.playerId && p.token === msg.token);
  if (!player) return send(socket, { type: 'error', message: 'تعذّر استعادة الجلسة', fatal: true });
  if (player.isBot && !player.connected) {
    // مقعد تحوّل إلى بوت بعد مغادرة صريحة
    return send(socket, { type: 'error', message: 'المباراة مستمرة، انضم كمتفرج', fatal: true });
  }
  if (player.socket && player.socket !== socket) {
    try { player.socket.close(); } catch { /* noop */ }
  }
  player.socket = socket;
  player.connected = true;
  player.disconnectedAt = null;
  socket._playerId = player.id;
  socket._roomCode = room.code;
  room.emptySince = null;
  send(socket, {
    type: 'joined',
    code: room.code,
    playerId: player.id,
    token: player.token,
    spectator: false,
    rejoined: true,
  });
  broadcast(room);
  return undefined;
}

function handlePractice(socket, msg) {
  leaveCurrent(socket);
  const room = createRoom();
  const name = cleanName(msg.name);
  const player = newPlayer(room, name);
  player.socket = socket;
  player.connected = true;
  socket._playerId = player.id;
  socket._roomCode = room.code;
  room.hostId = player.id;
  addBots(room, 3);
  room.emptySince = null;
  send(socket, { type: 'joined', code: room.code, playerId: player.id, token: player.token });
  startMatch(room);
}

function onMessage(socket, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!msg || typeof msg.type !== 'string') return;
  const room = socket._roomCode ? rooms.get(socket._roomCode) : null;

  if (msg.type === 'createRoom') return handleCreate(socket, msg);
  if (msg.type === 'join') return handleJoin(socket, msg);
  if (msg.type === 'practice') return handlePractice(socket, msg);
  if (msg.type === 'rejoin') return handleRejoin(socket, msg);
  if (msg.type === 'pong') { socket._alive = true; return undefined; }
  if (!room) return undefined;

  const player = room.players.find((p) => p.id === socket._playerId) || null;
  if (!player) return undefined;

  switch (msg.type) {
    case 'start': {
      if (room.phase !== 'lobby') return sendError(player, 'المباراة بدأت');
      if (player.id !== room.hostId) return sendError(player, 'فقط المضيف يبدأ');
      if (room.players.length < G.CONFIG.MIN_PLAYERS) return sendError(player, 'تحتاج 3 لاعبين على الأقل');
      startMatch(room);
      break;
    }
    case 'addBot': {
      if (room.phase !== 'lobby' || player.id !== room.hostId) return undefined;
      if (room.players.length >= G.CONFIG.MAX_PLAYERS) return sendError(player, 'الغرفة ممتلئة');
      addBots(room, 1);
      broadcast(room);
      break;
    }
    case 'pickCards': {
      if (room.phase !== 'cards') return sendError(player, 'وقت اختيار البطاقات انتهى');
      const cards = Array.isArray(msg.cards) ? msg.cards.filter((c) => G.CARDS[c]) : [];
      if (new Set(cards).size !== 3) return sendError(player, 'اختر 3 بطاقات');
      player.cardsChosen = cards;
      broadcast(room);
      // إذا اختار الجميع نبدأ فوراً
      if (room.players.every((p) => p.cardsChosen.length === 3)) {
        clearRoomTimers(room);
        startRound(room, 1);
      }
      break;
    }
    case 'activate': {
      const res = applyCard(room, player, { card: msg.card, target: msg.target });
      if (res && res.error) sendError(player, res.error);
      else broadcast(room);
      break;
    }
    case 'lock': {
      const ok = lockPlayer(room, player, msg.alloc, false);
      if (!ok) sendError(player, `وزّع كل طاقتك (${player.energy}) ثم اقفل`);
      break;
    }
    case 'emote': {
      if (!EMOJIS.includes(msg.emoji)) return undefined;
      const now = Date.now();
      if (player.lastEmote && now - player.lastEmote < 1000) return undefined;
      player.lastEmote = now;
      broadcastEvent(room, {
        type: 'emote', playerId: player.id, name: player.name, emoji: msg.emoji, seat: player.seat,
      });
      break;
    }
    case 'revenge': {
      if (room.phase !== 'end') return undefined;
      if (!room.revengeVotes.includes(player.id)) room.revengeVotes.push(player.id);
      room.endInfo.revengeVotes = room.revengeVotes.slice();
      maybeRevenge(room);
      broadcast(room);
      break;
    }
    case 'leave': {
      socket._playerId = null;
      if (room.phase === 'lobby') {
        removePlayer(room, player);
      } else {
        markBot(room, player);
      }
      send(socket, { type: 'left' });
      broadcast(room);
      break;
    }
    default:
      break;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* ويب سوكيت                                                           */
/* ------------------------------------------------------------------ */

/* بديل نقل: HTTP طويل الانتظار — نفس منطق الرسائل بالكامل */
const pollSessions = new Map(); // sid -> {session, last, closed}

function createPollSession() {
  const session = {
    readyState: 1,
    queue: [],
    waiter: null,
    _closed: false,
    send(str) {
      if (session._closed) return;
      session.queue.push(str);
      if (session.queue.length > 400) session.queue.shift();
      if (session.waiter) { const w = session.waiter; session.waiter = null; w(); }
    },
  };
  const sid = rid();
  pollSessions.set(sid, { session, last: Date.now() });
  return { sid, session };
}

function expirePollSessions() {
  const now = Date.now();
  pollSessions.forEach((entry, sid) => {
    if (now - entry.last > 45000) {
      pollSessions.delete(sid);
      entry.session._closed = true;
      entry.session.queue = [];
      handleSessionClose(entry.session);
    }
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 100000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/send' && req.method === 'POST') {
    const body = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
    let sid = String(payload.sid || '');
    let entry = sid ? pollSessions.get(sid) : null;
    if (!entry) {
      const created = createPollSession();
      sid = created.sid;
      entry = { session: created.session, last: Date.now() };
    }
    entry.last = Date.now();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid }));
    if (payload.msg) {
      try { onMessage(entry.session, JSON.stringify(payload.msg)); } catch (e) { console.error('poll msg', e); }
    }
    return;
  }

  if (url.pathname === '/api/poll') {
    const sid = String(url.searchParams.get('sid') || '');
    const entry = pollSessions.get(sid);
    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ closed: true }));
      return;
    }
    entry.last = Date.now();
    const flush = () => {
      const msgs = entry.session.queue.splice(0);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ messages: msgs, alive: true }));
    };
    if (entry.session.queue.length) { flush(); return; }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      entry.session.waiter = null;
      entry.last = Date.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ messages: [], alive: true }));
    }, 20000);
    entry.session.waiter = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      flush();
    };
    req.on('close', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      entry.session.waiter = null;
    });
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(url.pathname));
  if (url.pathname === '/' || !path.extname(filePath)) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('no'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('404'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webmanifest': 'application/manifest+json',
    };
    res.writeHead(200, {
      'content-type': types[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

function handleSessionClose(socket) {
  const code = socket._roomCode;
  socket._closed = true;
  if (!code) return;
  const room = rooms.get(code);
  if (!room) return;
  if (socket._spectator) {
    room.spectators = room.spectators.filter((x) => x !== socket._spectator);
    return;
  }
  const player = room.players.find((p) => p.id === socket._playerId && p.socket === socket);
  if (!player) return;
  player.connected = false;
  player.socket = null;
  player.disconnectedAt = Date.now();
  if (room.phase === 'lobby') {
    // في الانتظار: يُزال بعد مهلة إعادة الدخول
    const t = setTimeout(() => {
      if (player.connected || room.phase !== 'lobby') return;
      removePlayer(room, player);
      if (!room.players.length) room.emptySince = Date.now();
      broadcast(room);
    }, T(G.CONFIG.REJOIN_GRACE_MS));
    room.botTimers.push(t);
  }
  transferHost(room);
  if (!humans(room).some((p) => p.connected)) room.emptySince = Date.now();
  broadcast(room);
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket._alive = true;
  socket.on('pong', () => { socket._alive = true; });
  socket.on('message', (raw) => {
    socket._alive = true;
    try { onMessage(socket, raw); } catch (e) { console.error('msg error', e); }
  });
  socket.on('close', () => handleSessionClose(socket));
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket._alive === false) { try { socket.terminate(); } catch { /* noop */ } return; }
    socket._alive = false;
    try { socket.ping(); } catch { /* noop */ }
  });
}, 20000);

// حذف الغرف الفارغة بعد 10 دقائق
const sweeper = setInterval(() => {
  const now = Date.now();
  expirePollSessions();
  rooms.forEach((room) => {
    const live = room.players.some((p) => !p.isBot && p.connected) || room.spectators.length > 0;
    if (live) { room.emptySince = null; return; }
    if (room.emptySince === null) room.emptySince = now;
    if (now - (room.emptySince || now) >= G.CONFIG.EMPTY_ROOM_MS) destroyRoom(room);
  });
}, 30000);

heartbeat.unref?.();
sweeper.unref?.();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`معركة الطاقة تعمل على المنفذ ${PORT}`);
});

module.exports = { server, rooms, wss };
