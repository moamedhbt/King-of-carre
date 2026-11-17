'use strict';
/*
 * محاكاة قياس البطاقات — تعمل على المحرك وحده (game.js) بلا سيرفر ولا شبكة.
 * الغرض: إنتاج دليل رقمي بدل الذوق في حكم «هل البطاقات عادلة؟»
 * الاستعمال:  node scripts/sim.js [MatchesCount]
 * الناتج: جدول يُكتب في docs/cards-evidence.md
 */
const fs = require('fs');
const path = require('path');
const G = require('../game.js');

const MATCHES = Number(process.argv[2]) || 1200;
const rng = G.mulberry32(20261117);

function pickCards() {
  // كل لاعب يختار ٣ من ٥ عشوائياً — كما يفعل اللاعب الجاهل بالقيم
  return G.shuffle(rng, G.CARD_ORDER).slice(0, 3);
}

function randomAlloc(energy, tileCount) {
  const out = new Array(tileCount).fill(0);
  for (let i = 0; i < energy; i += 1) out[G.randInt(rng, tileCount)] += 1;
  return out;
}

// قرار بوت بسيط للاستعمال: يستعمل أول بطاقة متاحة، باحتمال 70% في الجولة
function maybeUse(cards, used, round) {
  const avail = cards.filter((c) => !used.includes(c));
  if (!avail.length) return null;
  if (round === 1 || rng() > 0.7) return null;
  return avail[0];
}

function targetFor(card, tileCount, players, me, allocs, tiles) {
  if (card === 'thief') {
    const others = players.filter((p) => p.id !== me.id);
    return { playerId: others[G.randInt(rng, others.length)].id };
  }
  const tile = G.randInt(rng, tileCount);
  if (card === 'sniper') {
    const holders = players.filter((p) => p.id !== me.id);
    return { tile, playerId: holders[G.randInt(rng, holders.length)].id };
  }
  return { tile };
}

function run() {
  const perCard = {};
  G.CARD_ORDER.forEach((id) => {
    perCard[id] = {
      chosen: 0, activated: 0, hit: 0, wins: 0, ranks: [], delta: [], matchWins: 0, matchesWith: 0,
    };
  });
  let totalRounds = 0;

  for (let m = 0; m < MATCHES; m += 1) {
    const n = 3 + G.randInt(rng, 3); // 3..5 لاعبين
    const tileCount = n + 1;
    const players = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, score: 0, cards: pickCards(), used: [], bot: true,
    }));
    players.forEach((p) => p.cards.forEach((c) => { perCard[c].chosen += 1; perCard[c].matchesWith += 1; }));

    let prevEvent = null;
    for (let round = 1; round <= G.CONFIG.ROUNDS; round += 1) {
      totalRounds += 1;
      const event = G.drawEvent(round, prevEvent, rng);
      prevEvent = event;
      const tiles = G.drawTiles(n, rng, event);
      const energy = G.baseEnergyForEvent(event);
      const allocs = {};
      const cards = {};
      // ١) الجميع يوزّع أولاً (التوزيع سرّي ولا يعرف أحد توزيع غيره)
      players.forEach((p) => { allocs[p.id] = randomAlloc(energy, tileCount); });
      // ٢) ثم تُفعَّل البطاقات — واللص يقتطع من قوة ضحيته قبل الحساب
      players.forEach((p) => {
        const card = maybeUse(p.cards, p.used, round);
        if (card) {
          const target = targetFor(card, tileCount, players, p, allocs, tiles);
          cards[p.id] = { card, target };
          p.used.push(card);
          perCard[card].activated += 1;
          p.activeCard = card;
          // اللص يعمل قبل التوزيع فعلياً: الخصم يفقد ٢ قوة
          if (card === 'thief') {
            const v = target.playerId;
            let toCut = G.CONFIG.THIEF_COST;
            const order = allocs[v].map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]);
            for (const [x, i] of order) {
              const take = Math.min(x, toCut);
              allocs[v][i] -= take;
              toCut -= take;
              if (toCut === 0) break;
            }
            perCard.thief.hit += 1; // أثره مضمون بمجرد التنفيذ
          }
        } else {
          p.activeCard = null;
        }
      });
      const res = G.resolveRound({
        players: players.map((p) => ({ id: p.id, score: p.score })),
        tiles, event, allocs, cards, rng,
      });

      // أثر البطاقة على اللوحة
      const hit = { shield: false, sniper: false, double: false, trap: false, thief: false };
      res.tiles.forEach((t) => {
        if (t.decidedBy === 'shield') hit.shield = true;
        if (t.sniper) hit.sniper = true;
        if (t.doubled) hit.double = true;
        if ((t.trapOwners || []).length && (t.trappedIds || []).length) hit.trap = true;
      });
      players.forEach((p) => {
        const before = p.score;
        const after = res.perPlayer[p.id].scoreAfter;
        if (p.activeCard) {
          const rec = perCard[p.activeCard];
          if (hit[p.activeCard]) rec.hit += 1;
          rec.wins += res.perPlayer[p.id].tilesWon.length;
          rec.delta.push(after - before);
        }
        p.score = after;
      });

    }

    // ترتيب نهائي
    const sorted = players.slice().sort((a, b) => b.score - a.score);
    const top = sorted[0].score;
    sorted.forEach((p, i) => {
      const rank = p.score === top ? 1 : i + 1;
      p.cards.forEach((c) => {
        perCard[c].ranks.push(rank);
        if (rank === 1) perCard[c].matchWins += 1;
      });
    });
  }
  return { perCard, totalRounds, matches: MATCHES };
}

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

