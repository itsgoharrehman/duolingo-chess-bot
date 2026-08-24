// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (Mobile Edition)
// @namespace    duochess-lite
// @version      4.0.0
// @description  Mobile-optimized: touch events, no stuck moves, race-condition-free mutex, reliable canvas clicks for Android browsers.
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
//  MOBILE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 1)
    || ('ontouchstart' in window);

const BOT_CFG = {
    engine:          "stockfish",
    jceLevel:        4,
    stockfishDepth:  15,
    // Mobile needs longer delays so canvas registers touch before second click fires
    clickDelay:      IS_MOBILE ? 180 : 60,
    moveDelay:       IS_MOBILE ? 350 : 200,
    thinkDelay:      IS_MOBILE ? 120 : 50,
    boardInsetRatio: 64 / 648,
    flipped:         false,
    autoPlay:        true,
    postMoves:       true,
};

const SOL_CFG = {
    boardInsetRatio: 64 / 648,
    clickDelay:      IS_MOBILE ? 180 : 60,
    moveDelay:       IS_MOBILE ? 350 : 200,
    enemyDelay:      IS_MOBILE ? 900 : 650,
    continueDelay:   IS_MOBILE ? 400 : 250,
    autoContinue:    true,
    flipped:         false,
};

const STORE_KEY = "duochess.v39.settings";

function loadSettings(){
    try{
        const saved=JSON.parse(localStorage.getItem(STORE_KEY)||"{}");
        if(saved.bot) Object.assign(BOT_CFG, saved.bot);
        if(saved.solver) Object.assign(SOL_CFG, saved.solver);
        if(typeof saved.matchesWon === "number") BOT_S.matchesWon = saved.matchesWon;
    }catch(_){}
}
function saveSettings(){
    try{
        localStorage.setItem(STORE_KEY,JSON.stringify({
            bot: BOT_CFG,
            solver: SOL_CFG,
            matchesWon: BOT_S.matchesWon
        }));
    }catch(_){}
}

// ══════════════════════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════════════════════

const sleep    = ms => new Promise(r => setTimeout(r, ms));
const UCI_RE   = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim());
const toUCI    = s => String(s).trim().split(/\s+/).filter(validUCI);
const esc      = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

// ══════════════════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════════════════

const BOT_S = {
    matchId: null, playerColor: "white",
    currentFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    moveHistory: [], status: "idle", authToken: null,
    jce: null, jceReady: false,
    stockfish: null, stockfishReady: false,
    engineName: "Stockfish GM", lastMove: null,
    matchesWon: 0,
    movesPlayed: 0,
    _takeTurnLock: false, // Mutex: prevents race-condition double-fire of takeTurn
};

const SOL_STATE = {
    raw: null, challenges: [], currentIdx: 0, solving: false
};

loadSettings();

// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS & CLICK
// ══════════════════════════════════════════════════════════════════════════════

let _canvasCache = { el: null, t: 0 };

function findCanvas() {
    const now = Date.now();
    // Longer cache on mobile: DOM reflow is slower
    const cacheMs = IS_MOBILE ? 300 : 150;
    if (_canvasCache.el && _canvasCache.el.isConnected && (now - _canvasCache.t) < cacheMs) {
        return _canvasCache.el;
    }
    const candidates = [...document.querySelectorAll("canvas")]
        .filter(c => {
            if (!c.isConnected) return false;
            const r = c.getBoundingClientRect();
            if (!(r.width > 180 && r.height > 180 && Math.abs(r.width/r.height - 1) < 0.25)) return false;
            const cs = getComputedStyle(c);
            if (cs.pointerEvents === "none") return false;
            return true;
        })
        .sort((a,b) => {
            const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
            return (rb.width*rb.height)-(ra.width*ra.height);
        });
    const picked = candidates[0] ?? null;
    _canvasCache = { el: picked, t: now };
    return picked;
}

async function waitCanvas(timeout=10000) {
    const t0=Date.now();
    const pollMs = IS_MOBILE ? 60 : 40;
    while(Date.now()-t0<timeout){ const c=findCanvas(); if(c) return c; await sleep(pollMs); }
    throw new Error("Canvas not found");
}

function firePointer(el,type,x,y,buttons) {
    if(typeof PointerEvent==="function")
        el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons,pointerId:1,pointerType:IS_MOBILE?"touch":"mouse",isPrimary:true,view:window}));
}
function fireMouse(el,type,x,y,buttons) {
    el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons,view:window}));
}

