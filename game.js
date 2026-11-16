'use strict';
/*
 * معركة الطاقة — محرك القواعد النقي (بدون شبكة)
 * كل الحساب هنا. السيرفر هو من يستدعيه، والعميل لا يحسب نتيجة أبداً.
 */

const CONFIG = {
  MIN_PLAYERS: 3,
  MAX_PLAYERS: 5,
  ROUNDS: 5,
  ENERGY: 10,
  FEAST_ENERGY: 14,
  LOSS_BONUS: 3,
  THIEF_COST: 2,
  FIRST_TIMER_MS: 25000,
  TIMER_MS: 20000,
  CARD_PICK_MS: 15000,
  BETWEEN_MS: 3000,
  REVEAL_TILE_MS: 1200,
  REVEAL_MAX_MS: 14000,
  REJOIN_GRACE_MS: 20000,
  EMPTY_ROOM_MS: 10 * 60 * 1000,
  TRAP_THRESHOLD: 6,
  TRAP_LOSS: 3,
};

const EVENTS = {
  NORMAL: 'عادي',
  GOLDEN: 'ذهبي',
  REVERSE: 'مقلوب',
  FEAST: 'وفرة',
};

const EVENT_TABLE = [
  { id: EVENTS.NORMAL, weight: 40, desc: 'القواعد كما هي' },
  { id: EVENTS.GOLDEN, weight: 20, desc: 'قيمة أعلى مربع تتضاعف' },
  { id: EVENTS.REVERSE, weight: 20, desc: 'يفوز أقل طاقة أكبر من صفر' },
  { id: EVENTS.FEAST, weight: 20, desc: 'الجميع 14 طاقة بدل 10' },
];

const CARDS = {
  shield: {
    id: 'shield', name: 'الدرع', icon: '🛡️', target: 'tile',
    desc: 'اختر مربعاً. إذا تعادلت عليه في الأعلى تفوز به. درعان على المربع نفسه يلغيان بعضهما.',
  },
  thief: {
    id: 'thief', name: 'اللص', icon: '🗡️', target: 'player',
    desc: 'اختر خصماً. يخسر 2 طاقة هذه الجولة ويُعلَم قبل أن يوزّع. طاقتك لا تزيد.',
  },
  trap: {
    id: 'trap', name: 'الفخ', icon: '🪤', target: 'tile',
    desc: 'اختر مربعاً. كل لاعب آخر يضع عليه 6 طاقة أو أكثر يخسر 3 نقاط.',
  },
  double: {
    id: 'double', name: 'المضاعف', icon: '✖️2', target: 'tile',
    desc: 'اختر مربعاً. إذا فزت به تأخذ قيمته مضاعفة. إن لم تفز فلا أثر.',
  },
  sniper: {
    id: 'sniper', name: 'القناص', icon: '🎯', target: 'tilePlayer',
    desc: 'اختر مربعاً ولاعباً. إذا فاز ذلك اللاعب بذلك المربع يُلغى فوزه ولا يأخذ أحد القيمة.',
  },
};
const CARD_ORDER = ['shield', 'thief', 'trap', 'double', 'sniper'];

/* ------------------------------------------------------------------ */
/* عشوائية قابلة للبذر (للاختبارات)                                    */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const defaultRng = () => Math.random();

function randInt(rng, n) {
  return Math.floor(rng() * n);
}

function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickOne(rng, arr) {
  return arr[randInt(rng, arr.length)];
}

/* ------------------------------------------------------------------ */
/* سحب المربعات والحدث                                                 */
/* ------------------------------------------------------------------ */

// قيم المربعات: بلا تكرار من {1..6}، مرتّبة تصاعدياً (الأصغر أولاً = يمين الشاشة)
function drawTiles(playerCount, rng = defaultRng) {
  const count = playerCount + 1;
  const pool = [1, 2, 3, 4, 5, 6];
  const values = shuffle(rng, pool).slice(0, count).sort((a, b) => a - b);
  const maxValue = Math.max(...values);
  return values.map((value) => ({ value, baseValue: value, golden: value === maxValue }));
}

