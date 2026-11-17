'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('../game');

const P = (ids) => ids.map((id) => ({ id, score: 0 }));

// لوح اختبار: الذهبي يحتاج تحديداً صريحاً (في اللعب الحقيقي هو دائماً أعلى قيمة)
function board(values, golden = false) {
  return values.map((v) => ({ value: v, baseValue: v, golden: golden && v === Math.max(...values) }));
}

test('سحب المربعات: عدد = لاعبين + 1، بلا تكرار، تصاعدي، والتضاعف في «ذهبي» فقط', () => {
  for (let n = 3; n <= 5; n += 1) {
    for (let k = 0; k < 50; k += 1) {
      const rng = G.mulberry32(k + n * 1000);
      const tiles = G.drawTiles(n, rng);
      assert.strictEqual(tiles.length, n + 1);
      const vals = tiles.map((t) => t.value);
      assert.strictEqual(new Set(vals).size, vals.length);
      assert.deepStrictEqual(vals, vals.slice().sort((a, b) => a - b));
      vals.forEach((v) => assert.ok(v >= 1 && v <= 6));
      // في الجولات العادية لا تضاعف لأي أرض
      assert.ok(tiles.every((t) => t.golden === false), 'لا ذهبي في الجولة العادية');
      // في جولة «ذهبي» تتضاعف الأرض العليا وحدها
      const gold = G.drawTiles(n, G.mulberry32(k + n * 1000), G.EVENTS.GOLDEN);
      const max = Math.max(...gold.map((t) => t.value));
      gold.forEach((t) => assert.strictEqual(t.golden, t.value === max, 'الذهبي على الأعلى فقط'));
    }
  }
});

test('الحدث: الجولة الأولى عادية دائماً، ولا يتكرر حدث خاص مرتين متتاليتين', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const rng = G.mulberry32(seed);
    let prev = null;
    for (let r = 1; r <= 5; r += 1) {
      const ev = G.drawEvent(r, prev, rng);
      if (r === 1) assert.strictEqual(ev, G.EVENTS.NORMAL);
      if (prev && prev !== G.EVENTS.NORMAL) assert.notStrictEqual(ev, prev);
      prev = ev;
    }
  }
});

test('الحدث: التوزيع يقارب 40/20/20/20', () => {
  const counts = {};
  const rng = G.mulberry32(7);
  for (let i = 0; i < 20000; i += 1) {
    const ev = G.drawEvent(2, null, rng);
    counts[ev] = (counts[ev] || 0) + 1;
  }
  assert.ok(Math.abs(counts[G.EVENTS.NORMAL] / 20000 - 0.4) < 0.03, JSON.stringify(counts));
  assert.ok(Math.abs(counts[G.EVENTS.GOLDEN] / 20000 - 0.2) < 0.03, JSON.stringify(counts));
  assert.ok(Math.abs(counts[G.EVENTS.REVERSE] / 20000 - 0.2) < 0.03, JSON.stringify(counts));
  assert.ok(Math.abs(counts[G.EVENTS.FEAST] / 20000 - 0.2) < 0.03, JSON.stringify(counts));
});

test('التوزيع التلقائي: الباقي يذهب فقط للمربعات التي عليها شيء', () => {
  const rng = G.mulberry32(3);
  const out = G.completeAllocation([4, 0, 0, 3], 10, 4, rng);
  assert.strictEqual(out.reduce((s, v) => s + v, 0), 10);
  assert.strictEqual(out[1], 0);
  assert.strictEqual(out[2], 0);
});

test('التوزيع التلقائي: من لم يضع شيئاً يُوزَّع عليه بالتساوي', () => {
  const rng = G.mulberry32(4);
  const out = G.completeAllocation([0, 0, 0, 0, 0], 10, 5, rng);
  assert.strictEqual(out.reduce((s, v) => s + v, 0), 10);
  assert.ok(Math.max(...out) - Math.min(...out) <= 1);
});