const { perCard, matches } = run();
const rows = G.CARD_ORDER.map((id) => {
  const r = perCard[id];
  return {
    id,
    name: G.CARDS[id].name,
    chosen: r.chosen,
    activated: r.activated,
    hit: r.hit,
    hitRatio: r.hit / Math.max(1, r.activated),
    activatedPerMatch: r.activated / matches,
    tilesPerUse: r.wins / Math.max(1, r.activated),
    avgDelta: avg(r.delta),
    avgRank: avg(r.ranks),
    winShare: r.matchWins / matches,
  };
});

const lines = [];
lines.push('# دليل أرقام البطاقات (محاكاة)');
lines.push('');
lines.push(`> مُولَّد آلياً بـ \`node scripts/sim.js\` — ${matches} مباراة، ${G.CONFIG.ROUNDS} جولات، ٣–٥ لاعبين،`);
lines.push('> توزيع عشوائي، واختيار البطاقات عشوائي (٣ من ٥)، واستعمالها باحتمال ٧٠٪ في الجولات ٢–٥.');
lines.push('> **لا أسماء ولا رموز** — مجاميع فقط.');
lines.push('');
lines.push('| البطاقة | اختيرت | فُعِّلت | تحقّق شرطها | نسبة تحقّق الشرط | تفعيلات/مباراة | أراضٍ فائزة/تفعيل | تغيّر النقاط/تفعيل | متوسط الترتيب | نسبة فوز المباراة |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
rows.forEach((r) => {
  lines.push(`| ${r.name} | ${r.chosen} | ${r.activated} | ${r.hit} | ${pct(r.hit, r.activated)} | ${r.activatedPerMatch.toFixed(2)} | ${r.tilesPerUse.toFixed(2)} | ${r.avgDelta.toFixed(2)} | ${r.avgRank.toFixed(2)} | ${(r.winShare * 100).toFixed(1)}% |`);
});
lines.push('');
lines.push('## كيف تُقرأ');
lines.push('- **نسبة تحقّق الشرط**: إذا كانت منخفضة جداً فالبطاقة تصرف رصيداً على أمل لا يتحقق، أي ورقة ميتة.');
lines.push('- **تغيّر النقاط/تفعيل**: كم تكسب الجولة التي استعملتها فيها (قد يكون سالباً).');
lines.push('- **نسبة فوز المباراة**: أي بطاقة ترافق أصحاب المرتبة الأولى أكثر — إشارة أولية للنفع الحقيقي.');
lines.push('- الأرقام ليست حكماً نهائياً: البوتات هنا توزّع عشوائياً ولا تفكّر. الغرض كشف الفروق الفاحشة، لا إثبات توازن دقيق.');

const out = path.join(__dirname, '..', 'docs', 'cards-evidence.md');
fs.writeFileSync(out, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
console.log(`\nكُتب: ${out}`);