/**
 * Fire a touch tap at (x, y) on element el.
 * Required for Android browsers (Quetta, Kiwi, etc.) to reliably hit canvas.
 */
function fireTouch(el, x, y) {
    if (typeof TouchEvent !== "function" || typeof Touch !== "function") return;
    try {
        const t = new Touch({
            identifier: Date.now() & 0xffff,
            target: el, clientX: x, clientY: y,
            screenX: x, screenY: y, pageX: x, pageY: y,
            radiusX: 12, radiusY: 12, rotationAngle: 0, force: 1,
        });
        el.dispatchEvent(new TouchEvent("touchstart", {
            bubbles:true, cancelable:true, composed:true, view:window,
            touches:[t], targetTouches:[t], changedTouches:[t],
        }));
        el.dispatchEvent(new TouchEvent("touchend", {
            bubbles:true, cancelable:true, composed:true, view:window,
            touches:[], targetTouches:[], changedTouches:[t],
        }));
    } catch(_) {}
}

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

// React Fiber & Native Click Dispatcher
function simulateFullClick(el) {
    if (!el || isForbiddenButton(el)) return false;
    try {
        // 1. Direct native click
        if (typeof el.click === "function") el.click();

        // 2. React fiber internal handler trigger
        const rKey = Object.keys(el).find(k => k.startsWith("__reactProps$") || k.startsWith("__reactEventHandlers$") || k.startsWith("__reactFiber$"));
        if (rKey && el[rKey]) {
            const props = el[rKey].memoizedProps || el[rKey];
            if (typeof props?.onClick === "function") {
                try { props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: el, currentTarget: el }); } catch (_) {}
            }
        }

        // 3. Pointer & Mouse events with coordinates
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;

        let target = el;
        try {
            const topEl = document.elementFromPoint(x, y);
            if (topEl && !topEl.closest("#dc-pill")) target = topEl;
        } catch (_) {}

        const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };

        if (typeof PointerEvent === "function") {
            target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            target.dispatchEvent(new PointerEvent("pointerup", { ...opts, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        }
        target.dispatchEvent(new MouseEvent("mousedown", { ...opts, button: 0, buttons: 1 }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...opts, button: 0, buttons: 0 }));
        target.dispatchEvent(new MouseEvent("click", { ...opts, button: 0, buttons: 0 }));

        // 4. Click any inner span/button
        const inner = el.querySelector("span, div, p");
        if (inner && typeof inner.click === "function") {
            try { inner.click(); } catch (_) {}
        }
        return true;
    } catch (_) {
        return false;
    }
}

// Global Keyboard Enter & Space for Duolingo Modals / Footers
function pressGlobalAdvanceKeys() {
    try {
        for (const key of ["Enter", " "]) {
            const code = key === " " ? "Space" : "Enter";
            const keyCode = key === " " ? 32 : 13;
            const evOpts = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true, view: window };

            window.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            if (document.body) document.body.dispatchEvent(new KeyboardEvent("keydown", evOpts));

            window.dispatchEvent(new KeyboardEvent("keyup", evOpts));
            document.dispatchEvent(new KeyboardEvent("keyup", evOpts));
            if (document.body) document.body.dispatchEvent(new KeyboardEvent("keyup", evOpts));
        }
    } catch (_) {}
}

async function clickSquare(sq, insetRatio, flipped, pressMs) {
    pressMs = pressMs ?? (IS_MOBILE ? 110 : 65);
    const canvas = await waitCanvas();
    function coords(r) {
        const iw = r.width * insetRatio, ih = r.height * insetRatio;
        const bw = r.width - iw * 2, bh = r.height - ih * 2;
        const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]);
        const col = flipped ? 7 - file : file, row = flipped ? rank - 1 : 8 - rank;
        return { x: r.left + iw + (col + 0.5) * bw / 8, y: r.top + ih + (row + 0.5) * bh / 8 };
    }
    const d = coords(canvas.getBoundingClientRect());
    // Mobile: fire touch events FIRST so Android recognises the interaction
    if (IS_MOBILE) fireTouch(canvas, d.x, d.y);
    firePointer(canvas, "pointerdown", d.x, d.y, 1);
    fireMouse(canvas, "mousedown", d.x, d.y, 1);
    await sleep(pressMs);
    const u = coords(canvas.getBoundingClientRect());
    firePointer(canvas, "pointerup", u.x, u.y, 0);
    fireMouse(canvas, "mouseup", u.x, u.y, 0);
    fireMouse(canvas, "click", u.x, u.y, 0);
}

