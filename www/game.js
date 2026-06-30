/* ============================================================
   德州扑克 Texas Hold'em - 核心逻辑
   ============================================================ */

"use strict";

/* ---------- 常量 ---------- */
const SUITS = ["♠", "♥", "♦", "♣"];
const RED_SUITS = new Set(["♥", "♦"]);
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const CAT_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];

const AI_NAMES = ["阿龙", "Bella", "老K", "Mia", "杰克", "Nina", "石头", "Cora"];
const AI_AVATARS = ["🤖", "🐯", "🦊", "🐼", "🦁", "🐧", "🐙", "🦄"];

/* ---------- 全局状态 ---------- */
const G = {
  players: [],
  deck: [],
  community: [],
  dealer: -1,
  smallBlind: 10,
  bigBlind: 20,
  startStack: 2000,
  currentBet: 0,
  lastRaiseSize: 20,
  stage: "idle", // idle | preflop | flop | turn | river | showdown
  toAct: -1,
  searchStart: 0,
  handNum: 0,
  sbIndex: -1,
  bbIndex: -1,
  busy: false,
};

/* ---------- 工具函数 ---------- */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const N = () => G.players.length;
const rankLabel = (r) =>
  r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : String(r);

// AI 思考延时（按动作差异化，让节奏更像真人；单位毫秒）
function aiThinkDelay(action) {
  const r = (lo, hi) => lo + Math.random() * (hi - lo);
  switch (action) {
    case "check": return r(1300, 2600);
    case "call": return r(1500, 2900);
    case "fold": return r(1200, 2400);
    case "raise": return r(2000, 3800);
    case "allin": return r(2200, 4000);
    default: return r(1400, 2800);
  }
}
const potTotal = () => G.players.reduce((s, p) => s + p.totalBet, 0);
const activePlayers = () => G.players.filter((p) => !p.folded);
const roundTo = (v, step) => Math.round(v / step) * step;

/* ============================================================
   牌库 / 发牌
   ============================================================ */
function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ rank: r, suit: s });
  return d;
}
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function draw() {
  return G.deck.pop();
}

/* ============================================================
   牌型评估 (7 选 5)
   ============================================================ */
const _comboCache = {};
function chooseIndices(n, k) {
  const key = n + "_" + k;
  if (_comboCache[key]) return _comboCache[key];
  const res = [];
  const idx = [];
  (function rec(start, depth) {
    if (depth === k) {
      res.push(idx.slice());
      return;
    }
    for (let i = start; i <= n - (k - depth); i++) {
      idx.push(i);
      rec(i + 1, depth + 1);
      idx.pop();
    }
  })(0, 0);
  _comboCache[key] = res;
  return res;
}

function score5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);

  const cnt = {};
  for (const r of ranks) cnt[r] = (cnt[r] || 0) + 1;
  // 按出现次数降序，其次按点数降序
  const groups = Object.keys(cnt)
    .map((r) => [Number(r), cnt[r]])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const counts = groups.map((g) => g[1]);

  const uniq = [...new Set(ranks)];
  let straight = false;
  let sHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      straight = true;
      sHigh = uniq[0];
    } else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) {
      straight = true;
      sHigh = 5; // 轮子 A-2-3-4-5
    }
  }

  if (straight && flush) return { cat: 8, tb: [sHigh] };
  if (counts[0] === 4) return { cat: 7, tb: [groups[0][0], groups[1][0]] };
  if (counts[0] === 3 && counts[1] === 2)
    return { cat: 6, tb: [groups[0][0], groups[1][0]] };
  if (flush) return { cat: 5, tb: ranks.slice() };
  if (straight) return { cat: 4, tb: [sHigh] };
  if (counts[0] === 3)
    return {
      cat: 3,
      tb: [groups[0][0], ...groups.slice(1).map((g) => g[0])],
    };
  if (counts[0] === 2 && counts[1] === 2)
    return { cat: 2, tb: [groups[0][0], groups[1][0], groups[2][0]] };
  if (counts[0] === 2)
    return {
      cat: 1,
      tb: [groups[0][0], ...groups.slice(1).map((g) => g[0])],
    };
  return { cat: 0, tb: ranks.slice() };
}