// الجولة الأولى عادية دائماً، ولا يتكرر حدث خاص مرتين متتاليتين
function drawEvent(roundNumber, prevEvent, rng = defaultRng) {
  if (roundNumber === 1) return EVENTS.NORMAL;
  const table = EVENT_TABLE
    .filter((e) => e.id !== prevEvent)
    .map((e) => ({ ...e }));
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = rng() * total;
  for (const e of table) {
    r -= e.weight;
    if (r < 0) return e.id;
  }
  return table[table.length - 1].id;
}

function eventInfo(id) {
  return EVENT_TABLE.find((e) => e.id === id) || EVENT_TABLE[0];
}

// الطاقة الأساسية للجولة (قبل التعويض وقبل اللص)
function baseEnergyForEvent(event) {
  return event === EVENTS.FEAST ? CONFIG.FEAST_ENERGY : CONFIG.ENERGY;
}

/* ------------------------------------------------------------------ */
/* توزيع تلقائي عند انتهاء الوقت (قاعدة 3.5)                          */
/* ------------------------------------------------------------------ */

function completeAllocation(alloc, energy, tileCount, rng = defaultRng) {
  const out = [];
  for (let i = 0; i < tileCount; i += 1) out.push(Math.max(0, Math.floor(Number(alloc?.[i]) || 0)));

  let used = out.reduce((s, v) => s + v, 0);
  if (used > energy) {
    // قص من الأكبر أولاً إن تجاوز (يحدث بعد سرقة أو تبديل طاقة)
    let excess = used - energy;
    const order = out.map((v, i) => i).sort((a, b) => out[b] - out[a]);
    for (const i of order) {
      if (excess <= 0) break;
      const take = Math.min(out[i], excess);
      out[i] -= take;
      excess -= take;
    }
    used = energy;
  }
  let remaining = energy - used;
  if (remaining <= 0) return out;

  const touched = out.map((v, i) => i).filter((i) => out[i] > 0);
  if (touched.length === 0) {
    // لم يضع شيئاً: على الجميع بالتساوي
    const each = Math.floor(remaining / tileCount);
    for (let i = 0; i < tileCount; i += 1) out[i] += each;
    let rest = remaining - each * tileCount;
    while (rest > 0) {
      out[randInt(rng, tileCount)] += 1;
      rest -= 1;
    }
    return out;
  }
  // على المربعات التي وضع عليها شيئاً
  for (let k = 0; k < remaining; k += 1) {
    out[touched[randInt(rng, touched.length)]] += 1;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* حساب الجولة — الترتيب: لص/توزيع ← فائز+درع+تعادل ← قناص ← مضاعف ← فخ ← ضم */
/* ------------------------------------------------------------------ */

function resolveRound({
  players,          // [{id, score}]
  tiles,            // [{value, baseValue, golden}]
  event,
  allocs,           // {pid: [..]}
  cards,            // {pid: {card, target:{tile, playerId}}}
  rng = defaultRng,
}) {
  const scores = {};
  players.forEach((p) => { scores[p.id] = Number(p.score) || 0; });

  const reverse = event === EVENTS.REVERSE;
  const gain = {};
  const trapLoss = {};
  const collisions = {};
  const tilesWon = {};
  const winsByShield = {};
  players.forEach((p) => {
    gain[p.id] = 0; trapLoss[p.id] = 0; collisions[p.id] = 0; tilesWon[p.id] = []; winsByShield[p.id] = 0;
  });

  const tileResults = tiles.map((tile, index) => {
    const energies = {};
    players.forEach((p) => {
      energies[p.id] = Math.max(0, Math.floor(Number(allocs[p.id]?.[index]) || 0));
    });

    const positives = players.filter((p) => energies[p.id] > 0);
    let cand = [];
    if (positives.length > 0) {
      const ref = reverse
        ? Math.min(...positives.map((p) => energies[p.id]))
        : Math.max(...positives.map((p) => energies[p.id]));
      cand = positives.filter((p) => energies[p.id] === ref);
    }

    const collision = cand.length > 1;
    let winner = null;
    let decidedBy = null;

    if (cand.length === 1) {
      winner = cand[0];
      decidedBy = reverse ? 'lowest' : 'highest';
    } else if (cand.length > 1) {
      cand.forEach((p) => { collisions[p.id] += 1; });
      const shielded = cand.filter((p) => {
        const c = cards[p.id];
        return c && c.card === 'shield' && c.target && c.target.tile === index;
      });
      if (shielded.length === 1) {
        winner = shielded[0];
        decidedBy = 'shield';
        winsByShield[winner.id] += 1;
      } else if (shielded.length >= 2) {
        // درعان على المربع نفسه يلغيان بعضهما ← تعود قاعدة النقاط
      }
      if (!winner) {
        const minPts = Math.min(...cand.map((p) => scores[p.id]));
        const lowest = cand.filter((p) => scores[p.id] === minPts);
        if (lowest.length === 1) {
          winner = lowest[0];
          decidedBy = 'points';
        } else {
          winner = null;
          decidedBy = 'annulled';
        }
      }
    }

    // (3) القناص
    let sniper = null;
    if (winner) {
      const owner = players.find((p) => {
        const c = cards[p.id];
        return c && c.card === 'sniper' && c.target && c.target.tile === index
          && c.target.playerId === winner.id;
      });
      if (owner) {
        sniper = { by: owner.id, victim: winner.id };
        winner = null;
        decidedBy = 'sniper';
      }
    }

    // (4) المضاعف + القيمة
    let value = tile.value;
    if (tile.golden) value *= 2; // حدث ذهبي: قيمة أعلى مربع تتضاعف
    let doubled = false;
    if (winner) {
      const c = cards[winner.id];
      if (c && c.card === 'double' && c.target && c.target.tile === index) {
        value *= 2;
        doubled = true;
      }
      gain[winner.id] += value;
      tilesWon[winner.id].push(index);
    }

    // (5) الفخ: كل لاعب آخر يضع 6+ على المربع
    const trapOwners = players
      .filter((p) => {
        const c = cards[p.id];
        return c && c.card === 'trap' && c.target && c.target.tile === index;
      })
      .map((p) => p.id);
    const trappedIds = [];
    trapOwners.forEach((ownerId) => {
      players.forEach((p) => {
        if (p.id === ownerId) return;
        if (energies[p.id] >= CONFIG.TRAP_THRESHOLD) {
          trapLoss[p.id] += CONFIG.TRAP_LOSS;
          if (!trappedIds.includes(p.id)) trappedIds.push(p.id);
        }
      });
    });

    return {
      index,
      baseValue: tile.baseValue ?? tile.value,
      value,
      golden: !!tile.golden,
      energies,
      winnerId: winner ? winner.id : null,
      decidedBy,
      collision,
      tiedIds: cand.map((p) => p.id),
      sniper,
      doubled,
      trapOwners,
      trappedIds,
      points: winner ? { [winner.id]: value } : {},
    };
  });

  // (6) ضم النقاط
  const perPlayer = {};
  players.forEach((p) => {
    const before = scores[p.id];
    const gross = gain[p.id];
    const loss = trapLoss[p.id];
    const after = Math.max(0, before + gross - loss); // لا ينزل تحت صفر
    perPlayer[p.id] = {
      scoreBefore: before,
      scoreAfter: after,
      gain: gross,
      trapLoss: loss,
      delta: after - before,
      tilesWon: tilesWon[p.id],
      collisions: collisions[p.id],
      winsByShield: winsByShield[p.id],
    };
  });

  return { event, reverse, tiles: tileResults, perPlayer };
}

/* ------------------------------------------------------------------ */
/* ملخص الجولة (للالقاب والإحصاء)                                      */
/* ------------------------------------------------------------------ */

function argmaxTile(alloc) {
  let best = -1;
  let bestVal = -1;
  alloc.forEach((v, i) => {
    if (v > bestVal) { bestVal = v; best = i; }
  });
  return best;
}

function roundSummary({ players, tiles, allocs, resolutions }) {
  const topValueIndex = tiles.reduce(
    (best, t, i) => (t.value > tiles[best].value ? i : best), 0,
  );
  const out = {};
  players.forEach((p) => {
    const alloc = allocs[p.id] || [];
    const total = alloc.reduce((s, v) => s + v, 0);
    const nonZero = alloc.filter((v) => v > 0).length;
    const focusIdx = argmaxTile(alloc);
    const res = resolutions.perPlayer[p.id];
    const won = res.tilesWon;
    const allIn = nonZero === 1 && total > 0;
    const even = nonZero >= 3 && (Math.max(...alloc) - Math.min(...alloc.filter((v) => v > 0))) <= 1;
    out[p.id] = {
      focusedTopTile: focusIdx === topValueIndex && (alloc[focusIdx] || 0) > 0,
      allIn,
      allInLost: allIn && won.length === 0,
      evenSpread: even,
      energyOnTopTile: alloc[topValueIndex] || 0,
      tilesWon: won.length,
      minWinningEnergy: won.length
        ? Math.min(...won.map((i) => alloc[i]))
        : null,
      collisions: res.collisions,
      trapLoss: res.trapLoss,
      winsByShield: res.winsByShield,
      points: res.gain,
    };
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* الألقاب المضحكة                                                     */
/* ------------------------------------------------------------------ */

const TITLE_POOL = [
  'الشجاع الأحمق', 'الثعلب', 'المسالم', 'الجشع', 'المشاغب',
  'الحصن', 'الغامض', 'الصياد', 'الحظ العاثر', 'الملك',
];

function computeTitles(players, agg) {
  // agg[pid] = مجاميع عبر المباراة
  const titles = {};
  const used = new Set();
  const ranked = players.slice();
  const assign = (pid, title) => {
    if (!pid || titles[pid] || used.has(title)) return false;
    titles[pid] = title;
    used.add(title);
    return true;
  };
  // يختار صاحب أفضل قيمة (cmp) بين من لا لقب له؛ ولا يمنح لقباً إن كانت القيمة صفر
  const pickBy = (key, cmp, requirePositive = true) => {
    const free = ranked.filter((p) => !titles[p.id]);
    if (!free.length) return null;
    let best = null;
    free.forEach((p) => {
      const v = agg[p.id]?.[key] ?? 0;
      if (best === null || cmp(v, agg[best.id]?.[key] ?? 0)) best = p;
    });
    if (!best) return null;
    const v = agg[best.id]?.[key] ?? 0;
    if (requirePositive && !(v > 0)) return null;
    return best.id;
  };

  // 1) الشجاع الأحمق: وضع كل طاقته على مربع وخسره
  let cand = ranked.filter((p) => (agg[p.id]?.allInLost || 0) > 0);
  if (cand.length) {
    cand.sort((a, b) => agg[b.id].allInLost - agg[a.id].allInLost);
    assign(cand[0].id, 'الشجاع الأحمق');
  }
  // 2) الثعلب: فاز بأقل طاقة
  {
    let best = null;
    ranked.filter((p) => !titles[p.id]).forEach((p) => {
      const v = agg[p.id]?.minWinningEnergy;
      if (v === null || v === undefined) return;
      if (best === null || v < (agg[best.id]?.minWinningEnergy ?? Infinity)) best = p;
    });
    if (best) assign(best.id, 'الثعلب');
  }
  // 3) المسالم: وزّع بالتساوي
  {
    const pid = pickBy('evenSpread', (v, b) => v > b);
    if (pid) assign(pid, 'المسالم');
  }
  // 4) الجشع: أكثر طاقة على أكبر مربع
  {
    const pid = pickBy('energyOnTopTile', (v, b) => v > b);
    if (pid) assign(pid, 'الجشع');
  }
  // 5) المشاغب: أكثر تصادمات
  {
    const pid = pickBy('collisions', (v, b) => v > b);
    if (pid) assign(pid, 'المشاغب');
  }
  // 6) الحصن: فاز بالدرع
  {
    const pid = pickBy('winsByShield', (v, b) => v > b);
    if (pid) assign(pid, 'الحصن');
  }
  // 7) الصياد: أكثر مربعات
  {
    const pid = pickBy('tilesWon', (v, b) => v > b);
    if (pid) assign(pid, 'الصياد');
  }
  // 8) الحظ العاثر: أكثر خسارة من الفخ
  {
    const pid = pickBy('trapLoss', (v, b) => v > b);
    if (pid) assign(pid, 'الحظ العاثر');
  }
  // 9) الملك: أعلى مجموع نقاط
  {
    const pid = pickBy('score', (v, b) => v > b);
    if (pid) assign(pid, 'الملك');
  }
  // 10) الغامض: أقل مربعات
  {
    const pid = pickBy('tilesWon', (v, b) => v < b);
    if (pid) assign(pid, 'الغامض');
  }
  // أي لاعب بلا لقب يأخذ من المتبقي
  const spare = TITLE_POOL.filter((t) => !used.has(t));
  players.forEach((p, i) => {
    if (titles[p.id]) return;
    const t = spare.find((s) => !used.has(s)) || `صاحب المقعد ${i + 1}`;
    titles[p.id] = t;
    used.add(t);
  });
  return titles;
}

function emptyAgg() {
  return {
    score: 0, tilesWon: 0, collisions: 0, winsByShield: 0, trapLoss: 0,
    allInLost: 0, evenSpread: 0, energyOnTopTile: 0, minWinningEnergy: null,
  };
}

function mergeAgg(agg, summary, points) {
  Object.keys(summary).forEach((pid) => {
    const s = summary[pid];
    const a = agg[pid] || (agg[pid] = emptyAgg());
    a.score = points[pid] ?? a.score;
    a.tilesWon += s.tilesWon;
    a.collisions += s.collisions;
    a.winsByShield += s.winsByShield;
    a.trapLoss += s.trapLoss;
    a.allInLost += s.allInLost ? 1 : 0;
    a.evenSpread += s.evenSpread ? 1 : 0;
    a.energyOnTopTile += s.energyOnTopTile;
    if (s.minWinningEnergy !== null && s.minWinningEnergy !== undefined) {
      a.minWinningEnergy = a.minWinningEnergy === null
        ? s.minWinningEnergy
        : Math.min(a.minWinningEnergy, s.minWinningEnergy);
    }
  });
  return agg;
}

/* ------------------------------------------------------------------ */
/* بوتات                                                               */
/* ------------------------------------------------------------------ */

function fixSum(out, energy, rng) {
  let total = out.reduce((s, v) => s + v, 0);
  let guard = 0;
  while (total < energy && guard < 500) {
    out[randInt(rng, out.length)] += 1;
    total += 1;
    guard += 1;
  }
  while (total > energy && guard < 1000) {
    const idx = out.map((v, i) => i).filter((i) => out[i] > 0);
    if (!idx.length) break;
    out[pickOne(rng, idx)] -= 1;
    total -= 1;
    guard += 1;
  }
  return out;
}

function botAllocate(style, energy, tiles, rng = defaultRng) {
  const n = tiles.length;
  let out = new Array(n).fill(0);
  if (style === 'value') {
    const weights = tiles.map((t) => t.value + 1 + rng() * 1.5);
    const totalW = weights.reduce((s, w) => s + w, 0);
    out = weights.map((w) => Math.floor((w / totalW) * energy));
    out = fixSum(out, energy, rng);
  } else if (style === 'balanced') {
    const each = Math.floor(energy / n);
    out = new Array(n).fill(each);
    out = fixSum(out, energy, rng);
  } else if (style === 'focus') {
    const idx = randInt(rng, n);
    const main = Math.max(1, Math.round(energy * (0.5 + rng() * 0.35)));
    out[idx] = Math.min(energy, main);
    out = fixSum(out, energy, rng);
  } else { // random
    for (let i = 0; i < energy; i += 1) out[randInt(rng, n)] += 1;
    out = fixSum(out, energy, rng);
  }
  return out;
}

const BOT_STYLES = ['value', 'balanced', 'random', 'focus'];

// بوت الغياب: أسلوب موزّع/عشوائي كما في القسم 7
function absentBotAllocate(energy, tiles, rng = defaultRng) {
  return botAllocate(rng() < 0.5 ? 'balanced' : 'random', energy, tiles, rng);
}

module.exports = {
  CONFIG,
  EVENTS,
  EVENT_TABLE,
  CARDS,
  CARD_ORDER,
  mulberry32,
  defaultRng,
  randInt,
  shuffle,
  pickOne,
  drawTiles,
  drawEvent,
  eventInfo,
  baseEnergyForEvent,
  completeAllocation,
  resolveRound,
  roundSummary,
  computeTitles,
  emptyAgg,
  mergeAgg,
  botAllocate,
  absentBotAllocate,
  BOT_STYLES,
  argmaxTile,
};