// Click Canvas at fractional column / row coordinate
async function clickCanvasFraction(colFrac, rowFrac, insetRatio, flipped, pressMs) {
    pressMs = pressMs ?? (IS_MOBILE ? 90 : 55);
    const canvas = findCanvas();
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const iw = r.width * insetRatio, ih = r.height * insetRatio;
    const bw = r.width - iw * 2, bh = r.height - ih * 2;
    const col = flipped ? (7 - colFrac) : colFrac;
    const row = flipped ? (7 - rowFrac) : rowFrac;
    const x = r.left + iw + col * (bw / 8);
    const y = r.top + ih + row * (bh / 8);

    if (IS_MOBILE) fireTouch(canvas, x, y);
    firePointer(canvas, "pointerdown", x, y, 1);
    fireMouse(canvas, "mousedown", x, y, 1);
    await sleep(pressMs);
    firePointer(canvas, "pointerup", x, y, 0);
    fireMouse(canvas, "mouseup", x, y, 0);
    fireMouse(canvas, "click", x, y, 0);

    const topEl = document.elementFromPoint(x, y);
    if (topEl && topEl !== canvas && !topEl.closest("#dc-pill")) {
        simulateFullClick(topEl);
    }
}

// True Pawn Promotion Check
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

    try {
        const rows = fen.split(" ")[0].split("/");
        const fileIdx = from.charCodeAt(0) - 97;
        const rankNum = Number(from[1]);
        const side = fen.split(" ")[1] || "w";

        if (side === "w" && rankNum === 7 && to[1] === "8") {
            let col = 0;
            for (const ch of rows[1]) {
                if (/\d/.test(ch)) col += Number(ch);
                else {
                    if (col === fileIdx && ch === "P") return true;
                    col++;
                }
            }
        }
        if (side === "b" && rankNum === 2 && to[1] === "1") {
            let col = 0;
            for (const ch of rows[6]) {
                if (/\d/.test(ch)) col += Number(ch);
                else {
                    if (col === fileIdx && ch === "p") return true;
                    col++;
                }
            }
        }
    } catch (_) {}

    return (from[1] === "7" && to[1] === "8") || (from[1] === "2" && to[1] === "1");
}

// Target Exact "PAWN PROMOTION" Dialog & Queen Piece Selection (DOM + Canvas)
function autoClickPromotion() {
    let clicked = false;

    // 1. Detect Duolingo's "PAWN PROMOTION" card via TreeWalker for text accuracy
    const allTextNodes = [];
    try {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let n;
        while(n = walk.nextNode()) {
            const txt = (n.nodeValue || "").trim().toUpperCase();
            if(txt === "PAWN PROMOTION" || txt.includes("PAWN PROMOTION") || txt === "PROMOTION") {
                if(n.parentElement && !n.parentElement.closest("#dc-pill")) {
                    allTextNodes.push(n.parentElement);
                }
            }
        }
    } catch(e) {}

    if (allTextNodes.length > 0) {
        const promoTitle = allTextNodes[0];
        const tr = promoTitle.getBoundingClientRect();

        let promoCard = promoTitle.parentElement;
        for (let i = 0; i < 4; i++) {
            if (promoCard && promoCard.getBoundingClientRect().height > 50) break;
            if (promoCard.parentElement) promoCard = promoCard.parentElement;
        }

        if (promoCard) {
            // Find all piece candidates inside the promotion card
            const pieces = Array.from(promoCard.querySelectorAll('button, svg, img, div[role="button"], li, div[tabindex="0"], div[class*="piece" i]'))
                .filter(p => !p.contains(promoTitle) && p.getBoundingClientRect().width > 15 && p.getBoundingClientRect().height > 15);

            if (pieces.length > 0) {
                // The Queen is ALWAYS the 1st option (leftmost piece)
                pieces.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                const queen = pieces[0];
                simulateFullClick(queen);
                clicked = true;
            }
        }

        // Hard-dispatch absolute coordinates to hit the Queen based on layout (under text, left aligned)
        const qx = tr.left + (tr.width * 0.15) + 15;
        const qy = tr.bottom + 35;

        const topEl = document.elementFromPoint(qx, qy);
        if (topEl && !topEl.closest("#dc-pill")) {
            simulateFullClick(topEl);
            clicked = true;
        }

        const opts = { bubbles: true, cancelable: true, composed: true, clientX: qx, clientY: qy, screenX: qx, screenY: qy, view: window };
        if (typeof PointerEvent === "function") {
            window.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            window.dispatchEvent(new PointerEvent("pointerup", { ...opts, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        }
        window.dispatchEvent(new MouseEvent("mousedown", { ...opts, button: 0, buttons: 1 }));
        window.dispatchEvent(new MouseEvent("mouseup", { ...opts, button: 0, buttons: 0 }));
        window.dispatchEvent(new MouseEvent("click", { ...opts, button: 0, buttons: 0 }));
        clicked = true;
    }

    // 2. Direct Queen piece selectors (DOM Fallback)
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
                if (el.parentElement && isElementVisible(el.parentElement) && !isForbiddenButton(el.parentElement)) {
                    simulateFullClick(el.parentElement);
                }
                clicked = true;
            }
        }
    }

    return clicked;
}

