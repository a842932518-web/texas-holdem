/* ============================================================
   德州扑克 - 服务端权威引擎 (engine.js)
   纯逻辑 + 牌桌状态机，不依赖任何 DOM / 浏览器 API
   ============================================================ */
"use strict";

/* ---------- 常量 ---------- */
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const CAT_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];
const AI_NAMES = ["阿龙", "Bella", "老K", "Mia", "杰克", "Nina", "石头", "Cora"];
const AI_AVATARS = ["🤖", "🐯", "🦊", "🐼", "🦁", "🐧", "🐙", "🦄"];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const roundTo = (v, step) => Math.round(v / step) * step;
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

/* ============================================================
   牌库 / 牌型评估（移植自已验证的单机版）
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
      sHigh = 5;
    }
  }
  if (straight && flush) return { cat: 8, tb: [sHigh] };
  if (counts[0] === 4) return { cat: 7, tb: [groups[0][0], groups[1][0]] };
  if (counts[0] === 3 && counts[1] === 2) return { cat: 6, tb: [groups[0][0], groups[1][0]] };
  if (flush) return { cat: 5, tb: ranks.slice() };
  if (straight) return { cat: 4, tb: [sHigh] };
  if (counts[0] === 3) return { cat: 3, tb: [groups[0][0], ...groups.slice(1).map((g) => g[0])] };
  if (counts[0] === 2 && counts[1] === 2)
    return { cat: 2, tb: [groups[0][0], groups[1][0], groups[2][0]] };
  if (counts[0] === 2) return { cat: 1, tb: [groups[0][0], ...groups.slice(1).map((g) => g[0])] };
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
function handName(sc) {
  if (sc.cat === 8 && sc.tb[0] === 14) return "皇家同花顺";
  return CAT_NAMES[sc.cat];
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

/* ---------- 边池（接收 players 数组，含 totalBet/folded） ---------- */
function buildPots(players) {
  const contribs = players.map((p) => ({ p, amt: p.totalBet }));
  const pots = [];
  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
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
    if (pots.length && same(pots[pots.length - 1].eligible, eligible)) {
      pots[pots.length - 1].amount += amount;
    } else {
      pots.push({ amount, eligible });
    }
  }
  return pots;
}

/* ---------- AI 牌力评估 ---------- */
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
  const suitCnt = {};
  all.forEach((c) => (suitCnt[c.suit] = (suitCnt[c.suit] || 0) + 1));
  const flushDraw = Math.max(...Object.values(suitCnt)) === 4;
  const rset = [...new Set(all.map((c) => c.rank))].sort((a, b) => a - b);
  let straightDraw = false;
  for (let lo = 2; lo <= 11; lo++) {
    let inWin = 0;
    for (let r = lo; r < lo + 5; r++) if (rset.includes(r)) inWin++;
    if (inWin === 4) straightDraw = true;
  }
  return clamp((flushDraw ? 0.6 : 0) + (straightDraw ? 0.4 : 0), 0, 1);
}
function handStrength(player, community) {
  if (community.length === 0) return preflopStrength(player.hole);
  const sc = evaluate7([...player.hole, ...community]);
  const baseByCat = [0.18, 0.42, 0.62, 0.74, 0.82, 0.88, 0.93, 0.98, 1.0];
  let base = baseByCat[sc.cat];
  if (sc.cat === 0) base = 0.05 + ((sc.tb[0] - 2) / 12) * 0.22;
  else if (sc.cat === 1) base = 0.3 + ((sc.tb[0] - 2) / 12) * 0.25;
  base += drawBonus(player.hole, community) * 0.12;
  return clamp(base, 0, 1);
}

/* ============================================================
   Table：一张牌桌的权威状态机
   通过回调与外部(server)通信：
     onUpdate()        状态变化（server 据此向每位玩家广播定制视图）
     onLog(text, cls)  牌局日志
   ============================================================ */