test('3.1/3.2 تعادل بنقاط مختلفة: الأقل نقاطاً يفوز', () => {
  const players = [
    { id: 'a', score: 9 },
    { id: 'b', score: 2 },
    { id: 'c', score: 5 },
  ];
  const tiles = board([3]);
  const allocs = { a: [5], b: [5], c: [0] };
  const res = G.resolveRound({ players, tiles, event: G.EVENTS.NORMAL, allocs, cards: {} });
  assert.strictEqual(res.tiles[0].winnerId, 'b');
  assert.strictEqual(res.tiles[0].decidedBy, 'points');
  assert.strictEqual(res.tiles[0].collision, true);
  assert.strictEqual(res.perPlayer.b.gain, 3);
  assert.strictEqual(res.perPlayer.a.gain, 0);
});

test('3.2 تعادل بنقاط متساوية: لا يفوز أحد (إلغاء)', () => {
  const players = [
    { id: 'a', score: 4 },
    { id: 'b', score: 4 },
    { id: 'c', score: 1 },
  ];
  const res = G.resolveRound({
    players, tiles: board([5]), event: G.EVENTS.NORMAL,
    allocs: { a: [6], b: [6], c: [2] }, cards: {},
  });
  assert.strictEqual(res.tiles[0].winnerId, null);
  assert.strictEqual(res.tiles[0].decidedBy, 'annulled');
  assert.strictEqual(res.tiles[0].collision, true);
});

test('أعلى طاقة يفوز، والمربع الفارغ لا يفوز به أحد، والقيمة الذهبية تتضاعف', () => {
  const players = P(['a', 'b', 'c']);
  const res = G.resolveRound({
    players, tiles: board([1, 4], true), event: G.EVENTS.NORMAL,
    allocs: { a: [10, 0], b: [0, 9], c: [0, 1] }, cards: {},
  });
  assert.strictEqual(res.tiles[0].winnerId, 'a');
  assert.strictEqual(res.perPlayer.a.gain, 1);
  assert.strictEqual(res.tiles[1].winnerId, 'b');
  assert.strictEqual(res.tiles[1].value, 8, 'أعلى مربع ذهبي = 4×2');
  assert.strictEqual(res.perPlayer.b.gain, 8);
});

test('حدث مقلوب: يفوز أقل طاقة أكبر من صفر', () => {
  const players = P(['a', 'b', 'c']);
  const res = G.resolveRound({
    players, tiles: board([2]), event: G.EVENTS.REVERSE,
    allocs: { a: [7], b: [2], c: [0] }, cards: {},
  });
  assert.strictEqual(res.tiles[0].winnerId, 'b');
  assert.strictEqual(res.tiles[0].decidedBy, 'lowest');
});

test('درع: يفوز بالتعادل على الأعلى', () => {
  const players = [
    { id: 'a', score: 0 }, { id: 'b', score: 10 }, { id: 'c', score: 1 },
  ];
  const res = G.resolveRound({
    players, tiles: board([3]), event: G.EVENTS.NORMAL,
    allocs: { a: [5], b: [5], c: [1] },
    cards: { a: { card: 'shield', target: { tile: 0 } } },
  });
  assert.strictEqual(res.tiles[0].winnerId, 'a');
  assert.strictEqual(res.tiles[0].decidedBy, 'shield');
  assert.strictEqual(res.perPlayer.a.winsByShield, 1);
});

test('درعان على المربع نفسه يلغيان بعضهما ← تعود قاعدة النقاط', () => {
  const players = [
    { id: 'a', score: 0 }, { id: 'b', score: 10 }, { id: 'c', score: 1 },
  ];
  const res = G.resolveRound({
    players, tiles: board([3]), event: G.EVENTS.NORMAL,
    allocs: { a: [5], b: [5], c: [1] },
    cards: {
      a: { card: 'shield', target: { tile: 0 } },
      b: { card: 'shield', target: { tile: 0 } },
    },
  });
  assert.strictEqual(res.tiles[0].decidedBy, 'points');
  assert.strictEqual(res.tiles[0].winnerId, 'a', 'a أقل نقاطاً');
});