// Universal Pawn Promotion Handler (Canvas Coordinates + DOM)
async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
    const destFile = destSq.charCodeAt(0) - 97; // 0 to 7
    const destRank = Number(destSq[1]);         // 8 or 1

    for (let attempt = 0; attempt < 10; attempt++) {
        await sleep(80);

        // 1. Try DOM promotion click
        autoClickPromotion();

        // 2. Click exact Canvas Queen coordinates
        if (destRank === 8) {
            // White promoting on Rank 8
            if (destFile < 4) {
                // Files a-d: Queen icon is at column a (col 0.5), row 6 (row 2.0 / 2.3)
                await clickCanvasFraction(0.5, 2.0, insetRatio, flipped, 45);
                await clickCanvasFraction(0.5, 1.8, insetRatio, flipped, 45);
                await clickSquare("a6", insetRatio, flipped, 45);
            } else {
                // Files e-h: Queen icon is at column e (col 4.5) or column d (col 3.5), row 6 (row 2.0)
                await clickCanvasFraction(4.5, 2.0, insetRatio, flipped, 45);
                await clickCanvasFraction(3.5, 2.0, insetRatio, flipped, 45);
                await clickSquare("e6", insetRatio, flipped, 45);
                await clickSquare("d6", insetRatio, flipped, 45);
            }
        } else if (destRank === 1) {
            // Black promoting on Rank 1
            if (destFile < 4) {
                await clickCanvasFraction(0.5, 5.0, insetRatio, flipped, 45);
                await clickSquare("a3", insetRatio, flipped, 45);
            } else {
                await clickCanvasFraction(4.5, 5.0, insetRatio, flipped, 45);
                await clickSquare("e3", insetRatio, flipped, 45);
            }
        }

        // 3. Also click square right below / above destination
        const stepRank = destRank === 8 ? 7 : 2;
        await clickSquare(`${destSq[0]}${stepRank}`, insetRatio, flipped, 45);
    }
    return true;
}

let _Chess = null;

async function loadChessJS(){
    try{
        const mod=await import("https://esm.sh/chess.js@1.3.0");
        _Chess=mod.Chess??mod.default?.Chess??mod.default;
        reparseChallenges();
        renderPanel();
    }catch(_){}
}

async function loadJCE(){
    try{
        const mod=await import("https://esm.sh/js-chess-engine@2.3.2");
        BOT_S.jce=mod.Game??mod.default?.Game;
        BOT_S.jceReady=true;
        renderPanel();
    } catch(_){}
}

