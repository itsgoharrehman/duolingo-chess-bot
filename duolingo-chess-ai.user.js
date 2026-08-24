// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (Pro Edition)
// @namespace    duochess-lite
// @version      4.2.0
// @description  Precision Duolingo Chess bot with atomic drag fallbacks, multi-tier move execution, zero stuck loops, watchdog anti-freeze, and clean SVG UI.
// @match        https://www.duolingo.com/*
// @match        https://*.duolingo.com/*
// @run-at       document-start
// @grant        none
// @connect      https://stockfish.online
// @connect      https://lichess.org
// @connect      https://esm.sh/chess.js@1.3.0
// @connect      https://esm.sh/js-chess-engine@2.3.2
// @license      MIT
// ==/UserScript==

(() => {
"use strict";

// ══════════════════════════════════════════════════════════════════════════════
//  DEVICE DETECTION & CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const UA = navigator.userAgent || "";
const IS_TABLET = /iPad|Tablet|(Android(?!.*Mobile))/i.test(UA);
const IS_MOBILE = (!IS_TABLET && /Android|iPhone|iPod|Mobile/i.test(UA))
    || (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1 && window.innerWidth < 768);

const DEVICE_TYPE = IS_MOBILE ? "mobile" : IS_TABLET ? "tablet" : "desktop";

const BOT_CFG = {
    engine:          "stockfish",
    jceLevel:        4,
    stockfishDepth:  15,
    clickDelay:      IS_MOBILE ? 130 : 50,
    moveDelay:       IS_MOBILE ? 260 : 150,
    thinkDelay:      IS_MOBILE ? 80 : 35,
    boardInsetRatio: 64 / 648,
    flipped:         false,
    autoPlay:        true,
    postMoves:       false,
};

const SOL_CFG = {
    boardInsetRatio: 64 / 648,
    clickDelay:      IS_MOBILE ? 130 : 50,
    moveDelay:       IS_MOBILE ? 260 : 150,
    enemyDelay:      IS_MOBILE ? 700 : 500,
    continueDelay:   IS_MOBILE ? 300 : 180,
    autoContinue:    true,
    flipped:         false,
};

const STORE_KEY = "duochess.v42.settings";

function loadSettings(){
    try{
        const saved = JSON.parse(localStorage.getItem(STORE_KEY)||"{}");
        if(saved.bot) Object.assign(BOT_CFG, saved.bot);
        if(saved.solver) Object.assign(SOL_CFG, saved.solver);
        if(typeof saved.matchesWon === "number") BOT_S.matchesWon = saved.matchesWon;
    }catch(_){}
}
function saveSettings(){
    try{
        localStorage.setItem(STORE_KEY, JSON.stringify({
            bot: BOT_CFG,
            solver: SOL_CFG,
            matchesWon: BOT_S.matchesWon
        }));
    }catch(_){}
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILS & STATE
// ══════════════════════════════════════════════════════════════════════════════

const sleep    = ms => new Promise(r => setTimeout(r, ms));
const UCI_RE   = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim());
const toUCI    = s => String(s).trim().split(/\s+/).filter(validUCI);
const esc      = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const fenSide  = fen => (fen?.split(" ")?.[1] ?? "w").toLowerCase();

let _lastStateChange = Date.now();

const BOT_S = {
    matchId: null, playerColor: "white",
    currentFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moveHistory: [], status: "idle", authToken: null,
    jce: null, jceReady: false,
    stockfish: null, stockfishReady: false,
    engineName: "Stockfish GM", lastMove: null,
    matchesWon: 0,
    movesPlayed: 0,
    _takeTurnLock: false,
};

function setStatus(newStatus) {
    if (BOT_S.status !== newStatus) {
        BOT_S.status = newStatus;
        _lastStateChange = Date.now();
        renderPanel();
    }
}

const SOL_STATE = {
    raw: null, challenges: [], currentIdx: 0, solving: false
};

loadSettings();

// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS DISCOVERY & HASHING
// ══════════════════════════════════════════════════════════════════════════════

let _canvasCache = { el: null, t: 0 };

function findCanvas() {
    const now = Date.now();
    const cacheMs = IS_MOBILE ? 220 : 100;
    if (_canvasCache.el && _canvasCache.el.isConnected && (now - _canvasCache.t) < cacheMs) {
        return _canvasCache.el;
    }
    const candidates = [...document.querySelectorAll("canvas")]
        .filter(c => {
            if (!c.isConnected) return false;
            const r = c.getBoundingClientRect();
            if (!(r.width > 160 && r.height > 160 && Math.abs(r.width/r.height - 1) < 0.35)) return false;
            const cs = getComputedStyle(c);
            if (cs.pointerEvents === "none") return false;
            return true;
        })
        .sort((a,b) => {
            const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
            return (rb.width*rb.height)-(ra.width*ra.height);
        });
    const picked = candidates[0] ?? null;
    _canvasCache = { el: picked, t: now };
    return picked;
}

async function waitCanvas(timeout=8000) {
    const t0=Date.now();
    const pollMs = IS_MOBILE ? 40 : 25;
    while(Date.now()-t0<timeout){ const c=findCanvas(); if(c) return c; await sleep(pollMs); }
    throw new Error("Canvas not found");
}

function canvasHash() {
    const canvas = findCanvas();
    if (!canvas) return null;
    try {
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const w = Math.min(canvas.width, 64), h = Math.min(canvas.height, 64);
        const d = ctx.getImageData(0, 0, w, h).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 16) s = (s * 31 + d[i] + d[i+1] + d[i+2]) | 0;
        return s;
    } catch (_) { return null; }
}

async function waitCanvasChange(baseline, timeout, interval) {
    timeout  = timeout  ?? (IS_MOBILE ? 1100 : 700);
    interval = interval ?? (IS_MOBILE ? 30   : 20);
    const canvas = findCanvas();
    if (!canvas || baseline === null) { await sleep(IS_MOBILE ? 80 : 40); return false; }
    const ctx = canvas.getContext("2d");
    if (!ctx) { await sleep(IS_MOBILE ? 80 : 40); return false; }
    const w = Math.min(canvas.width, 64), h = Math.min(canvas.height, 64);
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        await sleep(interval);
        try {
            const d = ctx.getImageData(0, 0, w, h).data;
            let s = 0;
            for (let i = 0; i < d.length; i += 16) s = (s * 31 + d[i] + d[i+1] + d[i+2]) | 0;
            if (s !== baseline) return true;
        } catch (_) { return false; }
    }
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CLEAN, UNIFIED POINTER EVENT DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════

function makeEvent(type, x, y, buttons = 0, button = 0) {
    const canvas = findCanvas();
    const r = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };
    const opts = {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: button, buttons: buttons,
        pressure: buttons ? 0.5 : 0,
        pointerId: 1,
        pointerType: IS_MOBILE ? "touch" : "mouse",
        isPrimary: true
    };
    let ev;
    if (typeof PointerEvent === "function") {
        try { ev = new PointerEvent(type, opts); } catch (_) { ev = new MouseEvent(type, opts); }
    } else {
        ev = new MouseEvent(type, opts);
    }
    try {
        Object.defineProperty(ev, 'offsetX', { value: x - r.left, configurable: true });
        Object.defineProperty(ev, 'offsetY', { value: y - r.top,  configurable: true });
        Object.defineProperty(ev, 'pageX',   { value: x + (window.scrollX || 0), configurable: true });
        Object.defineProperty(ev, 'pageY',   { value: y + (window.scrollY || 0), configurable: true });
        Object.defineProperty(ev, 'x',       { value: x, configurable: true });
        Object.defineProperty(ev, 'y',       { value: y, configurable: true });
    } catch (_) {}
    return ev;
}