test('ترتيب الحساب: درع يحسم التعادل ثم القناص يلغيه', () => {
  const players = [
    { id: 'a', score: 0 }, { id: 'b', score: 10 }, { id: 'c', score: 1 },
  ];
  const res = G.resolveRound({
    players, tiles: board([6]), event: G.EVENTS.NORMAL,
    allocs: { a: [5], b: [5], c: [1] },
    cards: {
      a: { card: 'shield', target: { tile: 0 } },
      c: { card: 'sniper', target: { tile: 0, playerId: 'a' } },
    },
  });
  assert.strictEqual(res.tiles[0].decidedBy, 'sniper');
  assert.strictEqual(res.tiles[0].winnerId, null);
  assert.strictEqual(res.perPlayer.a.gain, 0);
  assert.strictEqual(res.perPlayer.c.gain, 0);
});

test('قناص يخطئ الهدف: لا أثر', () => {
  const players = P(['a', 'b', 'c']);
  const res = G.resolveRound({
    players, tiles: board([4]), event: G.EVENTS.NORMAL,
    allocs: { a: [6], b: [3], c: [1] },
    cards: { c: { card: 'sniper', target: { tile: 0, playerId: 'b' } } },
  });
  assert.strictEqual(res.tiles[0].winnerId, 'a');
  assert.strictEqual(res.perPlayer.a.gain, 4);
});

test('المضاعف: الفوز بقيمة مضاعفة، وبدون فوز لا أثر', () => {
  const players = P(['a', 'b', 'c']);
  const res = G.resolveRound({
    players, tiles: board([1, 5], true), event: G.EVENTS.NORMAL,
    allocs: { a: [8, 2], b: [2, 8], c: [0, 0] },
    cards: {
      a: { card: 'double', target: { tile: 0 } },
      b: { card: 'double', target: { tile: 0 } },
    },
  });
  assert.strictEqual(res.tiles[0].winnerId, 'a');
  assert.strictEqual(res.perPlayer.a.gain, 2, 'المضاعف مع الذهبي: 1×2×2');
  assert.strictEqual(res.tiles[1].value, 10, 'أعلى مربع ذهبي 5×2');
  assert.strictEqual(res.perPlayer.b.gain, 10);
});

test('الفخ: كل لاعب آخر يضع 6+ على المربع يخسر 3 نقاط، ولا صاحب الفخ', () => {
  const players = P(['a', 'b', 'c']);
  const res = G.resolveRound({
    players, tiles: board([3]), event: G.EVENTS.NORMAL,
    allocs: { a: [6], b: [6], c: [4] },
    cards: { a: { card: 'trap', target: { tile: 0 } } },
  });
  assert.strictEqual(res.perPlayer.b.trapLoss, 3);
  assert.strictEqual(res.perPlayer.c.trapLoss, 0);
  assert.strictEqual(res.perPlayer.a.trapLoss, 0);
  // a و b متعادلان بنقاط 0 → إلغاء؛ b يخسر 3 نقاط من 0 لكن لا ينزل تحت صفر
  assert.strictEqual(res.perPlayer.b.scoreAfter, 0);
});

test('الفخ مع المضاعف: النقاط تُحسب على أساس ما بعد الفخ ولا تنزل تحت صفر', () => {
  const players = [{ id: 'a', score: 5 }, { id: 'b', score: 1 }, { id: 'c', score: 2 }];
  const res = G.resolveRound({
    players, tiles: board([5]), event: G.EVENTS.NORMAL,
    allocs: { a: [6], b: [6], c: [0] },
    cards: {
      a: { card: 'trap', target: { tile: 0 } },
      b: { card: 'double', target: { tile: 0 } },
    },
  });
  // تعادل: b أقل نقاطاً (1) ← يفوز بـ 5×2 = 10 ثم يخسر 3 من الفخ
  assert.strictEqual(res.tiles[0].winnerId, 'b');
  assert.strictEqual(res.perPlayer.b.gain, 10);
  assert.strictEqual(res.perPlayer.b.trapLoss, 3);
  assert.strictEqual(res.perPlayer.b.scoreAfter, 1 + 10 - 3);
});