async function loadStockfish(){
    try{
        const testFen = encodeURIComponent("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        const r = await _origFetch(
            `https://stockfish.online/api/s/v2.php?fen=${testFen}&depth=5&mode=bestmove`,
            {method:"GET"}
        );
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

// ══════════════════════════════════════════════════════════════════════════════
//  LETHAL OPENING BOOK & RAPID CHECKMATE DETECTOR (<15 MOVES)
// ══════════════════════════════════════════════════════════════════════════════

function findInstantMate(fen){
    if(!_Chess) return null;
    try{
        const c=new _Chess(fen);
        const moves=c.moves({verbose:true});

        for(const m of moves){
            c.move(m);
            if(c.isCheckmate()){
                c.undo();
                return m.from+m.to+(m.promotion??"");
            }
            c.undo();
        }

        for(const m of moves){
            c.move(m);
            const oppMoves=c.moves({verbose:true});
            if(oppMoves.length>0 && oppMoves.length<=3){
                let allOppLeadToMate=true;
                for(const om of oppMoves){
                    c.move(om);
                    const myResponses=c.moves({verbose:true});
                    const hasMate=myResponses.some(rm=>{
                        c.move(rm);
                        const mate=c.isCheckmate();
                        c.undo();
                        return mate;
                    });
                    c.undo();
                    if(!hasMate){ allOppLeadToMate=false; break; }
                }
                if(allOppLeadToMate){
                    c.undo();
                    return m.from+m.to+(m.promotion??"");
                }
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

    if(whiteBook[fenSimple]) return whiteBook[fenSimple];
    return null;
}

async function getLichessCloudMove(fen){
    try{
        const encodedFen = encodeURIComponent(fen);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 900);
        const r = await _origFetch(`https://lichess.org/api/cloud-eval?fen=${encodedFen}&multiPv=1`, {
            signal: controller.signal
        });
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
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const r = await _origFetch(
            `https://stockfish.online/api/s/v2.php?fen=${encodedFen}&depth=${depth}&mode=bestmove`,
            { signal: controller.signal }
        );
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
    if(instantMate){
        BOT_S.engineName = "Mate 1/2";
        return instantMate;
    }

    const bookMv = getBookMove(fen);
    if(bookMv){
        BOT_S.engineName = "Book";
        return bookMv;
    }

    const lichessMv = await getLichessCloudMove(fen);
    if(lichessMv){
        BOT_S.engineName = "Lichess";
        return lichessMv;
    }

    const sfMv = await stockfishBestMove(fen, BOT_CFG.stockfishDepth);
    if(sfMv){
        BOT_S.engineName = "Stockfish";
        return sfMv;
    }

    if(BOT_S.jceReady && BOT_S.jce){
        try{
            const game=new BOT_S.jce(fen),obj=game.aiMove(BOT_CFG.jceLevel);
            const[from,to]=Object.entries(obj)[0];
            let uci=from.toLowerCase()+to.toLowerCase();
            if((parseInt(from[1])===7&&parseInt(to[1])===8)||(parseInt(from[1])===2&&parseInt(to[1])===1)) uci+="q";
            BOT_S.engineName="JCE";
            return uci;
        }catch(_){}
    }

    if(_Chess){
        try{
            const chess=new _Chess(fen),moves=chess.moves({verbose:true});
            if(moves.length){
                moves.sort((a, b) => (b.captured ? 10 : 0) - (a.captured ? 10 : 0));
                const m=moves[0];
                BOT_S.engineName="chess.js";
                return m.from+m.to+(m.promotion??"");
            }
        }catch(_){}
    }

    return "e2e4";
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOT MATCH LOGIC & UNIVERSAL CASTLING SUPPORT
// ══════════════════════════════════════════════════════════════════════════════

const MATCHES_RE=/\/chess\/\d+\/\d+\/matches(?:\/([^/?#]+))?/;
const MOVES_RE=/\/chess\/\d+\/\d+\/matches\/[^/?#]+\/moves/;
const isMatchURL=url=>MATCHES_RE.test(url)&&!MOVES_RE.test(url);
const isSessionURL=url=>typeof url==="string"&&/\/sessions(?:[/?#]|$)/i.test(url);
const fenSide=fen=>fen?.split(" ")?.[1]??"w";

function isOurTurn(fen){
    if(!BOT_S.matchId) return false;
    const s=fenSide(fen);
    const color = BOT_S.playerColor || "white";
    return (s==="w" && color==="white") || (s==="b" && color==="black");
}

function onMatchData(data){
    if(!data) return;
    const match=data.match??(data.boardFen?data:null);
    if(!match) return;

    const uid = location.pathname.match(/\/(\d+)\//)?.[1] ?? "";
    if(match.id && BOT_S.matchId!==match.id){
        BOT_S.matchId=match.id;
        BOT_S.movesPlayed = 0; // Clean 0 on new match!
        if(match.playerColor) BOT_S.playerColor = match.playerColor;
        else if(match.whitePlayer && (String(match.whitePlayer.userId)===uid || String(match.whitePlayer.id)===uid)) BOT_S.playerColor = "white";
        else if(match.blackPlayer && (String(match.blackPlayer.userId)===uid || String(match.blackPlayer.id)===uid)) BOT_S.playerColor = "black";
        else BOT_S.playerColor = "white";
    }

    if(match.boardFen) BOT_S.currentFen=match.boardFen;
    if(Array.isArray(match.moveHistory)) BOT_S.moveHistory=[...match.moveHistory];

    if(match.endCondition||match.status==="finished"){
        BOT_S.status="idle";
        BOT_S.matchId=null;
        BOT_S.matchesWon++;
        saveSettings();
        renderPanel();
        advanceFlow();
        setTimeout(advanceFlow, 250);
        setTimeout(advanceFlow, 600);
        setTimeout(advanceFlow, 1000);
        return;
    }

    if(match.status==="active" && isOurTurn(BOT_S.currentFen)){
        if(BOT_S.status!=="thinking" && BOT_S.status!=="playing"){
            BOT_S.status="our_turn";
            if(BOT_CFG.autoPlay) setTimeout(takeTurn, BOT_CFG.thinkDelay);
        }
    } else {
        BOT_S.status="waiting";
    }
    renderPanel();
}

async function waitCanvasChange(baseline, timeout, interval){
    // Mobile boards redraw slower — use longer timeout and poll interval
    timeout  = timeout  ?? (IS_MOBILE ? 1600 : 900);
    interval = interval ?? (IS_MOBILE ? 40   : 25);
    const canvas=findCanvas();
    if(!canvas||baseline===null) { await sleep(IS_MOBILE ? 120 : 80); return; }
    const ctx=canvas.getContext("2d");
    if(!ctx) { await sleep(IS_MOBILE ? 120 : 80); return; }
    const w=Math.min(canvas.width,64), h=Math.min(canvas.height,64);
    const t0=Date.now();
    while(Date.now()-t0<timeout){
        await sleep(interval);
        try{
            const d=ctx.getImageData(0,0,w,h).data;
            let s=0; for(let i=0;i<d.length;i+=16) s=(s*31+d[i]+d[i+1]+d[i+2])|0;
            if(s!==baseline) return; // board changed — piece selected or move registered
        }catch(_){ return; }
    }
    // Timeout: canvas didn't change. Proceed anyway — don't get stuck.
}

function canvasHash(){
    const canvas=findCanvas();
    if(!canvas) return null;
    try{
        const ctx=canvas.getContext("2d");
        if(!ctx) return null;
        const w=Math.min(canvas.width,64), h=Math.min(canvas.height,64);
        const d=ctx.getImageData(0,0,w,h).data;
        let s=0; for(let i=0;i<d.length;i+=16) s=(s*31+d[i]+d[i+1]+d[i+2])|0;
        return s;
    }catch(_){ return null; }
}

async function takeTurn(){
    // Mutex: only one takeTurn runs at a time — prevents race-condition double-moves on mobile
    if(BOT_S._takeTurnLock) return;
    if(BOT_S.status==="thinking"||BOT_S.status==="playing") return;
    BOT_S._takeTurnLock = true;
    BOT_S.status="thinking"; renderPanel();

    try {
        let move=null, fenUsed=null;
        let attempts=0;
        while(attempts++<2){
            fenUsed=BOT_S.currentFen;
            move=await getBestMove(fenUsed);
            if(!move) break;
            if(fenUsed===BOT_S.currentFen) break;
            if(_Chess){
                try{
                    const c=new _Chess(BOT_S.currentFen);
                    const ok=c.moves({verbose:true}).some(m=>m.from+m.to+(m.promotion??"")===move);
                    if(ok) break;
                }catch(_){}
            }
            move=null;
        }
        if(!move){BOT_S.status="idle";renderPanel();return;}

        BOT_S.status="playing"; BOT_S.lastMove=move; renderPanel();

        const flip=BOT_CFG.flipped||BOT_S.playerColor==="black";

        // Pawn promotion & castling detection
        const isPromotion = isPawnPromotion(BOT_S.currentFen, move);
        let finalUci = move;
        if(isPromotion && finalUci.length === 4) finalUci += (move[4] || "q");
        const isCastle = (move==="e1g1"||move==="e1c1"||move==="e8g8"||move==="e8c8");

        // ── Step 1: Click source square ──────────────────────────────────
        const hashBefore=canvasHash();
        await clickSquare(move.slice(0,2), BOT_CFG.boardInsetRatio, flip);

        // KEY FIX: Wait for board to redraw (piece-highlight) before clicking dest.
        // Without this, on mobile the dest click fires before src is registered → stuck moves.
        await waitCanvasChange(hashBefore);
        await sleep(BOT_CFG.clickDelay);

        // ── Step 2: Click destination square ─────────────────────────────
        const hashAfterSrc=canvasHash();
        await clickSquare(move.slice(2,4), BOT_CFG.boardInsetRatio, flip);

        // ── Step 2b: Castling fallback (click rook) ───────────────────────
        if(isCastle){
            await sleep(IS_MOBILE ? 130 : 80);
            const rookSq = move==="e1g1"?"h1":move==="e1c1"?"a1":move==="e8g8"?"h8":"a8";
            await clickSquare(rookSq, BOT_CFG.boardInsetRatio, flip);
        }

        // ── Step 3: Wait for dest click to register ───────────────────────
        await waitCanvasChange(hashAfterSrc);

        // ── Step 4: Promotion ─────────────────────────────────────────────
        if(isPromotion){
            const promoChar = move[4] || "q";
            await handlePromotion(move.slice(2,4), promoChar, BOT_CFG.boardInsetRatio, flip);
        }

        await sleep(BOT_CFG.moveDelay);
        if(BOT_CFG.postMoves&&BOT_S.matchId) await postMove(finalUci);

        BOT_S.movesPlayed++;
        BOT_S.status="waiting";
    } catch(e){
        BOT_S.status="idle";
    } finally {
        BOT_S._takeTurnLock = false;
        renderPanel();
    }
}


async function postMove(uci){
    if(!BOT_S.matchId) return;
    const uid=location.pathname.match(/\/(\d+)\//)?.[1]??"0";
    const hdrs={"Content-Type":"application/json"};
    if(BOT_S.authToken) hdrs["Authorization"]=BOT_S.authToken;
    try{
        const res=await _origFetch(`/chess/1/${uid}/matches/${BOT_S.matchId}/moves`,{method:"POST",headers:hdrs,body:JSON.stringify({move:uci}),credentials:"include"});
        if(!res.ok) return;
        const data=await res.json(),m=data.match??data;
        if(m?.boardFen) BOT_S.currentFen=m.boardFen;
        if(m?.boardFen&&isOurTurn(m.boardFen)&&BOT_CFG.autoPlay) setTimeout(takeTurn,BOT_CFG.thinkDelay+BOT_CFG.moveDelay);
    } catch(_){}
}

// ══════════════════════════════════════════════════════════════════════════════
//  SOLVER
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
    return{idx,id:raw.id??`ch_${idx}`,fen:raw.fen??"",source:p.source,steps:p.steps,allPaths:p.allPaths,raw};
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
        setTimeout(solveAll, 150);
    }
}

async function solveChallenge(ch){
    if(!ch.steps.length) return;
    for(const step of ch.steps){
        renderPanel();
        if(step.kind==="player"){
            if(!validUCI(step.move)) continue;
            // ── Click source ──────────────────────────────────────────────
            const h0=canvasHash();
            await clickSquare(step.move.slice(0,2),SOL_CFG.boardInsetRatio,SOL_CFG.flipped);
            // Wait for piece-highlight before clicking destination (fixes stuck moves)
            await waitCanvasChange(h0);
            await sleep(SOL_CFG.clickDelay);
            // ── Click destination ─────────────────────────────────────────
            const h1=canvasHash();
            await clickSquare(step.move.slice(2,4),SOL_CFG.boardInsetRatio,SOL_CFG.flipped);
            // Wait for move to register before next step
            await waitCanvasChange(h1);
            await sleep(SOL_CFG.moveDelay);
        } else {
            // Enemy move: wait for board animation
            const h1=canvasHash();
            await waitCanvasChange(h1, SOL_CFG.enemyDelay);
            await sleep(IS_MOBILE ? 100 : 60);
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
            await sleep(IS_MOBILE ? 350 : 200);
        }
        await sleep(IS_MOBILE ? 500 : 300);
        advanceFlow();
    } finally {
        SOL_STATE.solving=false;
        renderPanel();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK HOOKS & ACTIVE SESSION RECOVERY
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
//  BULLETPROOF ADVANCE FLOW & NEXT MATCH AUTO-START
// ══════════════════════════════════════════════════════════════════════════════

function advanceFlow() {
    if (!BOT_CFG.autoPlay) return false;

    // 1. Check & click Queen promotion first
    if (autoClickPromotion()) return true;

    // 2. Always dispatch global Enter & Space (instantly triggers Duolingo bottom bar Continue)
    pressGlobalAdvanceKeys();

    // 3. Scan all buttons & interactive elements on screen
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

        // Direct Duolingo action attributes
        if (dataTest.includes("player-next") ||
            dataTest.includes("player-start-button") ||
            dataTest.includes("continue-button") ||
            dataTest.includes("claim-button") ||
            dataTest.includes("start-button") ||
            dataTest.includes("next-button") ||
            dataTest.includes("bottom-nav-next-button") ||
            dataTest.includes("play-button") ||
            dataTest.includes("rematch-button") ||
            dataTest.includes("session-end-button")) {
            simulateFullClick(btn);
            return true;
        }

        // Direct Text matches (e.g. "CONTINUE", "PLAY AGAIN")
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
//  MINIMAL SILKY-SMOOTH DRAGGABLE STATUS PILL (POINTER CAPTURE)
// ══════════════════════════════════════════════════════════════════════════════

let _panel = null;

const STYLE = `
#dc-pill{
    position:fixed;bottom:20px;right:16px;
    background:rgba(15,23,42,0.97);border:1px solid rgba(255,255,255,0.14);
    border-radius:14px;padding:11px 15px;
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color:#f8fafc;z-index:2147483647;user-select:none;
    box-shadow:0 8px 28px rgba(0,0,0,0.65);
    display:flex;flex-direction:column;gap:9px;
    min-width:${IS_MOBILE ? '160px' : '190px'};cursor:grab;touch-action:none;
    font-size:${IS_MOBILE ? '13px' : '12px'};
}
#dc-pill.dragging{cursor:grabbing;opacity:0.90;}
.dc-header{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dc-brand{font-weight:900;color:#58cc02;font-size:${IS_MOBILE ? '13px' : '12px'};letter-spacing:0.5px;}
.dc-status{
    font-size:${IS_MOBILE ? '10px' : '9px'};font-weight:800;padding:3px 7px;border-radius:5px;
    background:#334155;color:#94a3b8;text-transform:uppercase;
}
.dc-status.active{background:#15803d;color:#fff;}
.dc-status.thinking{background:#b45309;color:#fff;}
.dc-body-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.dc-btn{
    background:#58cc02;color:#000;border:none;border-radius:8px;
    padding:${IS_MOBILE ? '9px 13px' : '6px 10px'};
    font-size:${IS_MOBILE ? '12px' : '11px'};font-weight:800;cursor:pointer;
    min-height:${IS_MOBILE ? '38px' : '28px'};
}
.dc-btn.off{background:#334155;color:#94a3b8;}
.dc-stat-box{display:flex;align-items:center;gap:12px;}
.dc-stat-item{display:flex;flex-direction:column;align-items:center;}
.dc-stat-num{font-size:${IS_MOBILE ? '18px' : '16px'};font-weight:900;line-height:1;}
.dc-stat-num.win{color:#58cc02;}
.dc-stat-num.mov{color:#38bdf8;}
.dc-stat-label{font-size:${IS_MOBILE ? '9px' : '8px'};color:#64748b;font-weight:700;text-transform:uppercase;margin-top:2px;}
.dc-mobile-tag{font-size:8px;color:#4a6fa5;text-align:center;font-weight:600;letter-spacing:0.4px;}
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
        <span class="dc-brand">DUOCHESS</span>
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
    </div>
    ${IS_MOBILE ? '<div class="dc-mobile-tag">📱 MOBILE MODE</div>' : ''}`;

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
//  AUTO-PLAY & POLLING LOOP
// ══════════════════════════════════════════════════════════════════════════════

let _pollRunning = false;

async function _autoPollLoop(){
    if(_pollRunning) return;
    _pollRunning = true;

    // Mobile: slower poll prevents race conditions with touch-event processing
    const POLL_MS = IS_MOBILE ? 260 : 110;

    while(true){
        await sleep(POLL_MS);
        if(!BOT_CFG.autoPlay) continue;

        // 1. Always dismiss promotion modals immediately
        const promoHandled = autoClickPromotion();
        if(promoHandled && BOT_S.status === "thinking"){
            BOT_S.status = "waiting";
            renderPanel();
        }

        // 2. Advance flow only when not mid-move
        if(BOT_S.status !== "playing" && BOT_S.status !== "thinking"){
            advanceFlow();
        }

        const canvas = findCanvas();

        if(canvas){
            // Auto-recover active match or session if state is lost
            if(!BOT_S.matchId && !SOL_STATE.challenges.length){
                await recoverState();
            }

            if(BOT_S.matchId){
                if(BOT_S.status === "waiting" || BOT_S.status === "idle"){
                    await _fetchMatchState();
                }

                // Guard: only call takeTurn if mutex is free and it's our turn
                if(isOurTurn(BOT_S.currentFen) &&
                   !BOT_S._takeTurnLock &&
                   BOT_S.status !== "thinking" &&
                   BOT_S.status !== "playing"){
                    BOT_S.status = "our_turn";
                    renderPanel();
                    if(BOT_CFG.autoPlay){
                        takeTurn(); // fire-and-forget; mutex prevents re-entry
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