async function dispatchTap(el, x, y, pressMs = 40) {
    if (!el) return;
    el.dispatchEvent(makeEvent("pointerdown", x, y, 1, 0));
    el.dispatchEvent(makeEvent("mousedown",   x, y, 1, 0));
    if (pressMs > 0) await sleep(pressMs);
    el.dispatchEvent(makeEvent("pointerup", x, y, 0, 0));
    el.dispatchEvent(makeEvent("mouseup",   x, y, 0, 0));
    el.dispatchEvent(makeEvent("click",     x, y, 0, 0));
}

async function dispatchDrag(el, x1, y1, x2, y2) {
    if (!el) return;
    el.dispatchEvent(makeEvent("pointerdown", x1, y1, 1, 0));
    el.dispatchEvent(makeEvent("mousedown",   x1, y1, 1, 0));
    await sleep(25);

    const xMid = (x1 + x2) / 2, yMid = (y1 + y2) / 2;
    el.dispatchEvent(makeEvent("pointermove", xMid, yMid, 1, 0));
    el.dispatchEvent(makeEvent("mousemove",   xMid, yMid, 1, 0));
    await sleep(25);

    el.dispatchEvent(makeEvent("pointermove", x2, y2, 1, 0));
    el.dispatchEvent(makeEvent("mousemove",   x2, y2, 1, 0));
    await sleep(35);

    el.dispatchEvent(makeEvent("pointerup", x2, y2, 0, 0));
    el.dispatchEvent(makeEvent("mouseup",   x2, y2, 0, 0));
    el.dispatchEvent(makeEvent("click",     x2, y2, 0, 0));
}

// ══════════════════════════════════════════════════════════════════════════════
//  SQUARE COORDINATE MAPPING & THREE-TIER MOVE EXECUTION
// ══════════════════════════════════════════════════════════════════════════════

function getSquareCoords(canvas, sq, insetRatio, flipped) {
    const r = canvas.getBoundingClientRect();
    const iw = r.width * insetRatio, ih = r.height * insetRatio;
    const bw = r.width - (iw * 2),   bh = r.height - (ih * 2);
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]);
    const col = flipped ? (7 - file) : file;
    const row = flipped ? (rank - 1) : (8 - rank);
    return {
        x: r.left + iw + (col + 0.5) * (bw / 8),
        y: r.top  + ih + (row + 0.5) * (bh / 8)
    };
}

async function clickSquare(sq, insetRatio, flipped, pressMs) {
    const canvas = await waitCanvas();
    const p = getSquareCoords(canvas, sq, insetRatio, flipped);
    await dispatchTap(canvas, p.x, p.y, pressMs ?? (IS_MOBILE ? 70 : 40));
}

async function clickCanvasFraction(colFrac, rowFrac, insetRatio, flipped, pressMs = 40) {
    const canvas = findCanvas();
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const iw = r.width * insetRatio, ih = r.height * insetRatio;
    const bw = r.width - (iw * 2),   bh = r.height - (ih * 2);
    const col = flipped ? (7 - colFrac) : colFrac;
    const row = flipped ? (7 - rowFrac) : rowFrac;
    const x = r.left + iw + col * (bw / 8);
    const y = r.top  + ih + row * (bh / 8);

    await dispatchTap(canvas, x, y, pressMs);

    const topEl = document.elementFromPoint(x, y);
    if (topEl && topEl !== canvas && !topEl.closest("#dc-pill")) {
        simulateFullClick(topEl);
    }
}

/**
 * Three-Tier Bulletproof Move Execution:
 * Tier 1: Crisp Dual-Tap (Source -> Wait Selection -> Dest)
 * Tier 2: Atomic Physical Drag (Source -> Dest)
 * Tier 3: Selection Reset (Outside Tap) + Drag Retry
 */