test('قاعدة 3.5: توزيع ناقص عند القفل يُكمل تلقائياً', () => {
  const rng = G.mulberry32(11);
  const alloc = G.completeAllocation([3], 10, 2, rng);
  assert.strictEqual(alloc.reduce((s, v) => s + v, 0), 10);
  assert.strictEqual(alloc[1], 0, 'لم يضع على المربع الثاني شيئاً');
});

test('الألقاب: منحة لكل لاعب وبلا تكرار', () => {
  const players = P(['a', 'b', 'c', 'd', 'e']);
  const agg = {};
  players.forEach((p, i) => {
    agg[p.id] = G.emptyAgg();
    agg[p.id].score = i;
    agg[p.id].tilesWon = i;
  });
  agg.a.allInLost = 2;
  agg.b.minWinningEnergy = 1;
  agg.c.evenSpread = 3;
  agg.d.collisions = 4;
  agg.e.trapLoss = 6;
  const titles = G.computeTitles(players, agg);
  assert.strictEqual(Object.keys(titles).length, 5);
  assert.strictEqual(new Set(Object.values(titles)).size, 5);
  assert.strictEqual(titles.a, 'الشجاع الأحمق');
  assert.strictEqual(titles.b, 'الثعلب');
  assert.strictEqual(titles.c, 'المسالم');
  assert.strictEqual(titles.d, 'المشاغب');
});


test('إجهاد: 5000 جولة عشوائية بلا استثناءات وحسابات سليمة', () => {
  const rng = G.mulberry32(99);
  const evs = [G.EVENTS.NORMAL, G.EVENTS.GOLDEN, G.EVENTS.REVERSE, G.EVENTS.FEAST];
  for (let k = 0; k < 5000; k += 1) {
    const n = 3 + G.randInt(rng, 3);
    const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, score: G.randInt(rng, 30) }));
    const tiles = G.drawTiles(n, rng);
    const event = G.pickOne(rng, evs);
    const energy = G.baseEnergyForEvent(event) + (rng() < 0.3 ? 3 : 0);
    const allocs = {};
    const cards = {};
    players.forEach((p) => {
      const raw = G.botAllocate(G.pickOne(rng, G.BOT_STYLES), energy, tiles, rng);
      allocs[p.id] = G.completeAllocation(raw, energy, tiles.length, rng);
      if (rng() < 0.5) {
        const card = G.pickOne(rng, G.CARD_ORDER);
        const target = { tile: G.randInt(rng, tiles.length) };
        if (card === 'thief' || card === 'sniper') {
          const others = players.filter((x) => x.id !== p.id);
          target.playerId = G.pickOne(rng, others).id;
        }
        cards[p.id] = { card, target };
      }
    });
    const res = G.resolveRound({ players, tiles, event, allocs, cards, rng });
    players.forEach((p) => {
      const r = res.perPlayer[p.id];
      assert.ok(r.scoreAfter >= 0, 'لا نقاط سالبة');
      assert.strictEqual(r.gain, r.tilesWon.reduce((s, i) => s + res.tiles[i].value, 0));
      assert.ok(Number.isFinite(r.scoreAfter));
    });
    res.tiles.forEach((t) => {
      if (t.winnerId) assert.ok(t.value > 0 && t.energies[t.winnerId] > 0);
      else assert.ok(t.decidedBy === 'annulled' || t.decidedBy === 'sniper' || Object.values(t.energies).every((e) => e === 0));
    });
    const summary = G.roundSummary({ players, tiles, allocs, resolutions: res });
    G.mergeAgg(G.emptyAgg() ? {} : {}, summary, players.reduce((a, p) => ({ ...a, [p.id]: res.perPlayer[p.id].scoreAfter }), {}));
  }
});
