/* ============================================================
   德州扑克 - 客户端联机模块 (online.js)
   自包含 IIFE，复用样式但不污染单机 game.js 的全局
   ============================================================ */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const RED = new Set(["♥", "♦"]);
  const rankLabel = (r) =>
    r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : String(r);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let ws = null;
  let myId = null;
  let lastState = null;
  let active = false; // 是否处于联机模式

  /* ---------- 入口与事件绑定 ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    $("#mode-solo").addEventListener("click", () => {
      window.GAME_MODE = null;
      $("#mode-overlay").classList.add("hidden");
      $("#overlay").classList.remove("hidden");
    });
    $("#mode-online").addEventListener("click", () => {
      window.GAME_MODE = "online";
      $("#mode-overlay").classList.add("hidden");
      $("#online-lobby").classList.remove("hidden");
      active = true;
      if (typeof window.renderHandHelper === "function") window.renderHandHelper(null);
      initServerField();
    });
    bindLobby();
    bindWaiting();
    bindControls();
    let _olRsT;
    window.addEventListener("resize", () => {
      clearTimeout(_olRsT);
      _olRsT = setTimeout(() => {
        if (window.GAME_MODE === "online" && active && lastState) render(lastState);
      }, 160);
    });
  });

  /* ---------- WebSocket / 服务器地址 ---------- */
  let currentUrl = null;

  function defaultServer() {
    // 同源网页访问时默认当前主机；APK/file 协议下为空，需用户填写
    if (location.protocol === "http:" || location.protocol === "https:") {
      return location.host || "";
    }
    return "";
  }
  function buildWsUrl(input) {
    input = (input || "").trim();
    if (!input) return null;
    if (/^wss?:\/\//i.test(input)) return input;
    if (/^https:\/\//i.test(input)) return "wss://" + input.slice(8);
    if (/^http:\/\//i.test(input)) return "ws://" + input.slice(7);
    // 纯主机：本地/私网/带端口默认 ws，其余默认 wss（公网通常走 https）
    const local =
      /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(input) || /:\d+$/.test(input);
    return (local ? "ws://" : "wss://") + input;
  }
  function initServerField() {
    const field = $("#ol-server");
    const saved = localStorage.getItem("poker_server") || defaultServer();
    if (field) field.value = saved;
    if (saved) ensureConnected(buildWsUrl(saved));
    else setConn("请填写服务器地址后创建/加入房间");
  }
  function ensureConnected(url, onReady) {
    if (!url) {
      setConn("请填写服务器地址");
      return;
    }
    if (ws && ws.readyState === 1 && currentUrl === url) {
      if (onReady) onReady();
      return;
    }
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    currentUrl = url;
    connect(url, onReady);
  }
  function connect(url, onReady) {
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setConn("无法连接：地址无效");
      return;
    }
    setConn("连接中…");
    ws.onopen = () => {
      setConn("已连接 ✓ 创建或加入房间");
      if (onReady) onReady();
    };
    ws.onclose = () => setConn("未连接（已断开）");
    ws.onerror = () => setConn("连接失败，请检查服务器地址");
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleServer(msg);
    };
  }
  function sendWS(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  function setConn(t) {
    const el = $("#ol-conn-status");
    if (el) el.textContent = t;
  }

  function handleServer(msg) {
    if (msg.type === "joined") {
      myId = msg.youId;
      $("#online-lobby").classList.add("hidden");
      $("#online-waiting").classList.remove("hidden");
    } else if (msg.type === "state") {
      lastState = msg.state;
      render(msg.state);
    } else if (msg.type === "log") {
      addLog(msg.text, msg.cls);
    } else if (msg.type === "error") {
      showError(msg.msg);
    }
  }

  /* ---------- 大厅 ---------- */
  function bindLobby() {
    const serverUrlFromField = () => {
      const raw = $("#ol-server").value.trim();
      if (!raw) {
        showError("请先填写服务器地址");
        return null;
      }
      localStorage.setItem("poker_server", raw);
      return buildWsUrl(raw);
    };
    $("#ol-create").addEventListener("click", () => {
      const url = serverUrlFromField();
      if (!url) return;
      const name = $("#ol-name").value.trim() || "玩家";
      const smallBlind = Number($("#ol-blinds").value);
      const startStack = Number($("#ol-stack").value);
      ensureConnected(url, () => sendWS({ type: "create", name, smallBlind, startStack }));
    });
    $("#ol-join").addEventListener("click", () => {
      const url = serverUrlFromField();
      if (!url) return;
      const name = $("#ol-name").value.trim() || "玩家";
      const code = $("#ol-code").value.trim().toUpperCase();
      if (code.length !== 4) return showError("请输入 4 位房间码");
      ensureConnected(url, () => sendWS({ type: "join", code, name }));
    });
    $("#ol-server").addEventListener("change", () => {
      const raw = $("#ol-server").value.trim();
      if (raw) {
        localStorage.setItem("poker_server", raw);
        ensureConnected(buildWsUrl(raw));
      }
    });
    $("#ol-code").addEventListener("input", (e) => {
      e.target.value = e.target.value.toUpperCase();
    });
    $("#ol-back").addEventListener("click", () => {
      if (ws) ws.close();
      active = false;
      window.GAME_MODE = null;
      $("#online-lobby").classList.add("hidden");
      $("#mode-overlay").classList.remove("hidden");
    });
  }
  function showError(msg) {
    const el = $("#ol-error");
    if (el) {
      el.textContent = msg;
      setTimeout(() => {
        if (el.textContent === msg) el.textContent = "";
      }, 4000);
    }
  }

  /* ---------- 等待室 ---------- */
  function bindWaiting() {
    $("#wait-addai").addEventListener("click", () => sendWS({ type: "addAI" }));
    $("#wait-start").addEventListener("click", () => sendWS({ type: "start" }));
    $("#wait-leave").addEventListener("click", leaveRoom);
  }
  function leaveRoom() {
    sendWS({ type: "leave" });
    if (ws) ws.close();
    active = false;
    window.GAME_MODE = null;
    myId = null;
    lastState = null;
    hideAllOverlays();
    if (typeof window.renderHandHelper === "function") window.renderHandHelper(null);
    $("#mode-overlay").classList.remove("hidden");
  }

  function renderWaiting(state) {
    $("#wait-code").textContent = state.code || "----";
    const box = $("#wait-players");
    box.innerHTML = state.players
      .map((p) => {
        const tags = [];
        if (p.id === state.hostId) tags.push('<span class="wtag host">房主</span>');
        if (p.isAI) tags.push('<span class="wtag ai">AI</span>');
        if (p.isYou) tags.push('<span class="wtag you">你</span>');
        if (!p.connected) tags.push('<span class="wtag off">掉线</span>');
        const rm =
          state.isHost && p.isAI
            ? `<button class="wtag-rm" data-rm="${p.id}">✕</button>`
            : "";
        return `<div class="wait-player"><span class="wp-ava">${p.avatar}</span><span class="wp-name">${escapeHtml(
          p.name
        )}</span><span class="wp-stack">${p.stack}</span>${tags.join("")}${rm}</div>`;
      })
      .join("");
    box.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => sendWS({ type: "removeAI", id: b.dataset.rm }))
    );

    if (state.isHost) {
      $("#wait-host").classList.remove("hidden");
      $("#wait-guest").classList.add("hidden");
      const startBtn = $("#wait-start");
      startBtn.disabled = !state.canStart;
      startBtn.textContent = state.canStart ? "开始游戏" : "至少需 2 人（可加 AI）";
      $("#wait-addai").disabled = state.players.length >= 8;
    } else {
      $("#wait-host").classList.add("hidden");
      $("#wait-guest").classList.remove("hidden");
    }
  }

  /* ---------- 主渲染分发 ---------- */
  function render(state) {
    updateTopbar(state);
    if (state.stage === "idle") {
      $("#online-waiting").classList.remove("hidden");
      $("#online-lobby").classList.add("hidden");
      renderWaiting(state);
      renderTable(state);
      hideControls();
    } else {
      hideAllOverlays();
      renderTable(state);
      renderControls(state);
    }
  }

  function updateTopbar(state) {
    const bi = $("#blind-info");
    const hc = $("#hand-counter");
    if (bi) bi.textContent = `房间 ${state.code} · 盲注 ${state.smallBlind}/${state.bigBlind}`;
    if (hc) hc.textContent = state.handNum ? `第 ${state.handNum} 局` : "等待开始";
  }

  /* ---------- 牌桌渲染 ---------- */
  function cardHTML(card, faceUp, big) {
    const cls = ["card"];
    if (big) cls.push("big");
    if (!faceUp || !card) {
      cls.push("back");
      return `<div class="${cls.join(" ")}"></div>`;
    }
    cls.push(RED.has(card.suit) ? "red" : "black");
    const r = rankLabel(card.rank);
    return `<div class="${cls.join(" ")}">
      <div class="corner-top"><span class="rank">${r}</span><span class="suit-sm">${card.suit}</span></div>
      <span class="suit-big">${card.suit}</span>
      <div class="corner-bottom"><span class="rank">${r}</span><span class="suit-sm">${card.suit}</span></div>
    </div>`;
  }

  function renderTable(state) {
    const seatsEl = $("#seats");
    const n = state.players.length;
    const myIdx = state.players.findIndex((p) => p.isYou);
    const baseIdx = myIdx >= 0 ? myIdx : 0;
    const R = typeof window.tableRadii === "function" ? window.tableRadii() : { rx: 47, ry: 44 };
    seatsEl.innerHTML = "";

    state.players.forEach((p, i) => {
      const rel = (i - baseIdx + n) % n; // 你固定在底部
      const ang = ((90 + (360 * rel) / n) * Math.PI) / 180;
      const x = 50 + R.rx * Math.cos(ang);
      const y = 50 + R.ry * Math.sin(ang);

      const div = document.createElement("div");
      div.className = "seat";
      if (p.isYou) div.classList.add("is-human");
      if (p.folded) div.classList.add("folded");
      const live = state.stage !== "idle" && state.stage !== "showdown";
      if (live && state.toActId === p.id && !p.folded && !p.allIn) div.classList.add("acting");
      if (p.isWinner) div.classList.add("winner");
      div.classList.add(y < 50 ? "pos-top" : "pos-bottom");
      div.style.left = x + "%";
      div.style.top = y + "%";

      let holeHTML = '<div class="hole-cards"></div>';
      if (p.hole === "hidden") {
        holeHTML = `<div class="hole-cards">${cardHTML(null, false)}${cardHTML(null, false)}</div>`;
      } else if (Array.isArray(p.hole) && p.hole.length) {
        holeHTML = `<div class="hole-cards">${p.hole.map((c) => cardHTML(c, true)).join("")}</div>`;
      }

      const st = seatStatus(p, state);
      const statusHTML = st ? `<div class="player-status show ${st.cls}">${st.text}</div>` : "";
      const dealerTag = p.isDealer ? `<div class="tag-d">D</div>` : "";
      const offCls = !p.connected ? " style=\"opacity:.5\"" : "";

      div.innerHTML = `
        ${holeHTML}
        <div class="player-box"${offCls}>
          ${dealerTag}
          <div class="avatar">${p.avatar}</div>
          <div class="player-meta">
            <div class="player-name">${escapeHtml(p.name)}${p.isAI ? " 🤖" : ""}</div>
            <div class="player-stack">${p.stack}</div>
          </div>
          ${statusHTML}
        </div>
        ${p.bet > 0 ? `<div class="bet-chips show">${p.bet}</div>` : ""}
      `;
      seatsEl.appendChild(div);
    });

    $("#community-cards").innerHTML = (state.community || []).map((c) => cardHTML(c, true, true)).join("");
    $("#pot-amount").textContent = state.pot;

    // 中央信息
    let center = "";
    if (state.stage === "showdown") {
      const winners = state.players.filter((p) => p.isWinner);
      if (winners.length)
        center =
          "摊牌！ " +
          winners.map((w) => `${w.name}${w.handName ? "（" + w.handName + "）" : ""} +${w.wonAmount}`).join("  ");
    }
    $("#center-message").textContent = center;

    // 牌型 + 胜率助手（复用 game.js 全局函数）
    if (typeof window.renderHandHelper === "function") {
      const me = state.players.find((p) => p.isYou);
      if (me && Array.isArray(me.hole) && me.hole.length >= 2 && !me.folded && state.stage !== "idle") {
        const numOpp = state.players.filter((p) => !p.folded && !p.isYou).length;
        window.renderHandHelper({ hole: me.hole, community: state.community || [], numOpp });
      } else {
        window.renderHandHelper(null);
      }
    }
  }

  function seatStatus(p, state) {
    const live = state.stage !== "idle" && state.stage !== "showdown";
    if (p.isWinner) return { text: `+${p.wonAmount}`, cls: "winner" };
    if (p.folded && p.hasCards === false && state.stage !== "idle" && p.lastAction === "弃牌")
      return { text: "弃牌", cls: "folded" };
    if (p.folded && state.stage !== "idle" && !p.sittingOut) return { text: "弃牌", cls: "folded" };
    if (p.allIn) return { text: "全下", cls: "allin" };
    if (!p.connected) return { text: "掉线", cls: "folded" };
    if (live && state.toActId === p.id) return { text: "行动中", cls: "action" };
    if (p.lastAction) return { text: p.lastAction, cls: "" };
    return null;
  }

  /* ---------- 操作控件 ---------- */
  function bindControls() {
    $("#ol-action-row").addEventListener("click", (e) => {
      const btn = e.target.closest(".act-btn");
      if (!btn || btn.disabled) return;
      const a = btn.dataset.ol;
      if (a === "raise") {
        openRaise();
        return;
      }
      if (!lastState || !lastState.yourTurn) return;
      sendWS({ type: "action", action: a, amount: 0 });
      hideControls();
    });

    document.querySelectorAll("#ol-raise-row [data-olmult]").forEach((b) =>
      b.addEventListener("click", () => setRaise(quickTarget(b.dataset.olmult)))
    );
    $("#ol-raise-slider").addEventListener("input", (e) => setRaise(Number(e.target.value)));
    $("#ol-rp-minus").addEventListener("click", () =>
      setRaise(Number($("#ol-raise-slider").value) - ((lastState && lastState.bigBlind) || 20))
    );
    $("#ol-rp-plus").addEventListener("click", () =>
      setRaise(Number($("#ol-raise-slider").value) + ((lastState && lastState.bigBlind) || 20))
    );
    $("#ol-raise-confirm").addEventListener("click", () => {
      if (!lastState || !lastState.yourTurn) return;
      const v = Number($("#ol-raise-slider").value);
      const max = lastState.options.maxRaiseTo;
      if (v >= max) sendWS({ type: "action", action: "allin", amount: 0 });
      else sendWS({ type: "action", action: "raise", amount: v });
      hideControls();
    });
    $("#ol-raise-cancel").addEventListener("click", () => {
      $("#ol-raise-row").classList.add("hidden");
      if (lastState && lastState.yourTurn) showActionRow(lastState.options);
    });
  }

  function renderControls(state) {
    if (state.yourTurn && state.options) {
      showActionRow(state.options);
      $("#ol-wait-turn").classList.add("hidden");
    } else {
      $("#ol-action-row").classList.add("hidden");
      $("#ol-raise-row").classList.add("hidden");
      if (state.stage !== "showdown" && state.toActId) {
        const who = state.players.find((p) => p.id === state.toActId);
        $("#ol-wait-turn").textContent = `等待 ${who ? who.name : "对手"} 行动…`;
        $("#ol-wait-turn").classList.remove("hidden");
      } else if (state.stage === "showdown") {
        $("#ol-wait-turn").textContent = "本局结束，即将开始下一局…";
        $("#ol-wait-turn").classList.remove("hidden");
      } else {
        $("#ol-wait-turn").classList.add("hidden");
      }
    }
  }

  function showActionRow(opt) {
    const row = $("#ol-action-row");
    row.classList.remove("hidden");
    $("#ol-raise-row").classList.add("hidden");
    const q = (s) => row.querySelector(s);
    if (opt.canCheck) {
      q("[data-ol=check]").classList.remove("hidden");
      q("[data-ol=call]").classList.add("hidden");
    } else {
      q("[data-ol=check]").classList.add("hidden");
      const call = q("[data-ol=call]");
      call.classList.remove("hidden");
      call.innerHTML = `跟注<span class="amt">${opt.toCall}</span>`;
    }
    const raiseBtn = q("[data-ol=raise]");
    raiseBtn.disabled = !opt.canRaise;
    raiseBtn.textContent = opt.currentBet > 0 ? "加注" : "下注";
  }

  function hideControls() {
    $("#ol-action-row").classList.add("hidden");
    $("#ol-raise-row").classList.add("hidden");
    $("#ol-wait-turn").classList.add("hidden");
  }

  function openRaise() {
    const opt = lastState && lastState.options;
    if (!opt) return;
    $("#ol-action-row").classList.add("hidden");
    $("#ol-raise-row").classList.remove("hidden");
    $("#ol-rp-pot").textContent = opt.pot;
    $("#ol-rp-call").textContent = Math.max(0, opt.toCall);
    $("#ol-rp-range").textContent = opt.minRaiseTo + "–" + opt.maxRaiseTo;
    $("#ol-rp-min").textContent = opt.minRaiseTo;
    $("#ol-rp-max").textContent = opt.maxRaiseTo;
    const slider = $("#ol-raise-slider");
    slider.min = opt.minRaiseTo;
    slider.max = opt.maxRaiseTo;
    slider.step = lastState.smallBlind || 10;
    setRaise(opt.minRaiseTo);
  }
  function setRaise(v) {
    const opt = lastState && lastState.options;
    if (!opt) return;
    v = clamp(Math.round(v), opt.minRaiseTo, opt.maxRaiseTo);
    $("#ol-raise-slider").value = v;
    $("#ol-rp-value").textContent = v;
    $("#ol-rp-confirm-amt").textContent = v;
  }
  function quickTarget(mult) {
    const opt = lastState.options;
    if (mult === "max") return opt.maxRaiseTo;
    const frac = { pot33: 1 / 3, pot50: 0.5, pot75: 0.75, pot100: 1 }[mult] || 0.5;
    return opt.currentBet + (opt.pot + opt.toCall) * frac;
  }

  /* ---------- 杂项 ---------- */
  function hideAllOverlays() {
    ["#mode-overlay", "#online-lobby", "#online-waiting", "#overlay", "#help-overlay"].forEach((s) => {
      const el = $(s);
      if (el) el.classList.add("hidden");
    });
  }
  let logN = 0;
  function addLog(html, cls) {
    if (!active) return;
    const el = $("#log");
    if (!el) return;
    const d = document.createElement("div");
    d.className = "entry " + (cls || "");
    d.innerHTML = html;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    if (++logN > 200 && el.firstChild) el.removeChild(el.firstChild);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
})();