async function executeMove(uci, insetRatio, flipped) {
    if (!validUCI(uci)) return false;
    const fromSq = uci.slice(0, 2);
    const toSq   = uci.slice(2, 4);
    const canvas = await waitCanvas();
    const h0 = canvasHash();

    // ── Tier 1: Tap Source then Tap Destination ──
    const pFrom = getSquareCoords(canvas, fromSq, insetRatio, flipped);
    await dispatchTap(canvas, pFrom.x, pFrom.y, IS_MOBILE ? 60 : 35);

    await waitCanvasChange(h0, IS_MOBILE ? 350 : 200);
    await sleep(IS_MOBILE ? 60 : 30);

    const pTo = getSquareCoords(canvas, toSq, insetRatio, flipped);
    await dispatchTap(canvas, pTo.x, pTo.y, IS_MOBILE ? 60 : 35);

    const moved = await waitCanvasChange(h0, IS_MOBILE ? 450 : 250);
    if (moved) return true;

    // ── Tier 2: Atomic Physical Drag ──
    await sleep(40);
    const p1 = getSquareCoords(canvas, fromSq, insetRatio, flipped);
    const p2 = getSquareCoords(canvas, toSq, insetRatio, flipped);
    await dispatchDrag(canvas, p1.x, p1.y, p2.x, p2.y);

    const dragMoved = await waitCanvasChange(h0, IS_MOBILE ? 500 : 300);
    if (dragMoved) return true;

    // ── Tier 3: Clear Stuck Selection & Re-Drag ──
    const r = canvas.getBoundingClientRect();
    await dispatchTap(canvas, r.left + (r.width * 0.02), r.top + (r.height * 0.02), 20);
    await sleep(50);
    await dispatchDrag(canvas, p1.x, p1.y, p2.x, p2.y);
    await waitCanvasChange(h0, IS_MOBILE ? 500 : 300);

    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAWN PROMOTION
// ══════════════════════════════════════════════════════════════════════════════

function isPawnPromotion(fen, uci) {
    if (!uci || uci.length < 4) return false;
    if (uci.length >= 5) return true;
    const from = uci.slice(0, 2), to = uci.slice(2, 4);

    if (_Chess) {
        try {
            const c = new _Chess(fen);
            const piece = c.get(from);
            if (piece && piece.type === "p") {
                return (piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1");
            }
        } catch (_) {}
    }
    return (from[1] === "7" && to[1] === "8") || (from[1] === "2" && to[1] === "1");
}

function autoClickPromotion() {
    let clicked = false;

    // 1. Text node search
    try {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let n;
        while(n = walk.nextNode()) {
            const txt = (n.nodeValue || "").trim().toUpperCase();
            if(txt === "PAWN PROMOTION" || txt.includes("PAWN PROMOTION") || txt === "PROMOTION") {
                if(n.parentElement && !n.parentElement.closest("#dc-pill")) {
                    const card = n.parentElement.closest('div[class*="dialog" i], div[class*="card" i], div[class*="modal" i]') || n.parentElement;
                    const pieces = Array.from(card.querySelectorAll('button, svg, img, div[role="button"], li, div[tabindex="0"]'))
                        .filter(p => p.getBoundingClientRect().width > 18);
                    if (pieces.length > 0) {
                        pieces.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                        simulateFullClick(pieces[0]);
                        clicked = true;
                    }
                }
            }
        }
    } catch(e) {}

    // 2. Direct Queen Selectors
    const queenSelectors = [
        `[data-piece="queen"]`, `[data-piece="q"]`, `[data-piece="Q"]`,
        `[data-test="queen"]`, `[data-test="player-piece-queen"]`, `[data-test*="promotion-queen" i]`, `[data-test*="promote-queen" i]`,
        `button[aria-label*="queen" i]`, `div[role="button"][aria-label*="queen" i]`,
        `img[alt*="queen" i]`, `img[src*="queen" i]`, `svg[data-piece*="queen" i]`
    ];

    for (const sel of queenSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            if (isElementVisible(el) && !isForbiddenButton(el)) {
                simulateFullClick(el);
                clicked = true;
            }
        }
    }
    return clicked;
}

async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
    const destFile = destSq.charCodeAt(0) - 97;
    const destRank = Number(destSq[1]);

    for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(IS_MOBILE ? 80 : 50);
        if (autoClickPromotion()) return true;

        if (destRank === 8) {
            if (destFile < 4) {
                await clickCanvasFraction(0.5, 2.0, insetRatio, flipped, 30);
                await clickSquare("a6", insetRatio, flipped, 30);
            } else {
                await clickCanvasFraction(4.5, 2.0, insetRatio, flipped, 30);
                await clickSquare("e6", insetRatio, flipped, 30);
            }
        } else if (destRank === 1) {
            if (destFile < 4) {
                await clickCanvasFraction(0.5, 5.0, insetRatio, flipped, 30);
                await clickSquare("a3", insetRatio, flipped, 30);
            } else {
                await clickCanvasFraction(4.5, 5.0, insetRatio, flipped, 30);
                await clickSquare("e3", insetRatio, flipped, 30);
            }
        }
    }
    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOM ADVANCE FLOW & KEY DISPATCH
// ══════════════════════════════════════════════════════════════════════════════

function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("#dc-pill")) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
}

function isForbiddenButton(el) {
    if (!el) return true;
    const test = (el.getAttribute("data-test") || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    return test === "quit-button" || test === "close-button" || aria === "quit" || aria === "close" || aria === "leave";
}

function simulateFullClick(el) {
    if (!el || isForbiddenButton(el)) return false;
    try {
        if (typeof el.click === "function") el.click();

        const rKey = Object.keys(el).find(k => k.startsWith("__reactProps$") || k.startsWith("__reactEventHandlers$") || k.startsWith("__reactFiber$"));
        if (rKey && el[rKey]) {
            const props = el[rKey].memoizedProps || el[rKey];
            if (typeof props?.onClick === "function") {
                try { props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: el, currentTarget: el }); } catch (_) {}
            }
        }

        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;

        dispatchTap(el, x, y, 15);
        return true;
    } catch (_) {
        return false;
    }
}

function pressGlobalAdvanceKeys() {
    try {
        for (const key of ["Enter", " "]) {
            const code = key === " " ? "Space" : "Enter";
            const keyCode = key === " " ? 32 : 13;
            const evOpts = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, view: window };
            window.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            window.dispatchEvent(new KeyboardEvent("keyup", evOpts));
            document.dispatchEvent(new KeyboardEvent("keyup", evOpts));
        }
    } catch (_) {}
}