function cmpScore(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const len = Math.max(a.tb.length, b.tb.length);
  for (let i = 0; i < len; i++) {
    const x = a.tb[i] || 0;
    const y = b.tb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function evaluate7(cards) {
  if (cards.length < 5) {
    const r = cards.map((c) => c.rank).sort((a, b) => b - a);
    return { cat: 0, tb: r, name: "高牌" };
  }
  const combos = chooseIndices(cards.length, 5);
  let best = null;
  for (const c of combos) {
    const s = score5(c.map((i) => cards[i]));
    if (!best || cmpScore(s, best) > 0) best = s;
  }
  best.name = handName(best);
  return best;
}

function handName(sc) {
  if (sc.cat === 8 && sc.tb[0] === 14) return "皇家同花顺";
  return CAT_NAMES[sc.cat];
}

/* ============================================================
   下注原语
   ============================================================ */
function commit(p, amt) {
  amt = clamp(Math.round(amt), 0, p.stack);
  p.stack -= amt;
  p.bet += amt;
  p.totalBet += amt;
  if (p.stack <= 0) {
    p.stack = 0;
    p.allIn = true;
  }
  return amt;
}

function raiseTo(p, target) {
  const before = G.currentBet;
  const add = clamp(target - p.bet, 0, p.stack);
  commit(p, add);
  if (p.bet > before) {
    const rs = p.bet - before;
    G.currentBet = p.bet;
    if (rs >= G.lastRaiseSize) {
      G.lastRaiseSize = rs;
      for (const q of G.players)
        if (q !== p && !q.folded && !q.allIn) q.acted = false;
    }
  }
  p.acted = true;
}

/* ============================================================
   行动执行
   ============================================================ */
function applyAction(idx, action, amount) {
  const p = G.players[idx];
  if (action === "fold") {
    p.folded = true;
    p.lastAction = null;
    log(`<b>${p.name}</b> 弃牌`);
  } else if (action === "check") {
    p.acted = true;
    p.lastAction = "过牌";
    log(`<b>${p.name}</b> 过牌`);
  } else if (action === "call") {
    const need = Math.min(G.currentBet - p.bet, p.stack);
    commit(p, need);
    p.acted = true;
    p.lastAction = p.allIn ? "跟注全下" : `跟注 ${need}`;
    log(`<b>${p.name}</b> 跟注 ${need}${p.allIn ? "（全下）" : ""}`);
  } else if (action === "raise") {
    const before = G.currentBet;
    raiseTo(p, amount);
    const verb = before > 0 ? "加注到" : "下注";
    p.lastAction = `${verb} ${p.bet}`;
    log(`<b>${p.name}</b> ${verb} ${p.bet}${p.allIn ? "（全下）" : ""}`);
  } else if (action === "allin") {
    const before = G.currentBet;
    raiseTo(p, p.bet + p.stack);
    p.lastAction = `全下 ${p.bet}`;
    log(`<b class="hl">${p.name}</b> 全下！(${p.bet})`, "hl");
    void before;
  }
}

/* ============================================================
   行动顺序
   ============================================================ */
function findNextActor(start) {
  const n = N();
  for (let i = 0; i < n; i++) {
    const idx = (start + i) % n;
    const p = G.players[idx];
    if (!p.folded && !p.allIn && (!p.acted || p.bet < G.currentBet)) return idx;
  }
  return -1;
}

function continueAction() {
  if (G.busy) return;
  const active = activePlayers();
  if (active.length <= 1) {
    endHandUncontested(active[0]);
    return;
  }
  const next = findNextActor(G.searchStart);
  if (next === -1) {
    endBettingRound();
    return;
  }
  G.toAct = next;
  render();
  const p = G.players[next];
  if (p.isHuman) {
    showHumanControls();
  } else {
    G.busy = true;
    const d = aiDecide(p);
    setTimeout(() => {
      G.busy = false;
      actAndAdvance(next, d.action, d.amount);
    }, aiThinkDelay(d.action));
  }
}

function actAndAdvance(idx, action, amount) {
  applyAction(idx, action, amount);
  hideControls(); // 行动后立即收起操作面板，由 continueAction 决定是否对人类重新显示
  G.searchStart = (idx + 1) % N();
  G.toAct = -1;
  continueAction();
}

/* ============================================================
   下注轮结束 / 阶段推进
   ============================================================ */
function endBettingRound() {
  // 退还未被跟注的下注（孤注/超额全下）
  refundUncalled();
  render();
  nextStage();
}

function refundUncalled() {
  const live = G.players.filter((p) => p.bet > 0);
  if (live.length < 2) {
    if (live.length === 1) {
      // 无人跟，全额退回
      const p = live[0];
      // 找第二高（其余玩家本轮投入）= 0
      p.stack += p.bet;
      p.totalBet -= p.bet;
      p.bet = 0;
    }
    return;
  }
  const bets = live.map((p) => p.bet).sort((a, b) => b - a);
  const top = bets[0];
  const second = bets[1];
  if (top > second) {
    const topPlayer = live.find((p) => p.bet === top);
    const refund = top - second;
    topPlayer.stack += refund;
    topPlayer.totalBet -= refund;
    topPlayer.bet -= refund;
    log(`返还 <b>${topPlayer.name}</b> 未被跟注的 ${refund}`, "sys");
  }
}

function nextStage() {
  G.players.forEach((p) => {
    if (!p.folded) p.lastAction = null;
  });
  if (G.stage === "preflop") {
    dealCommunity(3);
    G.stage = "flop";
  } else if (G.stage === "flop") {
    dealCommunity(1);
    G.stage = "turn";
  } else if (G.stage === "turn") {
    dealCommunity(1);
    G.stage = "river";
  } else if (G.stage === "river") {
    goShowdown();
    return;
  }
  startStreet();
}

function dealCommunity(k) {
  for (let i = 0; i < k; i++) G.community.push(draw());
  const names = { flop: "翻牌", turn: "转牌", river: "河牌" };
  log(
    `<span class="hl">— ${names[G.stage] || ""} —</span> ${G.community
      .map((c) => rankLabel(c.rank) + c.suit)
      .join(" ")}`,
    "hl"
  );
}

function startStreet() {
  G.players.forEach((p) => {
    if (!p.folded && !p.allIn) p.acted = false;
    p.bet = 0;
  });
  G.currentBet = 0;
  G.lastRaiseSize = G.bigBlind;

  const n = N();
  const start = n === 2 ? (G.dealer + 1) % n : (G.dealer + 1) % n;
  G.searchStart = start;
  render();
  setTimeout(continueAction, 900);
}

/* ============================================================
   一手牌开始
   ============================================================ */
function startHand() {
  // 淘汰筹码为 0 的玩家
  G.players = G.players.filter((p) => p.stack > 0 || p.isHuman);
  const human = G.players.find((p) => p.isHuman);
  if (human && human.stack <= 0) {
    gameOver(false);
    return;
  }
  if (G.players.length < 2) {
    gameOver(true);
    return;
  }

  G.handNum++;
  const n = N();
  G.dealer = (G.dealer + 1) % n;

  G.deck = shuffle(makeDeck());
  G.community = [];
  G.stage = "preflop";
  G.currentBet = 0;
  G.lastRaiseSize = G.bigBlind;

  G.players.forEach((p) => {
    p.hole = [];
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
    p.totalBet = 0;
    p.acted = false;
    p.reveal = false;
    p.isWinner = false;
    p.wonAmount = 0;
    p.handScore = null;
    p.lastAction = null;
  });

  // 发底牌（两轮，每人一张）
  for (let r = 0; r < 2; r++)
    for (let i = 0; i < n; i++) G.players[(G.dealer + 1 + i) % n].hole.push(draw());

  postBlinds();

  updateTopbar();
  log(
    `<span class="hl">══ 第 ${G.handNum} 局开始 ══</span> 庄家：${
      G.players[G.dealer].name
    }`,
    "hl"
  );

  showNextRow(false);
  // 翻牌前首个行动者
  let start;
  if (n === 2) start = G.dealer; // 单挑：庄家(小盲)先动
  else start = (G.dealer + 3) % n; // 大盲后一位 (UTG)
  G.searchStart = start;
  render();
  setTimeout(continueAction, 750);
}

function postBlinds() {
  const n = N();
  let sb, bb;
  if (n === 2) {
    sb = G.dealer;
    bb = (G.dealer + 1) % n;
  } else {
    sb = (G.dealer + 1) % n;
    bb = (G.dealer + 2) % n;
  }
  G.sbIndex = sb;
  G.bbIndex = bb;

  commit(G.players[sb], G.smallBlind);
  G.players[sb].lastAction = "小盲";
  commit(G.players[bb], G.bigBlind);
  G.players[bb].lastAction = "大盲";

  G.currentBet = G.bigBlind;
  G.lastRaiseSize = G.bigBlind;
  log(
    `${G.players[sb].name} 下小盲 ${G.smallBlind}，${G.players[bb].name} 下大盲 ${G.bigBlind}`,
    "sys"
  );
}

/* ============================================================
   赢家结算
   ============================================================ */
function endHandUncontested(winner) {
  refundUncalled();
  const amount = potTotal();
  winner.stack += amount;
  winner.wonAmount = amount;
  winner.isWinner = true;
  G.players.forEach((p) => (p.totalBet = 0));
  G.stage = "showdown";
  log(`<b class="hl">${winner.name}</b> 赢得底池 ${amount}（其余玩家弃牌）`, "hl");
  setCenterMessage(`${winner.name} 赢得 ${amount}`);
  render();
  finishHand();
}

function buildPots() {
  const contribs = G.players.map((p) => ({ p, amt: p.totalBet }));
  const pots = [];
  while (true) {
    const positive = contribs.filter((c) => c.amt > 0);
    if (positive.length === 0) break;
    const minAmt = Math.min(...positive.map((c) => c.amt));
    let amount = 0;
    const eligible = [];
    for (const c of contribs) {
      if (c.amt > 0) {
        c.amt -= minAmt;
        amount += minAmt;
        if (!c.p.folded) eligible.push(c.p);
      }
    }
    if (pots.length && samePlayers(pots[pots.length - 1].eligible, eligible)) {
      pots[pots.length - 1].amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
  }
  return pots;
}
function samePlayers(a, b) {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

function distributeToWinners(amount, winners) {
  const n = N();
  const ordered = winners
    .slice()
    .sort(
      (a, b) =>
        ((G.players.indexOf(a) - G.dealer - 1 + n) % n) -
        ((G.players.indexOf(b) - G.dealer - 1 + n) % n)
    );
  const share = Math.floor(amount / winners.length);
  let rem = amount - share * winners.length;
  for (const w of ordered) {
    let got = share;
    if (rem > 0) {
      got += 1;
      rem--;
    }
    w.stack += got;
    w.wonAmount += got;
    w.isWinner = true;
  }
}

function goShowdown() {
  G.stage = "showdown";
  const contenders = activePlayers();
  contenders.forEach((p) => {
    p.reveal = true;
    p.handScore = evaluate7([...p.hole, ...G.community]);
  });

  const pots = buildPots();
  const msgs = [];
  pots.forEach((pot, pi) => {
    if (pot.amount <= 0 || pot.eligible.length === 0) return;
    let best = null;
    for (const p of pot.eligible)
      if (!best || cmpScore(p.handScore, best.handScore) > 0) best = p;
    const winners = pot.eligible.filter(
      (p) => cmpScore(p.handScore, best.handScore) === 0
    );
    distributeToWinners(pot.amount, winners);
    const label = pots.length > 1 ? (pi === 0 ? "主池" : `边池${pi}`) : "底池";
    const names = winners.map((w) => w.name).join("、");
    log(
      `<b class="hl">${names}</b> 以 <b>${best.handScore.name}</b> 赢得${label} ${pot.amount}`,
      "hl"
    );
    msgs.push(`${names}（${best.handScore.name}）`);
  });

  G.players.forEach((p) => (p.totalBet = 0));
  setCenterMessage("摊牌！ " + msgs.join("  |  "));
  render();
  finishHand();
}

function finishHand() {
  G.toAct = -1;
  hideControls();
  // 检查游戏是否结束
  const alive = G.players.filter((p) => p.stack > 0);
  const human = G.players.find((p) => p.isHuman);
  if (!human || human.stack <= 0) {
    setTimeout(() => gameOver(false), 1200);
    return;
  }
  if (alive.length <= 1) {
    setTimeout(() => gameOver(alive[0] && alive[0].isHuman), 1200);
    return;
  }
  showNextRow(true);
}

/* ============================================================
   AI 决策
   ============================================================ */
function preflopStrength(hole) {
  const r1 = Math.max(hole[0].rank, hole[1].rank);
  const r2 = Math.min(hole[0].rank, hole[1].rank);
  const suited = hole[0].suit === hole[1].suit;
  const gap = r1 - r2;
  if (r1 === r2) return clamp(0.5 + ((r1 - 2) / 12) * 0.5, 0.5, 1);
  let base = 0.12 + ((r1 * 2 + r2) / 41) * 0.5;
  if (suited) base += 0.06;
  if (gap === 1) base += 0.05;
  else if (gap === 2) base += 0.02;
  if (r1 >= 13) base += 0.04;
  return clamp(base, 0, 0.85);
}

function drawBonus(hole, community) {
  const all = [...hole, ...community];
  // 同花听牌
  const suitCnt = {};
  all.forEach((c) => (suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1));
  const flushDraw = Math.max(...Object.values(suitCnt)) === 4;
  // 顺子听牌（粗略）
  const rset = [...new Set(all.map((c) => c.rank))].sort((a, b) => a - b);
  let straightDraw = false;
  for (let lo = 2; lo <= 11; lo++) {
    let inWindow = 0;
    for (let r = lo; r < lo + 5; r++) if (rset.includes(r)) inWindow++;
    if (inWindow === 4) straightDraw = true;
  }
  return clamp((flushDraw ? 0.6 : 0) + (straightDraw ? 0.4 : 0), 0, 1);
}

function handStrength(p) {
  if (G.community.length === 0) return preflopStrength(p.hole);
  const sc = evaluate7([...p.hole, ...G.community]);
  const baseByCat = [0.18, 0.42, 0.62, 0.74, 0.82, 0.88, 0.93, 0.98, 1.0];
  let base = baseByCat[sc.cat];
  if (sc.cat === 0) base = 0.05 + ((sc.tb[0] - 2) / 12) * 0.22;
  else if (sc.cat === 1) base = 0.3 + ((sc.tb[0] - 2) / 12) * 0.25;
  base += drawBonus(p.hole, G.community) * 0.12;
  return clamp(base, 0, 1);
}

function aiRaiseAction(p, target) {
  const mn = G.currentBet + G.lastRaiseSize;
  const mx = p.bet + p.stack;
  if (mx <= G.currentBet) return { action: "call" };
  if (mn > mx) return { action: "allin" };
  target = clamp(roundTo(target, G.smallBlind), mn, mx);
  if (target >= mx) return { action: "allin" };
  return { action: "raise", amount: target };
}

function aiDecide(p) {
  const toCall = G.currentBet - p.bet;
  const pot = potTotal();
  let str = handStrength(p) + p.aiNoise * (Math.random() - 0.5);
  str = clamp(str, 0, 1);
  const aggro = p.aiAggro;
  const bluff = Math.random() < 0.06 * aggro;

  if (toCall <= 0) {
    if (str > 0.55 || bluff) {
      const size = pot * (0.4 + 0.4 * Math.random()) * aggro;
      return aiRaiseAction(p, G.currentBet + size);
    }
    return { action: "check" };
  }

  const potOdds = toCall / (pot + toCall);

  if (str > 0.78 && Math.random() < 0.6 * aggro) {
    const size = pot * (0.6 + 0.5 * Math.random()) * aggro;
    return aiRaiseAction(p, G.currentBet + Math.max(size, G.lastRaiseSize));
  }
  if (str >= potOdds + 0.05 || (bluff && toCall < p.stack * 0.25)) {
    if (str > 0.6 && Math.random() < 0.3 * aggro) {
      const size = pot * (0.5 + 0.4 * Math.random()) * aggro;
      return aiRaiseAction(p, G.currentBet + size);
    }
    return { action: "call" };
  }
  if (toCall <= G.bigBlind && str > 0.2 && Math.random() < 0.5)
    return { action: "call" };
  return { action: "fold" };
}

/* ============================================================
   渲染
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const seatsEl = () => $("#seats");

function cardHTML(card, faceUp, big) {
  const cls = ["card"];
  if (big) cls.push("big");
  if (!faceUp) {
    cls.push("back");
    return `<div class="${cls.join(" ")}"></div>`;
  }
  cls.push(RED_SUITS.has(card.suit) ? "red" : "black");
  const r = rankLabel(card.rank);
  return `<div class="${cls.join(" ")}">
    <div class="corner-top"><span class="rank">${r}</span><span class="suit-sm">${card.suit}</span></div>
    <span class="suit-big">${card.suit}</span>
    <div class="corner-bottom"><span class="rank">${r}</span><span class="suit-sm">${card.suit}</span></div>
  </div>`;
}

function seatStatus(p, idx) {
  const live = G.stage !== "idle" && G.stage !== "showdown";
  if (p.isWinner) return { text: `+${p.wonAmount}`, cls: "winner" };
  if (p.folded) return { text: "弃牌", cls: "folded" };
  if (p.allIn) return { text: "全下", cls: "allin" };
  if (live && G.toAct === idx) return { text: "行动中", cls: "action" };
  if (p.lastAction) return { text: p.lastAction, cls: "" };
  return null;
}

function tableRadii() {
  const portrait = window.innerHeight >= window.innerWidth;
  const mobile = window.innerWidth <= 768;
  if (mobile && portrait) return { rx: 39, ry: 45 };
  return { rx: 47, ry: 44 };
}

function renderSeats() {
  const el = seatsEl();
  el.innerHTML = "";
  const n = N();
  const R = tableRadii();
  G.players.forEach((p, i) => {
    const ang = ((90 + (360 * i) / n) * Math.PI) / 180;
    const x = 50 + R.rx * Math.cos(ang);
    const y = 50 + R.ry * Math.sin(ang);

    const div = document.createElement("div");
    const live = G.stage !== "idle" && G.stage !== "showdown";
    div.className = "seat";
    if (p.isHuman) div.classList.add("is-human");
    if (p.folded) div.classList.add("folded");
    if (live && G.toAct === i && !p.folded && !p.allIn) div.classList.add("acting");
    if (p.isWinner) div.classList.add("winner");
    div.classList.add(y < 50 ? "pos-top" : "pos-bottom");
    div.style.left = x + "%";
    div.style.top = y + "%";

    const faceUp = p.isHuman || p.reveal;
    const holeHTML =
      p.hole && p.hole.length
        ? `<div class="hole-cards">${p.hole
            .map((c) => cardHTML(c, faceUp, false))
            .join("")}</div>`
        : `<div class="hole-cards"></div>`;

    const st = seatStatus(p, i);
    const statusHTML = st
      ? `<div class="player-status show ${st.cls}">${st.text}</div>`
      : "";
    const dealerTag = i === G.dealer ? `<div class="tag-d">D</div>` : "";

    div.innerHTML = `
      ${holeHTML}
      <div class="player-box">
        ${dealerTag}
        <div class="avatar">${p.avatar}</div>
        <div class="player-meta">
          <div class="player-name">${p.name}</div>
          <div class="player-stack">${p.stack}</div>
        </div>
        ${statusHTML}
      </div>
      ${p.bet > 0 ? `<div class="bet-chips show">${p.bet}</div>` : ""}
    `;
    el.appendChild(div);
  });
}

function renderCommunity() {
  const el = $("#community-cards");
  el.innerHTML = G.community.map((c) => cardHTML(c, true, true)).join("");
}

function renderPot() {
  $("#pot-amount").textContent = potTotal();
}

function updateTopbar() {
  $("#blind-info").textContent = `盲注 ${G.smallBlind} / ${G.bigBlind}`;
  $("#hand-counter").textContent = `第 ${G.handNum} 局`;
}

function setCenterMessage(msg) {
  $("#center-message").textContent = msg || "";
}

function render() {
  renderSeats();
  renderCommunity();
  renderPot();
  updateHandHelperSolo();
}

/* ============================================================
   牌型助手：当前牌型描述 + 蒙特卡洛胜率（全局，单机/联机共用）
   ============================================================ */
function handCardsKey(cards) {
  return (cards || []).map((c) => c.rank + c.suit).join(",");
}

function describeCurrentHand(hole, community) {
  if (!hole || hole.length < 2) return null;
  const comm = community || [];
  const cards = [...hole, ...comm];
  if (cards.length < 5) {
    if (hole[0].rank === hole[1].rank)
      return { name: "口袋对子", detail: rankLabel(hole[0].rank) + rankLabel(hole[0].rank) };
    const hi = Math.max(hole[0].rank, hole[1].rank);
    const lo = Math.min(hole[0].rank, hole[1].rank);
    const suited = hole[0].suit === hole[1].suit;
    let d = rankLabel(hi) + rankLabel(lo);
    if (suited) d += " 同花";
    if (hi - lo === 1) d += " 连张";
    return { name: "高牌", detail: d };
  }
  const sc = evaluate7(cards);
  return { name: handName(sc), detail: handDetail(sc) };
}

function handDetail(sc) {
  const L = (r) => rankLabel(r);
  switch (sc.cat) {
    case 8: return sc.tb[0] === 14 ? "" : L(sc.tb[0]) + " 高";
    case 7: return L(sc.tb[0]) + " 四条";
    case 6: return L(sc.tb[0]) + " 满 " + L(sc.tb[1]);
    case 5: return L(sc.tb[0]) + " 高";
    case 4: return L(sc.tb[0]) + " 高";
    case 3: return L(sc.tb[0]) + " 三条";
    case 2: return L(sc.tb[0]) + "·" + L(sc.tb[1]);
    case 1: return L(sc.tb[0]) + " 对";
    default: return L(sc.tb[0]) + " 高";
  }
}

function estimateEquity(hole, community, numOpp, iters) {
  if (numOpp <= 0) return 1;
  iters = iters || 500;
  const comm = community || [];
  const known = [...hole, ...comm];
  const deck = makeDeck().filter((c) => !known.some((k) => k.rank === c.rank && k.suit === c.suit));
  const needBoard = 5 - comm.length;
  const need = needBoard + numOpp * 2;
  let equity = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (deck.length - i));
      const t = deck[i];
      deck[i] = deck[j];
      deck[j] = t;
    }
    let idx = 0;
    const board = comm.slice();
    for (let i = 0; i < needBoard; i++) board.push(deck[idx++]);
    const my = evaluate7([...hole, ...board]);
    let lose = false;
    let tie = 0;
    for (let o = 0; o < numOpp; o++) {
      const os = evaluate7([deck[idx++], deck[idx++], ...board]);
      const cmp = cmpScore(my, os);
      if (cmp < 0) {
        lose = true;
        break;
      }
      if (cmp === 0) tie++;
    }
    if (!lose) equity += 1 / (tie + 1);
  }
  return equity / iters;
}

function equityIters(numOpp) {
  return Math.max(180, Math.min(800, Math.round(2400 / (numOpp + 1))));
}

let _hhKey = null;
let _hhEquity = null;
function renderHandHelper(opts) {
  const bar = document.getElementById("my-hand-bar");
  if (!bar) return;
  if (!opts || !opts.hole || opts.hole.length < 2) {
    bar.classList.add("hidden");
    _hhKey = null;
    return;
  }
  bar.classList.remove("hidden");
  const { hole, community, numOpp } = opts;
  const desc = describeCurrentHand(hole, community);
  document.getElementById("mh-rank").textContent = desc ? desc.name : "—";
  document.getElementById("mh-detail").textContent = desc && desc.detail ? desc.detail : "";

  const key = handCardsKey(hole) + "|" + handCardsKey(community) + "|" + numOpp;
  const eqEl = document.getElementById("mh-equity");
  const fill = document.getElementById("mh-bar-fill");
  if (key === _hhKey && _hhEquity != null) {
    showEquity(_hhEquity, eqEl, fill);
    return;
  }
  _hhKey = key;
  _hhEquity = null;
  eqEl.textContent = "计算中…";
  eqEl.classList.add("calc");
  setTimeout(() => {
    if (_hhKey !== key) return;
    const eq = estimateEquity(hole, community, numOpp, equityIters(numOpp));
    _hhEquity = eq;
    showEquity(eq, eqEl, fill);
  }, 25);
}
function showEquity(eq, eqEl, fill) {
  const pct = Math.round(eq * 100);
  eqEl.textContent = pct + "%";
  eqEl.classList.remove("calc");
  fill.style.width = clamp(pct, 0, 100) + "%";
  fill.style.background = eq < 0.34 ? "#d8413b" : eq < 0.6 ? "#e8902f" : "#2fa15a";
}

function updateHandHelperSolo() {
  const me = G.players && G.players[0];
  if (!me || G.stage === "idle" || me.folded || !me.hole || me.hole.length < 2) {
    renderHandHelper(null);
    return;
  }
  const numOpp = G.players.filter((p) => !p.folded && p !== me).length;
  renderHandHelper({ hole: me.hole, community: G.community, numOpp });
}

let logCount = 0;
function log(html, cls = "") {
  const el = $("#log");
  const div = document.createElement("div");
  div.className = "entry " + cls;
  div.innerHTML = html;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  if (++logCount > 200 && el.firstChild) el.removeChild(el.firstChild);
}

/* ============================================================
   人类操作界面
   ============================================================ */
function showHumanControls() {
  const human = G.players[0];
  const toCall = G.currentBet - human.bet;
  const actionRow = $("#action-row");
  actionRow.classList.remove("hidden");
  $("#raise-row").classList.add("hidden");
  showNextRow(false);

  const foldBtn = actionRow.querySelector('[data-action="fold"]');
  const checkBtn = actionRow.querySelector('[data-action="check"]');
  const callBtn = actionRow.querySelector('[data-action="call"]');
  const raiseBtn = actionRow.querySelector('[data-action="raise"]');
  const allinBtn = actionRow.querySelector('[data-action="allin"]');

  foldBtn.disabled = false;

  if (toCall <= 0) {
    checkBtn.classList.remove("hidden");
    callBtn.classList.add("hidden");
  } else {
    checkBtn.classList.add("hidden");
    callBtn.classList.remove("hidden");
    const callAmt = Math.min(toCall, human.stack);
    callBtn.innerHTML = `跟注<span class="amt">${callAmt}</span>`;
  }

  // 能否加注：剩余筹码须能超过当前跟注额
  const canRaise = human.bet + human.stack > G.currentBet && human.stack > 0;
  raiseBtn.disabled = !canRaise;
  allinBtn.disabled = human.stack <= 0;

  setCenterMessage("轮到你了");
}

function hideControls() {
  $("#action-row").classList.add("hidden");
  $("#raise-row").classList.add("hidden");
}

function showNextRow(show) {
  $("#next-row").classList.toggle("hidden", !show);
}

function openRaisePanel() {
  const human = G.players[0];
  const minTo = Math.min(G.currentBet + G.lastRaiseSize, human.bet + human.stack);
  const maxTo = human.bet + human.stack;
  const toCall = G.currentBet - human.bet;
  $("#action-row").classList.add("hidden");
  $("#raise-row").classList.remove("hidden");
  $("#rp-pot").textContent = potTotal();
  $("#rp-call").textContent = Math.max(0, toCall);
  $("#rp-range").textContent = minTo + "–" + maxTo;
  $("#rp-min").textContent = minTo;
  $("#rp-max").textContent = maxTo;
  const slider = $("#raise-slider");
  slider.min = minTo;
  slider.max = maxTo;
  slider.step = G.smallBlind;
  setRaiseValue(minTo);
}

function setRaiseValue(v) {
  const human = G.players[0];
  const minTo = Math.min(G.currentBet + G.lastRaiseSize, human.bet + human.stack);
  const maxTo = human.bet + human.stack;
  v = clamp(Math.round(v), minTo, maxTo);
  $("#raise-slider").value = v;
  $("#rp-value").textContent = v;
  $("#rp-confirm-amt").textContent = v;
}

function quickRaiseTarget(mult) {
  const human = G.players[0];
  const toCall = G.currentBet - human.bet;
  const pot = potTotal();
  const maxTo = human.bet + human.stack;
  if (mult === "max") return maxTo;
  const frac = { pot33: 1 / 3, pot50: 0.5, pot75: 0.75, pot100: 1 }[mult] || 0.5;
  // 加注幅度 = 跟注后底池的若干比例
  const raiseBy = (pot + toCall) * frac;
  return G.currentBet + raiseBy;
}

/* ============================================================
   交互事件绑定
   ============================================================ */
function bindEvents() {
  $("#action-row").addEventListener("click", (e) => {
    const btn = e.target.closest(".act-btn");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    if (action === "raise") {
      openRaisePanel();
      return;
    }
    if (G.toAct !== 0) return;
    actAndAdvance(0, action, 0);
  });

  $("#raise-slider").addEventListener("input", (e) => setRaiseValue(Number(e.target.value)));
  $("#rp-minus").addEventListener("click", () =>
    setRaiseValue(Number($("#raise-slider").value) - G.bigBlind)
  );
  $("#rp-plus").addEventListener("click", () =>
    setRaiseValue(Number($("#raise-slider").value) + G.bigBlind)
  );
  $("#raise-row").addEventListener("click", (e) => {
    const b = e.target.closest(".quick-bet");
    if (!b) return;
    setRaiseValue(quickRaiseTarget(b.dataset.mult));
  });
  $("#raise-confirm").addEventListener("click", () => {
    if (G.toAct !== 0) return;
    const target = Number($("#raise-slider").value);
    const maxTo = G.players[0].bet + G.players[0].stack;
    if (target >= maxTo) actAndAdvance(0, "allin", 0);
    else actAndAdvance(0, "raise", target);
  });
  $("#raise-cancel").addEventListener("click", () => {
    $("#raise-row").classList.add("hidden");
    showHumanControls();
  });

  $("#btn-next-hand").addEventListener("click", () => {
    showNextRow(false);
    G.players.forEach((p) => {
      p.isWinner = false;
      p.reveal = false;
    });
    setCenterMessage("");
    startHand();
  });

  $("#btn-start").addEventListener("click", startGame);
  $("#btn-help").addEventListener("click", () =>
    $("#help-overlay").classList.remove("hidden")
  );
  $("#btn-help-close").addEventListener("click", () =>
    $("#help-overlay").classList.add("hidden")
  );

  // 移动端侧栏抽屉
  const sidebar = $("#sidebar");
  const backdrop = $("#drawer-backdrop");
  const toggleDrawer = (open) => {
    if (!sidebar) return;
    const willOpen = open === undefined ? !sidebar.classList.contains("open") : open;
    sidebar.classList.toggle("open", willOpen);
    if (backdrop) backdrop.classList.toggle("hidden", !willOpen);
  };
  const panelBtn = $("#btn-panel");
  if (panelBtn) panelBtn.addEventListener("click", () => toggleDrawer());
  if (backdrop) backdrop.addEventListener("click", () => toggleDrawer(false));

  // 屏幕尺寸 / 方向变化时重排座位
  let _rsT;
  window.addEventListener("resize", () => {
    clearTimeout(_rsT);
    _rsT = setTimeout(() => {
      if (window.GAME_MODE === "solo" && G.stage !== "idle" && G.players.length) render();
    }, 160);
  });

  // 键盘快捷键
  document.addEventListener("keydown", (e) => {
    if (G.toAct !== 0) return;
    const ar = $("#action-row");
    if (ar.classList.contains("hidden")) return;
    if (e.key === "f") actAndAdvance(0, "fold", 0);
    else if (e.key === "c") {
      const toCall = G.currentBet - G.players[0].bet;
      actAndAdvance(0, toCall <= 0 ? "check" : "call", 0);
    } else if (e.key === "r") openRaisePanel();
  });
}

/* ============================================================
   开局 / 结束
   ============================================================ */
function startGame() {
  window.GAME_MODE = "solo";
  const numPlayers = Number($("#set-players").value);
  G.startStack = Number($("#set-stack").value);
  G.smallBlind = Number($("#set-blinds").value);
  G.bigBlind = G.smallBlind * 2;
  const myName = ($("#set-name").value || "你").slice(0, 10);

  G.players = [];
  G.players.push({
    name: myName,
    avatar: "😎",
    isHuman: true,
    stack: G.startStack,
  });

  const idxs = shuffle([0, 1, 2, 3, 4, 5, 6, 7]);
  for (let i = 0; i < numPlayers - 1; i++) {
    G.players.push({
      name: AI_NAMES[idxs[i]],
      avatar: AI_AVATARS[idxs[i]],
      isHuman: false,
      stack: G.startStack,
      aiAggro: 0.8 + Math.random() * 0.6,
      aiNoise: 0.12 + Math.random() * 0.12,
    });
  }

  G.dealer = -1;
  G.handNum = 0;
  $("#log").innerHTML = "";
  log("游戏开始，祝你好运！", "sys");

  $("#overlay").classList.add("hidden");
  startHand();
}

function gameOver(humanWon) {
  const overlay = $("#overlay");
  const card = overlay.querySelector(".overlay-card");
  const human = G.players.find((p) => p.isHuman);
  card.innerHTML = `
    <h2>♠ ♥ ♦ ♣</h2>
    <h1>${humanWon ? "🏆 你赢了！" : "游戏结束"}</h1>
    <p class="overlay-desc">${
      humanWon
        ? "你赢光了所有对手的筹码，成为本桌之王！"
        : `你出局了。最终筹码：${human ? human.stack : 0}`
    }</p>
    <button id="btn-restart" class="primary-btn big">再来一局</button>
  `;
  overlay.classList.remove("hidden");
  $("#btn-restart").addEventListener("click", () => location.reload());
}

/* ---------- 启动 ---------- */
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", bindEvents);
}

/* ---------- 测试导出（Node 环境） ---------- */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    score5,
    cmpScore,
    evaluate7,
    handName,
    buildPots,
    makeDeck,
    shuffle,
    startHand,
    estimateEquity,
    describeCurrentHand,
    G,
  };
}