let UID = 1;

class Table {
  constructor(opts = {}) {
    this.smallBlind = opts.smallBlind || 10;
    this.bigBlind = (opts.smallBlind || 10) * 2;
    this.startStack = opts.startStack || 2000;
    this.actionTimeoutMs = opts.actionTimeoutMs || 30000;

    this.players = []; // 座位顺序
    this.deck = [];
    this.community = [];
    this.button = -1; // dealer 座位下标
    this.handNum = 0;
    this.stage = "idle";
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.toAct = -1;
    this.searchStart = 0;
    this.handActive = false;
    this.waiting = true;
    this.log = [];

    this._timer = null;
    this._deadline = 0;
    this.onUpdate = () => {};
    this.onLog = () => {};
  }

  /* ---------- 玩家管理 ---------- */
  addPlayer({ id, name, isAI = false, avatar = "😎" }) {
    if (this.players.length >= 8) return null;
    const p = {
      id: id || "p" + UID++,
      name,
      avatar,
      isAI,
      stack: this.startStack,
      hole: [],
      folded: true, // 入座后下一手才参与
      allIn: false,
      bet: 0,
      totalBet: 0,
      acted: false,
      reveal: false,
      isWinner: false,
      wonAmount: 0,
      handScore: null,
      lastAction: null,
      connected: true,
      sittingOut: false, // 想玩；进行中加入则下一手才发牌
    };
    this.players.push(p);
    return p;
  }
  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0) return;
    const wasToAct = this.toAct === idx;
    this.players.splice(idx, 1);
    if (this.handActive) {
      if (this.toAct > idx) this.toAct--;
      if (this.button > idx) this.button--;
      if (this.searchStart > idx) this.searchStart = this.searchStart % Math.max(1, this.players.length);
      // 若正轮到被移除者，推进
      if (wasToAct) {
        this._clearTimer();
        this.toAct = -1;
        this.continueAction();
        return;
      }
    }
    this.onUpdate();
  }
  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }
  setConnected(id, v) {
    const p = this.getPlayer(id);
    if (!p) return;
    p.connected = v;
    if (!v) p.lastAction = "掉线";
    // 若轮到掉线玩家行动，自动处理
    if (this.handActive && this.toAct >= 0 && this.players[this.toAct] === p && !v) {
      this._clearTimer();
      const toCall = this.currentBet - p.bet;
      this.doAct(this.toAct, toCall <= 0 ? "check" : "fold", 0);
    } else {
      this.onUpdate();
    }
  }

  canPlay(p) {
    return p.stack > 0 && p.connected && !p.sittingOut;
  }
  seatedCount() {
    return this.players.length;
  }
  readyCount() {
    return this.players.filter((p) => p.stack > 0 && (p.isAI || p.connected)).length;
  }

  /* ---------- 座位顺序辅助 ---------- */
  nextPlayingIndex(from) {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (from + i) % n;
      if (this._inHand(this.players[idx])) return idx;
    }
    return -1;
  }
  _inHand(p) {
    return p._playing === true;
  }

  /* ---------- 开始一手 ---------- */
  startHand() {
    // 标记本手参与者
    this.players.forEach((p) => {
      p._playing = p.stack > 0 && p.connected && !p.sittingOut;
    });
    const playing = this.players.filter((p) => p._playing);
    if (playing.length < 2) {
      this.handActive = false;
      this.waiting = true;
      this.stage = "idle";
      this.onLog("等待玩家加入或开始……", "sys");
      this.onUpdate();
      return false;
    }

    this.handNum++;
    this.waiting = false;
    this.handActive = true;
    this.deck = shuffle(makeDeck());
    this.community = [];
    this.stage = "preflop";
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;

    this.players.forEach((p) => {
      p.hole = [];
      p.folded = !p._playing;
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

    // 庄家按钮推进到下一个在玩玩家
    this.button = this.nextPlayingIndex(this.button < 0 ? this.players.length - 1 : this.button);

    // 发底牌
    const order = [];
    let s = this.button;
    for (let i = 0; i < playing.length; i++) {
      s = this.nextPlayingIndex(s);
      order.push(s);
    }
    for (let r = 0; r < 2; r++) for (const idx of order) this.players[idx].hole.push(this.deck.pop());

    this.postBlinds(playing.length);
    this.onLog(`══ 第 ${this.handNum} 局 ══ 庄家：${this.players[this.button].name}`, "hl");

    let first;
    if (playing.length === 2) {
      first = this.button; // 单挑庄家先动
    } else {
      const sb = this.nextPlayingIndex(this.button);
      const bb = this.nextPlayingIndex(sb);
      first = this.nextPlayingIndex(bb);
    }
    this.searchStart = first;
    this.toAct = -1;
    this.onUpdate();
    setTimeout(() => this.continueAction(), 1000);
    return true;
  }

  postBlinds(playingCount) {
    let sb, bb;
    if (playingCount === 2) {
      sb = this.button;
      bb = this.nextPlayingIndex(this.button);
    } else {
      sb = this.nextPlayingIndex(this.button);
      bb = this.nextPlayingIndex(sb);
    }
    this._commit(this.players[sb], this.smallBlind);
    this.players[sb].lastAction = "小盲";
    this._commit(this.players[bb], this.bigBlind);
    this.players[bb].lastAction = "大盲";
    this.currentBet = this.bigBlind;
    this.lastRaiseSize = this.bigBlind;
    this.onLog(
      `${this.players[sb].name} 小盲 ${this.smallBlind}，${this.players[bb].name} 大盲 ${this.bigBlind}`,
      "sys"
    );
  }

  /* ---------- 下注原语 ---------- */
  _commit(p, amt) {
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
  _raiseTo(p, target) {
    const before = this.currentBet;
    const add = clamp(target - p.bet, 0, p.stack);
    this._commit(p, add);
    if (p.bet > before) {
      const rs = p.bet - before;
      this.currentBet = p.bet;
      if (rs >= this.lastRaiseSize) {
        this.lastRaiseSize = rs;
        for (const q of this.players) if (q !== p && !q.folded && !q.allIn) q.acted = false;
      }
    }
    p.acted = true;
  }

  /* ---------- 行动顺序 ---------- */
  findNextActor(start) {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const p = this.players[idx];
      if (!p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet)) return idx;
    }
    return -1;
  }

  continueAction() {
    if (!this.handActive) return;
    const active = this.players.filter((p) => !p.folded);
    if (active.length <= 1) {
      this.endHandUncontested(active[0]);
      return;
    }
    const next = this.findNextActor(this.searchStart);
    if (next === -1) {
      this.endBettingRound();
      return;
    }
    this.toAct = next;
    this._clearTimer();
    this.onUpdate();

    const p = this.players[next];
    if (p.isAI) {
      const d = this.aiDecide(p);
      this._timer = setTimeout(() => {
        this.doAct(next, d.action, d.amount);
      }, aiThinkDelay(d.action));
    } else if (!p.connected) {
      this._timer = setTimeout(() => {
        const toCall = this.currentBet - p.bet;
        this.doAct(next, toCall <= 0 ? "check" : "fold", 0);
      }, 400);
    } else {
      this._deadline = Date.now() + this.actionTimeoutMs;
      this._timer = setTimeout(() => {
        const toCall = this.currentBet - p.bet;
        this.onLog(`${p.name} 超时，自动${toCall <= 0 ? "过牌" : "弃牌"}`, "sys");
        this.doAct(next, toCall <= 0 ? "check" : "fold", 0);
      }, this.actionTimeoutMs);
    }
  }

  // 外部（真人）提交行动
  handleAction(playerId, action, amount) {
    if (!this.handActive) return { ok: false, msg: "当前没有进行中的牌局" };
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return { ok: false, msg: "你不在牌桌上" };
    if (idx !== this.toAct) return { ok: false, msg: "还没轮到你" };
    const v = this._validate(idx, action, amount);
    if (!v.ok) return v;
    this.doAct(idx, v.action, v.amount);
    return { ok: true };
  }

  _validate(idx, action, amount) {
    const p = this.players[idx];
    const toCall = this.currentBet - p.bet;
    if (action === "fold") return { ok: true, action, amount: 0 };
    if (action === "check") {
      if (toCall > 0) return { ok: false, msg: "当前有下注，不能过牌" };
      return { ok: true, action, amount: 0 };
    }
    if (action === "call") {
      if (toCall <= 0) return { ok: true, action: "check", amount: 0 };
      return { ok: true, action, amount: 0 };
    }
    if (action === "allin") return { ok: true, action, amount: 0 };
    if (action === "raise") {
      const maxTo = p.bet + p.stack;
      const minTo = Math.min(this.currentBet + this.lastRaiseSize, maxTo);
      let t = Math.round(Number(amount) || 0);
      if (t >= maxTo) return { ok: true, action: "allin", amount: 0 };
      if (t < minTo) t = minTo;
      return { ok: true, action: "raise", amount: t };
    }
    return { ok: false, msg: "未知操作" };
  }

  doAct(idx, action, amount) {
    this._clearTimer();
    this.applyAction(idx, action, amount);
    this.searchStart = (idx + 1) % this.players.length;
    this.toAct = -1;
    this.onUpdate();
    this.continueAction();
  }

  applyAction(idx, action, amount) {
    const p = this.players[idx];
    if (action === "fold") {
      p.folded = true;
      p.lastAction = "弃牌";
      this.onLog(`${p.name} 弃牌`);
    } else if (action === "check") {
      p.acted = true;
      p.lastAction = "过牌";
      this.onLog(`${p.name} 过牌`);
    } else if (action === "call") {
      const need = Math.min(this.currentBet - p.bet, p.stack);
      this._commit(p, need);
      p.acted = true;
      p.lastAction = p.allIn ? "跟注全下" : `跟注 ${need}`;
      this.onLog(`${p.name} 跟注 ${need}${p.allIn ? "（全下）" : ""}`);
    } else if (action === "raise") {
      const before = this.currentBet;
      this._raiseTo(p, amount);
      const verb = before > 0 ? "加注到" : "下注";
      p.lastAction = `${verb} ${p.bet}`;
      this.onLog(`${p.name} ${verb} ${p.bet}${p.allIn ? "（全下）" : ""}`);
    } else if (action === "allin") {
      this._raiseTo(p, p.bet + p.stack);
      p.lastAction = `全下 ${p.bet}`;
      this.onLog(`${p.name} 全下！(${p.bet})`, "hl");
    }
  }

  /* ---------- 轮次 / 街 ---------- */
  endBettingRound() {
    this._refundUncalled();
    this.onUpdate();
    setTimeout(() => this.nextStage(), 750);
  }
  _refundUncalled() {
    const live = this.players.filter((p) => p.bet > 0);
    if (live.length < 2) {
      if (live.length === 1) {
        const p = live[0];
        p.stack += p.bet;
        p.totalBet -= p.bet;
        p.bet = 0;
      }
      return;
    }
    const bets = live.map((p) => p.bet).sort((a, b) => b - a);
    if (bets[0] > bets[1]) {
      const top = live.find((p) => p.bet === bets[0]);
      const refund = bets[0] - bets[1];
      top.stack += refund;
      top.totalBet -= refund;
      top.bet -= refund;
      this.onLog(`返还 ${top.name} 未跟注的 ${refund}`, "sys");
    }
  }
  nextStage() {
    if (!this.handActive) return;
    this.players.forEach((p) => {
      if (!p.folded) p.lastAction = null;
    });
    if (this.stage === "preflop") {
      this._deal(3);
      this.stage = "flop";
    } else if (this.stage === "flop") {
      this._deal(1);
      this.stage = "turn";
    } else if (this.stage === "turn") {
      this._deal(1);
      this.stage = "river";
    } else if (this.stage === "river") {
      this.goShowdown();
      return;
    }
    this.startStreet();
  }
  _deal(k) {
    for (let i = 0; i < k; i++) this.community.push(this.deck.pop());
    const names = { flop: "翻牌", turn: "转牌", river: "河牌" };
    this.onLog(
      `— ${names[this.stage] || ""} — ${this.community.map((c) => rankLabel(c.rank) + c.suit).join(" ")}`,
      "hl"
    );
  }
  startStreet() {
    this.players.forEach((p) => {
      if (!p.folded && !p.allIn) p.acted = false;
      p.bet = 0;
    });
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.searchStart = this.nextPlayingIndex(this.button);
    this.onUpdate();
    setTimeout(() => this.continueAction(), 1000);
  }

  /* ---------- 结算 ---------- */
  endHandUncontested(winner) {
    this._refundUncalled();
    const amount = this.players.reduce((s, p) => s + p.totalBet, 0);
    if (winner) {
      winner.stack += amount;
      winner.wonAmount = amount;
      winner.isWinner = true;
      this.onLog(`${winner.name} 赢得底池 ${amount}（其余玩家弃牌）`, "hl");
    }
    this.players.forEach((p) => (p.totalBet = 0));
    this.stage = "showdown";
    this.handActive = false;
    this.toAct = -1;
    this.onUpdate();
    this._scheduleNext();
  }

  goShowdown() {
    this.stage = "showdown";
    this.handActive = false;
    this.toAct = -1;
    const contenders = this.players.filter((p) => !p.folded);
    contenders.forEach((p) => {
      p.reveal = true;
      p.handScore = evaluate7([...p.hole, ...this.community]);
    });
    const pots = buildPots(this.players);
    pots.forEach((pot, pi) => {
      if (pot.amount <= 0 || pot.eligible.length === 0) return;
      let best = null;
      for (const p of pot.eligible) if (!best || cmpScore(p.handScore, best.handScore) > 0) best = p;
      const winners = pot.eligible.filter((p) => cmpScore(p.handScore, best.handScore) === 0);
      this._award(pot.amount, winners);
      const label = pots.length > 1 ? (pi === 0 ? "主池" : `边池${pi}`) : "底池";
      this.onLog(
        `${winners.map((w) => w.name).join("、")} 以 ${best.handScore.name} 赢得${label} ${pot.amount}`,
        "hl"
      );
    });
    this.players.forEach((p) => (p.totalBet = 0));
    this.onUpdate();
    this._scheduleNext();
  }
  _award(amount, winners) {
    const n = this.players.length;
    const ordered = winners
      .slice()
      .sort(
        (a, b) =>
          ((this.players.indexOf(a) - this.button - 1 + n) % n) -
          ((this.players.indexOf(b) - this.button - 1 + n) % n)
      );
    const share = Math.floor(amount / winners.length);
    let rem = amount - share * winners.length;
    for (const w of ordered) {
      let got = share;
      if (rem > 0) {
        got++;
        rem--;
      }
      w.stack += got;
      w.wonAmount += got;
      w.isWinner = true;
    }
  }

  _scheduleNext() {
    // 自动开始下一手（若仍有≥2名可玩者）
    this._clearTimer();
    this._timer = setTimeout(() => {
      const ready = this.players.filter((p) => p.stack > 0 && (p.isAI || p.connected) && !p.sittingOut);
      if (ready.length >= 2) {
        this.startHand();
      } else {
        this.handActive = false;
        this.waiting = true;
        this.stage = "idle";
        this.onUpdate();
      }
    }, 4500);
  }

  /* ---------- AI ---------- */
  aiDecide(p) {
    const toCall = this.currentBet - p.bet;
    const pot = this.players.reduce((s, q) => s + q.totalBet, 0);
    let str = handStrength(p, this.community) + p.aiNoise * (Math.random() - 0.5);
    str = clamp(str, 0, 1);
    const aggro = p.aiAggro;
    const bluff = Math.random() < 0.06 * aggro;
    const raiseAct = (target) => {
      const mn = this.currentBet + this.lastRaiseSize;
      const mx = p.bet + p.stack;
      if (mx <= this.currentBet) return { action: "call" };
      if (mn > mx) return { action: "allin" };
      target = clamp(roundTo(target, this.smallBlind), mn, mx);
      if (target >= mx) return { action: "allin" };
      return { action: "raise", amount: target };
    };
    if (toCall <= 0) {
      if (str > 0.55 || bluff) return raiseAct(this.currentBet + pot * (0.4 + 0.4 * Math.random()) * aggro);
      return { action: "check" };
    }
    const potOdds = toCall / (pot + toCall);
    if (str > 0.78 && Math.random() < 0.6 * aggro)
      return raiseAct(this.currentBet + Math.max(pot * (0.6 + 0.5 * Math.random()) * aggro, this.lastRaiseSize));
    if (str >= potOdds + 0.05 || (bluff && toCall < p.stack * 0.25)) {
      if (str > 0.6 && Math.random() < 0.3 * aggro)
        return raiseAct(this.currentBet + pot * (0.5 + 0.4 * Math.random()) * aggro);
      return { action: "call" };
    }
    if (toCall <= this.bigBlind && str > 0.2 && Math.random() < 0.5) return { action: "call" };
    return { action: "fold" };
  }

  /* ---------- 工具 ---------- */
  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  /* ---------- 生成某玩家可见的状态视图 ---------- */
  stateFor(viewerId) {
    const viewer = this.getPlayer(viewerId);
    const pot = this.players.reduce((s, p) => s + p.totalBet, 0);
    const toActId = this.toAct >= 0 && this.players[this.toAct] ? this.players[this.toAct].id : null;

    const players = this.players.map((p, i) => {
      const show = p.id === viewerId || p.reveal;
      return {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        isAI: p.isAI,
        seat: i,
        stack: p.stack,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        sittingOut: p.sittingOut,
        connected: p.connected,
        isWinner: p.isWinner,
        wonAmount: p.wonAmount,
        lastAction: p.lastAction,
        isYou: p.id === viewerId,
        isDealer: i === this.button,
        hasCards: p.hole.length > 0 && !p.folded,
        hole: show ? p.hole : p.hole.length ? "hidden" : [],
        handName: p.reveal && p.handScore ? p.handScore.name : null,
      };
    });

    let options = null;
    if (this.handActive && toActId === viewerId && viewer) {
      const toCall = this.currentBet - viewer.bet;
      const maxTo = viewer.bet + viewer.stack;
      options = {
        toCall: Math.min(toCall, viewer.stack),
        canCheck: toCall <= 0,
        canRaise: maxTo > this.currentBet,
        minRaiseTo: Math.min(this.currentBet + this.lastRaiseSize, maxTo),
        maxRaiseTo: maxTo,
        pot,
        currentBet: this.currentBet,
        yourBet: viewer.bet,
        deadline: this._deadline,
      };
    }

    return {
      stage: this.stage,
      community: this.community,
      pot,
      handNum: this.handNum,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      button: this.button,
      toActId,
      yourId: viewerId,
      yourTurn: toActId === viewerId,
      handActive: this.handActive,
      waiting: this.waiting,
      players,
      options,
    };
  }
}

module.exports = {
  Table,
  // 纯算法导出（供测试）
  makeDeck,
  shuffle,
  score5,
  cmpScore,
  evaluate7,
  handName,
  buildPots,
  AI_NAMES,
  AI_AVATARS,
};