function advanceFlow() {
    if (!BOT_CFG.autoPlay) return false;

    if (autoClickPromotion()) return true;
    pressGlobalAdvanceKeys();

    const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, div[data-test*="button" i], div[data-test*="next" i], div[data-test*="continue" i]'
    ));

    const keywords = [
        "continue", "tiếp tục", "tiep tuc", "next", "claim", "claim reward", "claim xp",
        "play against oscar", "play oscar", "start match", "start game", "play match",
        "play again", "rematch", "start lesson", "start", "play", "let's go", "done", "check", "got it", "finish", "practice", "ready"
    ];

    for (const btn of candidates) {
        if (!isElementVisible(btn) || isForbiddenButton(btn)) continue;

        const dataTest = (btn.getAttribute("data-test") || "").toLowerCase();
        const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();

        if (dataTest.includes("player-next") || dataTest.includes("player-start-button") ||
            dataTest.includes("continue-button") || dataTest.includes("claim-button") ||
            dataTest.includes("start-button") || dataTest.includes("next-button") ||
            dataTest.includes("bottom-nav-next-button") || dataTest.includes("play-button") ||
            dataTest.includes("rematch-button") || dataTest.includes("session-end-button")) {
            simulateFullClick(btn);
            return true;
        }

        for (const kw of keywords) {
            if (txt === kw || txt.includes(kw) || ariaLabel.includes(kw) || dataTest.includes(kw.replace(/\s+/g, "-"))) {
                simulateFullClick(btn);
                return true;
            }
        }
    }
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CHESS ENGINES & MOVE SELECTION
// ══════════════════════════════════════════════════════════════════════════════

let _Chess = null;

async function loadChessJS(){
    try{
        const mod = await import("https://esm.sh/chess.js@1.3.0");
        _Chess = mod.Chess ?? mod.default?.Chess ?? mod.default;
        reparseChallenges();
        renderPanel();
    }catch(_){}
}

async function loadJCE(){
    try{
        const mod = await import("https://esm.sh/js-chess-engine@2.3.2");
        BOT_S.jce = mod.Game ?? mod.default?.Game;
        BOT_S.jceReady = true;
        renderPanel();
    } catch(_){}
}

async function loadStockfish(){
    try{
        const testFen = encodeURIComponent("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        const r = await _origFetch(`https://stockfish.online/api/s/v2.php?fen=${testFen}&depth=5&mode=bestmove`, { method: "GET" });
        if(!r.ok) throw new Error("HTTP "+r.status);
        const data = await r.json();
        if(!data.success) throw new Error("API error");
        BOT_S.stockfishReady = true;
        BOT_S.stockfish = { api: true };
        renderPanel();
        return true;
    } catch(_){
        return false;
    }
}

function findInstantMate(fen){
    if(!_Chess) return null;
    try{
        const c = new _Chess(fen);
        const moves = c.moves({verbose:true});
        for(const m of moves){
            c.move(m);
            if(c.isCheckmate()){ c.undo(); return m.from+m.to+(m.promotion??""); }
            c.undo();
        }
        for(const m of moves){
            c.move(m);
            const oppMoves = c.moves({verbose:true});
            if(oppMoves.length>0 && oppMoves.length<=3){
                let allOppLeadToMate = true;
                for(const om of oppMoves){
                    c.move(om);
                    const myResponses = c.moves({verbose:true});
                    const hasMate = myResponses.some(rm=>{ c.move(rm); const mate=c.isCheckmate(); c.undo(); return mate; });
                    c.undo();
                    if(!hasMate){ allOppLeadToMate=false; break; }
                }
                if(allOppLeadToMate){ c.undo(); return m.from+m.to+(m.promotion??""); }
            }
            c.undo();
        }
    }catch(_){}
    return null;
}

function getBookMove(fen){
    const fenSimple = fen.split(" ").slice(0, 4).join(" ");
    const whiteBook = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -": "e2e4",
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d1h5",
        "r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq -": "f1c4",
        "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1KBNR w KQkq -": "h5f7",
        "r1bqkbnr/pppp1p1p/2n3p1/4p2Q/2B1P3/8/PPPP1PPP/RNB1KBNR w KQkq -": "h5f3",
        "r1bqkb1r/pppp1p1p/2n2np1/4p3/2B1P3/5Q2/PPPP1PPP/RNB1KBNR w KQkq -": "f3b3",
        "r1bqkb1r/pppp1p1p/5np1/4p3/2BnP3/1Q6/PPPP1PPP/RNB1KBNR w KQkq -": "c4f7",
    };
    return whiteBook[fenSimple] ?? null;
}

async function getLichessCloudMove(fen){
    try{
        const encodedFen = encodeURIComponent(fen);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 900);
        const r = await _origFetch(`https://lichess.org/api/cloud-eval?fen=${encodedFen}&multiPv=1`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if(!r.ok) return null;
        const data = await r.json();
        const pvs = data.pvs?.[0];
        if(pvs && pvs.moves){
            const mv = pvs.moves.split(" ")[0];
            if(validUCI(mv)) return mv;
        }
    }catch(_){}
    return null;
}

async function stockfishBestMove(fen, depth=15){
    try{
        const encodedFen = encodeURIComponent(fen);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2500);
        const r = await _origFetch(`https://stockfish.online/api/s/v2.php?fen=${encodedFen}&depth=${depth}&mode=bestmove`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if(!r.ok) throw new Error("HTTP "+r.status);
        const data = await r.json();
        if(!data.success || !data.bestmove) throw new Error("No bestmove");
        const mv = data.bestmove.replace(/^bestmove\s*/,"").split(/\s+/)[0];
        return validUCI(mv) ? mv : null;
    } catch(_){
        return null;
    }
}

async function getBestMove(fen){
    const instantMate = findInstantMate(fen);
    if(instantMate){ BOT_S.engineName = "Mate 1/2"; return instantMate; }

    const bookMv = getBookMove(fen);
    if(bookMv){ BOT_S.engineName = "Book"; return bookMv; }

    const lichessMv = await getLichessCloudMove(fen);
    if(lichessMv){ BOT_S.engineName = "Lichess"; return lichessMv; }

    const sfMv = await stockfishBestMove(fen, BOT_CFG.stockfishDepth);
    if(sfMv){ BOT_S.engineName = "Stockfish"; return sfMv; }

    if(BOT_S.jceReady && BOT_S.jce){
        try{
            const game = new BOT_S.jce(fen), obj = game.aiMove(BOT_CFG.jceLevel);
            const [from,to] = Object.entries(obj)[0];
            let uci = from.toLowerCase() + to.toLowerCase();
            if((parseInt(from[1])===7&&parseInt(to[1])===8)||(parseInt(from[1])===2&&parseInt(to[1])===1)) uci+="q";
            BOT_S.engineName = "JCE";
            return uci;
        }catch(_){}
    }

    if(_Chess){
        try{
            const chess = new _Chess(fen), moves = chess.moves({verbose:true});
            if(moves.length){
                moves.sort((a,b) => (b.captured ? 10 : 0) - (a.captured ? 10 : 0));
                const m = moves[0];
                BOT_S.engineName = "chess.js";
                return m.from + m.to + (m.promotion??"");
            }
        }catch(_){}
    }

    return "e2e4";
}

// ══════════════════════════════════════════════════════════════════════════════
//  MATCH TURN EXECUTION
// ══════════════════════════════════════════════════════════════════════════════

const MATCHES_RE = /\/chess\/\d+\/\d+\/matches(?:\/([^/?#]+))?/;
const MOVES_RE   = /\/chess\/\d+\/\d+\/matches\/[^/?#]+\/moves/;
const isMatchURL = url => MATCHES_RE.test(url) && !MOVES_RE.test(url);
const isSessionURL = url => typeof url==="string" && /\/sessions(?:[/?#]|$)/i.test(url);

function isOurTurn(fen){
    if(!BOT_S.matchId) return false;
    const s = fenSide(fen);
    const color = (BOT_S.playerColor || "white").toLowerCase();
    return (s==="w" && color==="white") || (s==="b" && color==="black");
}

function onMatchData(data){
    if(!data) return;
    const match = data.match ?? (data.boardFen ? data : null);
    if(!match) return;

    const uid = location.pathname.match(/\/(\d+)\//)?.[1] ?? "";
    if(match.id && BOT_S.matchId!==match.id){
        BOT_S.matchId = match.id;
        BOT_S.movesPlayed = 0;
        if(match.playerColor) BOT_S.playerColor = match.playerColor.toLowerCase();
        else if(match.whitePlayer && (String(match.whitePlayer.userId)===uid || String(match.whitePlayer.id)===uid)) BOT_S.playerColor = "white";
        else if(match.blackPlayer && (String(match.blackPlayer.userId)===uid || String(match.blackPlayer.id)===uid)) BOT_S.playerColor = "black";
        else BOT_S.playerColor = "white";
    }

    if(match.boardFen) BOT_S.currentFen = match.boardFen;
    if(Array.isArray(match.moveHistory)) BOT_S.moveHistory = [...match.moveHistory];

    if(match.endCondition || match.status==="finished"){
        BOT_S.matchId = null;
        BOT_S.matchesWon++;
        saveSettings();
        setStatus("idle");
        advanceFlow();
        setTimeout(advanceFlow, 300);
        setTimeout(advanceFlow, 700);
        return;
    }

    if(match.status==="active" && isOurTurn(BOT_S.currentFen)){
        if(BOT_S.status!=="thinking" && BOT_S.status!=="playing"){
            setStatus("our_turn");
            if(BOT_CFG.autoPlay) setTimeout(takeTurn, BOT_CFG.thinkDelay);
        }
    } else {
        if(BOT_S.status!=="thinking" && BOT_S.status!=="playing"){
            setStatus("waiting");
        }
    }
}

async function takeTurn(){
    if(BOT_S._takeTurnLock) return;
    BOT_S._takeTurnLock = true;
    setStatus("thinking");

    try {
        let move=null, fenUsed=null;
        let attempts=0;
        while(attempts++<2){
            fenUsed = BOT_S.currentFen;
            move = await getBestMove(fenUsed);
            if(!move) break;
            if(fenUsed === BOT_S.currentFen) break;
            if(_Chess){
                try{
                    const c = new _Chess(BOT_S.currentFen);
                    const ok = c.moves({verbose:true}).some(m => m.from+m.to+(m.promotion??"") === move);
                    if(ok) break;
                }catch(_){}
            }
            move = null;
        }
        if(!move){ setStatus("idle"); return; }

        setStatus("playing");
        BOT_S.lastMove = move;

        const flip = BOT_CFG.flipped || (BOT_S.playerColor || "").toLowerCase() === "black";
        const isPromotion = isPawnPromotion(BOT_S.currentFen, move);

        // Execute verified move
        await executeMove(move, BOT_CFG.boardInsetRatio, flip);

        // Handle Queen promotion if applicable
        if(isPromotion){
            const promoChar = move[4] || "q";
            await handlePromotion(move.slice(2,4), promoChar, BOT_CFG.boardInsetRatio, flip);
        }

        await sleep(BOT_CFG.moveDelay);

        BOT_S.movesPlayed++;
        setStatus("waiting");
    } catch(e){
        setStatus("idle");
    } finally {
        BOT_S._takeTurnLock = false;
        renderPanel();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SOLVER (PUZZLES & LESSONS)
// ══════════════════════════════════════════════════════════════════════════════

function _sanitizeDuoFen(fen){
    const parts=fen.split(" ");
    const rows=parts[0].split("/");
    rows[0]=rows[0].replace(/[pP]/g,ch=>ch==="p"?"q":"Q");
    rows[7]=rows[7].replace(/[pP]/g,ch=>ch==="p"?"q":"Q");
    parts[0]=rows.join("/");
    const board=parts[0];
    const hasWK=/K/.test(board), hasBK=/k/.test(board);
    if(!hasWK||!hasBK){
        const r2=parts[0].split("/");
        const expand=row=>{const c=[];for(const ch of row){if(/\d/.test(ch))for(let i=0;i<+ch;i++)c.push(".");else c.push(ch);}return c;};
        const compress=c=>{let s="",e=0;for(const x of c){if(x==="."){e++;}else{if(e)s+=e;s+=x;e=0;}}if(e)s+=e;return s;};
        const grid=r2.map(expand);
        const place=(g,p,rs)=>{for(const r of rs)for(let f=7;f>=0;f--)if(g[r][f]==="."){g[r][f]=p;return;}};
        if(!hasWK) place(grid,"K",[7,6,5,4]);
        if(!hasBK) place(grid,"k",[0,1,2,3]);
        parts[0]=grid.map(compress).join("/");
        if(parts.length>=3) parts[2]="-";
    }
    return parts.join(" ");
}

function _forceWhite(fen){
    const p=fen.split(" ");
    p[1]="w"; p[2]="-"; p[3]="-";
    return p.join(" ");
}

function starCaptureAdapter(fen, seedMoves, maxMoves){
    if(!_Chess) return null;
    try{
        let workFen=_sanitizeDuoFen(fen);
        const steps=[];
        const limit=maxMoves??16;
        const pieceVal={p:1,n:3,b:3,r:5,q:9,k:0};
        for(const uci of seedMoves){
            if(!validUCI(uci)) continue;
            workFen=_forceWhite(workFen);
            const c=new _Chess(workFen);
            const res=c.move({from:uci.slice(0,2),to:uci.slice(2,4),promotion:uci[4]??undefined});
            if(!res) break;
            steps.push({kind:"player",move:uci});
            workFen=_forceWhite(c.fen());
        }
        let iters=0;
        while(steps.length<limit&&iters++<32){
            workFen=_forceWhite(workFen);
            const c=new _Chess(workFen);
            const moves=c.moves({verbose:true});
            const caps=moves.filter(m=>m.captured&&m.captured!=="k");
            if(!caps.length) break;
            caps.sort((a,b)=>(pieceVal[b.captured??""]??0)-(pieceVal[a.captured??""]??0));
            const best=caps[0];
            c.move(best);
            workFen=c.fen();
            steps.push({kind:"player",move:best.from+best.to+(best.promotion??"")});
        }
        return steps.length>0 ? steps : null;
    }catch(_){ return null; }
}

function buildSequence(info, fen){
    const correct=(info.correctMoves??[]).flatMap(toUCI);
    const enemy=(info.enemyMoves??[]).flatMap(toUCI);
    const validPth=(info.validPaths??[]).map(v=>toUCI(String(v)));
    const hiMoves=(info.highlight??[]).flatMap(v=>String(v).match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/g)??[]);
    const maxMoves=info.maxMoves??undefined;

    if(correct.length>0){
        const steps=correct.map(m=>({kind:"player",move:m}));
        if(enemy.length>0){
            const mixed=[];
            correct.forEach((m,i)=>{mixed.push({kind:"player",move:m});if(i<enemy.length)mixed.push({kind:"enemy",move:enemy[i]});});
            return{source:"correctMoves",steps:mixed,allPaths:validPth};
        }
        return{source:"correctMoves",steps,allPaths:validPth};
    }
    if(validPth.length>0&&validPth[0].length>0){
        return{source:"validPaths",steps:validPth[0].map(m=>({kind:"player",move:m})),allPaths:validPth};
    }
    if(hiMoves.length>0){
        if(_Chess&&fen){
            const adapted=starCaptureAdapter(fen,hiMoves,maxMoves);
            if(adapted&&adapted.length>0) return{source:"adapter(highlight)",steps:adapted,allPaths:[]};
        }
        return{source:"highlight",steps:hiMoves.map(m=>({kind:"player",move:m})),allPaths:[]};
    }
    if(_Chess&&fen){
        const adapted=starCaptureAdapter(fen,[],maxMoves);
        if(adapted&&adapted.length>0) return{source:"adapter(fen)",steps:adapted,allPaths:[]};
    }
    return{source:"none",steps:[],allPaths:[]};
}

function parseChallenge(raw,idx){
    const p=buildSequence(raw?.chessPuzzleInfo??{}, raw?.fen??"");
    const isBlack = (raw?.playerColor === "black") || (raw?.fen && fenSide(raw.fen) === "b");
    return{idx,id:raw.id??`ch_${idx}`,fen:raw.fen??"",isBlack,source:p.source,steps:p.steps,allPaths:p.allPaths,raw};
}

function reparseChallenges(){
    if(!SOL_STATE.raw||!SOL_STATE.challenges.length) return;
    const prevIdx=SOL_STATE.currentIdx;
    SOL_STATE.challenges=[...(SOL_STATE.raw.challenges??[]),...(SOL_STATE.raw.adaptiveChallenges??[])].map(parseChallenge);
    SOL_STATE.currentIdx=prevIdx;
    renderPanel();
}

function processSession(session){
    if(!Array.isArray(session?.challenges)) return;
    SOL_STATE.raw=session; SOL_STATE.currentIdx=0;
    SOL_STATE.challenges=[...(session.challenges??[]),...(session.adaptiveChallenges??[])].map(parseChallenge);
    renderPanel();
    if(BOT_CFG.autoPlay && !SOL_STATE.solving){
        setTimeout(solveAll, 120);
    }
}

async function solveChallenge(ch){
    if(!ch.steps.length) return;
    const flip = SOL_CFG.flipped || !!ch.isBlack;

    for(const step of ch.steps){
        renderPanel();
        if(step.kind==="player"){
            if(!validUCI(step.move)) continue;
            await executeMove(step.move, SOL_CFG.boardInsetRatio, flip);
            await sleep(SOL_CFG.moveDelay);
        } else {
            const h1=canvasHash();
            await waitCanvasChange(h1, SOL_CFG.enemyDelay);
            await sleep(IS_MOBILE ? 60 : 35);
        }
    }
    if(SOL_CFG.autoContinue){
        await sleep(SOL_CFG.continueDelay);
        advanceFlow();
    }
}

async function solveAll(){
    if(SOL_STATE.solving) return;
    SOL_STATE.solving=true;
    try{
        while(SOL_STATE.currentIdx<SOL_STATE.challenges.length){
            const ch=SOL_STATE.challenges[SOL_STATE.currentIdx];
            if(!ch) break;
            await solveChallenge(ch);
            SOL_STATE.currentIdx++;
            renderPanel();
            await sleep(IS_MOBILE ? 220 : 120);
        }
        await sleep(IS_MOBILE ? 300 : 180);
        advanceFlow();
    } finally {
        SOL_STATE.solving=false;
        renderPanel();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK INTERCEPTION & STATE RECOVERY
// ══════════════════════════════════════════════════════════════════════════════

let _lastSessionUrl = null;
const _origFetch=window.fetch;
window.fetch=async function(...args){
    const res=await _origFetch.apply(this,args);
    const url=typeof args[0]==="string"?args[0]:(args[0]?.url??res.url??"");
    if(args[1]?.headers){const h=args[1].headers;const tok=typeof h.get==="function"?h.get("authorization"):h["authorization"];if(tok)BOT_S.authToken=tok;}
    if(isMatchURL(url))   res.clone().json().then(onMatchData).catch(()=>{});
    if(isSessionURL(url)) { _lastSessionUrl = url; res.clone().json().then(processSession).catch(()=>{}); }
    return res;
};
const _xOpen=XMLHttpRequest.prototype.open,_xSend=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,url,...r){this.__dcUrl=String(url??"");return _xOpen.call(this,m,url,...r);};
XMLHttpRequest.prototype.send=function(...args){
    const url=this.__dcUrl;
    if(isMatchURL(url)||isSessionURL(url)){
        this.addEventListener("load",()=>{
            try{const d=this.responseType==="json"?this.response:JSON.parse(this.responseText);if(isMatchURL(url))onMatchData(d);if(isSessionURL(url)){_lastSessionUrl=url;processSession(d);}}catch(_){}
        });
    }
    return _xSend.apply(this,args);
};

async function _fetchSession() {
    let sessionUrl = _lastSessionUrl;
    if (!sessionUrl) {
        try {
            const SESSION_RE = /\/sessions(?:[/?#&]|$)/i;
            const hit = performance.getEntriesByType("resource").find(e => SESSION_RE.test(e.name));
            if (hit) sessionUrl = hit.name;
        } catch (_) {}
    }
    if (sessionUrl) {
        try {
            const hdrs = {}; if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
            const r = await _origFetch(sessionUrl, { method: "GET", headers: hdrs, credentials: "include" });
            if (r.ok) { const data = await r.json(); processSession(data); return true; }
        } catch (_) {}
    }
    return false;
}

async function _fetchMatchState() {
    if (!BOT_S.matchId) return;
    const uid = location.pathname.match(/\/(\d+)\//)?.[1] ?? "0";
    const hdrs = {}; if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
    try {
        const res = await _origFetch(`/chess/1/${uid}/matches/${BOT_S.matchId}`, { method: "GET", headers: hdrs, credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        onMatchData(data);
    } catch (_) {}
}

async function recoverState() {
    try {
        const entries = performance.getEntriesByType("resource");
        for (const e of entries) {
            const matchHit = e.name.match(/\/chess\/\d+\/\d+\/matches\/([^/?#]+)/);
            if (matchHit && matchHit[1] && !e.name.includes('/moves')) {
                BOT_S.matchId = matchHit[1];
                await _fetchMatchState();
                return;
            }
        }
        if (!location.pathname.includes("chess")) {
            await _fetchSession();
        }
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  SVG DEVICE ICONS & CLEAN STATUS PILL UI (ZERO EMOJIS)
// ══════════════════════════════════════════════════════════════════════════════

const SVG_ICONS = {
    desktop: `<svg class="dc-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#58cc02" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    tablet:  `<svg class="dc-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#58cc02" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`,
    mobile:  `<svg class="dc-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#58cc02" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>`
};

const DEVICE_ICON_SVG = SVG_ICONS[DEVICE_TYPE] || SVG_ICONS.desktop;

let _panel = null;

const STYLE = `
#dc-pill{
    position:fixed;bottom:20px;right:16px;
    background:rgba(15,23,42,0.97);border:1px solid rgba(255,255,255,0.14);
    border-radius:14px;padding:10px 14px;
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color:#f8fafc;z-index:2147483647;user-select:none;
    box-shadow:0 8px 28px rgba(0,0,0,0.65);
    display:flex;flex-direction:column;gap:8px;
    min-width:${IS_MOBILE ? '160px' : '185px'};cursor:grab;touch-action:none;
    font-size:${IS_MOBILE ? '13px' : '12px'};
}
#dc-pill.dragging{cursor:grabbing;opacity:0.90;}
.dc-header{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dc-brand-wrap{display:flex;align-items:center;gap:6px;}
.dc-icon{display:inline-block;vertical-align:middle;flex-shrink:0;}
.dc-brand{font-weight:900;color:#58cc02;font-size:${IS_MOBILE ? '13px' : '12px'};letter-spacing:0.5px;}
.dc-status{
    font-size:${IS_MOBILE ? '10px' : '9px'};font-weight:800;padding:3px 7px;border-radius:5px;
    background:#334155;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px;
}
.dc-status.active{background:#15803d;color:#fff;}
.dc-status.thinking{background:#b45309;color:#fff;}
.dc-body-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.dc-btn{
    background:#58cc02;color:#000;border:none;border-radius:8px;
    padding:${IS_MOBILE ? '8px 12px' : '6px 10px'};
    font-size:${IS_MOBILE ? '12px' : '11px'};font-weight:800;cursor:pointer;
    min-height:${IS_MOBILE ? '36px' : '28px'};
}
.dc-btn.off{background:#334155;color:#94a3b8;}
.dc-stat-box{display:flex;align-items:center;gap:12px;}
.dc-stat-item{display:flex;flex-direction:column;align-items:center;}
.dc-stat-num{font-size:${IS_MOBILE ? '18px' : '16px'};font-weight:900;line-height:1;}
.dc-stat-num.win{color:#58cc02;}
.dc-stat-num.mov{color:#38bdf8;}
.dc-stat-label{font-size:${IS_MOBILE ? '9px' : '8px'};color:#64748b;font-weight:700;text-transform:uppercase;margin-top:2px;}
`;

function injectCSS(){
    if(document.getElementById("dc-style")) return;
    const s=document.createElement("style");
    s.id="dc-style";
    s.textContent=STYLE;
    document.head.appendChild(s);
}

function createPanel(){
    injectCSS();
    if(_panel){ _panel.remove(); _panel=null; }

    _panel=document.createElement("div");
    _panel.id="dc-pill";

    _panel.innerHTML=`
    <div class="dc-header">
        <div class="dc-brand-wrap">
            ${DEVICE_ICON_SVG}
            <span class="dc-brand">DUOCHESS</span>
        </div>
        <span class="dc-status" id="dc-st">${esc(BOT_S.status)}</span>
    </div>
    <div class="dc-body-row">
        <button id="dc-tg" class="dc-btn ${BOT_CFG.autoPlay?'':'off'}">${BOT_CFG.autoPlay?'AUTO: ON':'AUTO: OFF'}</button>
        <div class="dc-stat-box">
            <div class="dc-stat-item">
                <span class="dc-stat-num win" id="dc-w">${BOT_S.matchesWon}</span>
                <span class="dc-stat-label">Wins</span>
            </div>
            <div class="dc-stat-item">
                <span class="dc-stat-num mov" id="dc-m">${BOT_S.movesPlayed}</span>
                <span class="dc-stat-label">Moves</span>
            </div>
        </div>
    </div>`;

    document.body.appendChild(_panel);

    const tg=_panel.querySelector("#dc-tg");
    tg.addEventListener("pointerdown",(e)=>e.stopPropagation());
    tg.addEventListener("click",(e)=>{
        e.stopPropagation();
        BOT_CFG.autoPlay=!BOT_CFG.autoPlay;
        saveSettings();
        tg.classList.toggle("off",!BOT_CFG.autoPlay);
        tg.textContent=BOT_CFG.autoPlay?'AUTO: ON':'AUTO: OFF';
    });

    makeDraggable(_panel);
    renderPanel();
}

function makeDraggable(el){
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    try{
        const saved = JSON.parse(localStorage.getItem(STORE_KEY+"_pos")||"null");
        if(saved && typeof saved.left === "number" && typeof saved.top === "number"){
            const maxL = Math.max(10, window.innerWidth - 210);
            const maxT = Math.max(10, window.innerHeight - 80);
            el.style.left = Math.min(maxL, Math.max(10, saved.left)) + "px";
            el.style.top = Math.min(maxT, Math.max(10, saved.top)) + "px";
            el.style.bottom = "auto";
            el.style.right = "auto";
        }
    }catch(_){}

    function initPos(){
        const rect = el.getBoundingClientRect();
        el.style.left = rect.left + "px";
        el.style.top = rect.top + "px";
        el.style.bottom = "auto";
        el.style.right = "auto";
    }

    el.addEventListener("pointerdown", (e)=>{
        if(e.target.tagName === "BUTTON" || e.target.closest("button")) return;
        initPos();
        isDragging = true;
        try { el.setPointerCapture(e.pointerId); } catch(_) {}
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        el.classList.add("dragging");
        e.preventDefault();
    });

    el.addEventListener("pointermove", (e)=>{
        if(!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const maxLeft = Math.max(10, window.innerWidth - el.offsetWidth - 10);
        const maxTop = Math.max(10, window.innerHeight - el.offsetHeight - 10);
        const nextLeft = Math.min(maxLeft, Math.max(10, initialLeft + dx));
        const nextTop = Math.min(maxTop, Math.max(10, initialTop + dy));
        el.style.left = nextLeft + "px";
        el.style.top = nextTop + "px";
    });

    const stopDrag = (e)=>{
        if(!isDragging) return;
        isDragging = false;
        el.classList.remove("dragging");
        try { el.releasePointerCapture(e.pointerId); } catch(_) {}
        try {
            const rect = el.getBoundingClientRect();
            localStorage.setItem(STORE_KEY+"_pos", JSON.stringify({left: rect.left, top: rect.top}));
        } catch(_) {}
    };

    el.addEventListener("pointerup", stopDrag);
    el.addEventListener("pointercancel", stopDrag);
}

function renderPanel(){
    if(!_panel) return;
    const st=_panel.querySelector("#dc-st");
    const w=_panel.querySelector("#dc-w");
    const m=_panel.querySelector("#dc-m");

    if(st){
        st.textContent=BOT_S.status.toUpperCase();
        const isAct=BOT_S.status==="playing"||BOT_S.status==="our_turn";
        st.className=`dc-status ${isAct?'active':BOT_S.status==='thinking'?'thinking':''}`;
    }
    if(w) w.textContent=BOT_S.matchesWon;
    if(m) m.textContent=BOT_S.movesPlayed;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-PLAY & POLLING LOOP WITH ANTI-FREEZE WATCHDOG
// ══════════════════════════════════════════════════════════════════════════════

let _pollRunning = false;

async function _autoPollLoop(){
    if(_pollRunning) return;
    _pollRunning = true;

    const POLL_MS = IS_MOBILE ? 200 : 80;

    while(true){
        await sleep(POLL_MS);

        // Watchdog: Unfreeze if stuck in thinking/playing for > 4.5 seconds
        if((BOT_S.status === "thinking" || BOT_S.status === "playing") && (Date.now() - _lastStateChange > 4500)){
            BOT_S._takeTurnLock = false;
            setStatus("idle");
        }

        if(!BOT_CFG.autoPlay) continue;

        // 1. Dismiss promotion modals immediately
        const promoHandled = autoClickPromotion();
        if(promoHandled && BOT_S.status === "thinking"){
            setStatus("waiting");
        }

        // 2. Advance flow only when not mid-move
        if(BOT_S.status !== "playing" && BOT_S.status !== "thinking"){
            advanceFlow();
        }

        const canvas = findCanvas();

        if(canvas){
            if(!BOT_S.matchId && !SOL_STATE.challenges.length){
                await recoverState();
            }

            if(BOT_S.matchId){
                if(BOT_S.status === "waiting" || BOT_S.status === "idle"){
                    await _fetchMatchState();
                }

                if(isOurTurn(BOT_S.currentFen) &&
                   !BOT_S._takeTurnLock &&
                   BOT_S.status !== "thinking" &&
                   BOT_S.status !== "playing"){
                    setStatus("our_turn");
                    if(BOT_CFG.autoPlay){
                        takeTurn();
                    }
                }
            } else if(SOL_STATE.challenges.length && !SOL_STATE.solving){
                solveAll();
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════════

function _boot(){
    loadChessJS();
    loadStockfish();
    loadJCE();
    _autoPollLoop();
    if(document.body){
        createPanel();
        recoverState();
    } else {
        document.addEventListener("DOMContentLoaded",()=>{
            createPanel();
            recoverState();
        });
    }
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",_boot);
else _boot();

})();