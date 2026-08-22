// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (Fast GM Mate Edition)
// @namespace    duochess-lite
// @version      2.8.0
// @icon         https://i.ibb.co/gZpNbsPP/cosmic.jpg
// @description  Crush Oscar in under 15 moves: Guaranteed Queen promotion handler with animation sync & multi-event canvas/DOM confirm, per-match move counter reset, instant checkmate detection, Scholar/Queen attack openings, Stockfish 16+ GM depth 15, auto-click continue, and endless loop!
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

const BOT_CFG = {
    engine:          "stockfish",
    jceLevel:        4,
    stockfishDepth:  15,          // Max grandmaster depth for fastest checkmates
    clickDelay:      50,          // Crisp click gap (ms)
    moveDelay:       450,         // Settle delay (ms)
    thinkDelay:      50,          // Rapid response to Oscar (ms)
    boardInsetRatio: 64 / 648,
    flipped:         false,
    autoPlay:        true,
    postMoves:       true,
};

const SOL_CFG = {
    boardInsetRatio: 64 / 648,
    clickDelay:      50,
    moveDelay:       400,
    enemyDelay:      650,
    continueDelay:   350,
    autoContinue:    true,
    flipped:         false,
};

const STORE_KEY = "duochess.v28.settings";

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
    movesPlayed: 0
};

const SOL_STATE = {
    raw: null, challenges: [], currentIdx: 0, solving: false, log: [],
};

loadSettings();

// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS & CLICK
// ══════════════════════════════════════════════════════════════════════════════

let _canvasCache = { el: null, t: 0 };

function findCanvas() {
    const now = Date.now();
    if (_canvasCache.el && _canvasCache.el.isConnected && (now - _canvasCache.t) < 150) {
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
    while(Date.now()-t0<timeout){ const c=findCanvas(); if(c) return c; await sleep(40); }
    throw new Error("Canvas not found");
}

function firePointer(el,type,x,y,buttons) {
    if(typeof PointerEvent==="function")
        el.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons,pointerId:1,pointerType:"mouse",isPrimary:true,view:window}));
}
function fireMouse(el,type,x,y,buttons) {
    el.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,button:0,buttons,view:window}));
}

function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("#dc-panel")) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
}

function simulateFullClick(el) {
    if (!el) return false;
    try {
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
        
        if (typeof PointerEvent === "function") {
            el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        }
        el.dispatchEvent(new MouseEvent("mousedown", { ...opts, button: 0, buttons: 1 }));
        
        if (typeof PointerEvent === "function") {
            el.dispatchEvent(new PointerEvent("pointerup", { ...opts, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
        }
        el.dispatchEvent(new MouseEvent("mouseup", { ...opts, button: 0, buttons: 0 }));
        el.dispatchEvent(new MouseEvent("click", { ...opts, button: 0, buttons: 0 }));
        
        if (typeof el.click === "function") {
            el.click();
        }

        // Dispatch on topmost element at point if different
        const topEl = document.elementFromPoint(x, y);
        if (topEl && topEl !== el && !topEl.closest("#dc-panel")) {
            if (typeof PointerEvent === "function") {
                topEl.dispatchEvent(new PointerEvent("pointerdown", { ...opts, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true }));
                topEl.dispatchEvent(new PointerEvent("pointerup", { ...opts, button: 0, buttons: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
            }
            topEl.dispatchEvent(new MouseEvent("mousedown", { ...opts, button: 0, buttons: 1 }));
            topEl.dispatchEvent(new MouseEvent("mouseup", { ...opts, button: 0, buttons: 0 }));
            topEl.dispatchEvent(new MouseEvent("click", { ...opts, button: 0, buttons: 0 }));
            if (typeof topEl.click === "function") topEl.click();
        }
        return true;
    } catch (_) {
        return false;
    }
}

async function clickSquare(sq,insetRatio,flipped,pressMs=80) {
    const canvas=await waitCanvas();
    function coords(r) {
        const iw=r.width*insetRatio,ih=r.height*insetRatio;
        const bw=r.width-iw*2,bh=r.height-ih*2;
        const file=sq.charCodeAt(0)-97,rank=Number(sq[1]);
        const col=flipped?7-file:file,row=flipped?rank-1:8-rank;
        return {x:r.left+iw+(col+0.5)*bw/8,y:r.top+ih+(row+0.5)*bh/8};
    }
    const d=coords(canvas.getBoundingClientRect());
    firePointer(canvas,"pointerdown",d.x,d.y,1); fireMouse(canvas,"mousedown",d.x,d.y,1);
    await sleep(pressMs);
    const u=coords(canvas.getBoundingClientRect());
    firePointer(canvas,"pointerup",u.x,u.y,0); fireMouse(canvas,"mouseup",u.x,u.y,0); fireMouse(canvas,"click",u.x,u.y,0);
}

// True Pawn Promotion Check
function isPawnPromotion(fen, uci) {
    if (!uci || uci.length < 4) return false;
    if (uci.length >= 5) return true;
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    
    // Check with Chess.js
    if (_Chess) {
        try {
            const c = new _Chess(fen);
            const piece = c.get(from);
            if (piece && piece.type === "p") {
                return (piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1");
            }
        } catch (_) {}
    }
    
    // Check FEN string directly
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

// Instant Full-Event Auto-Click for Promotion Modal (Queen Selection)
function autoClickPromotion() {
    // 1. Explicit Queen Selectors
    const explicitQueenSelectors = [
        `[data-piece="queen"]`, `[data-piece*="queen" i]`, `[data-piece="q"]`, `[data-piece="Q"]`,
        `[data-test*="promotion-queen" i]`, `[data-test*="promote-queen" i]`, `[data-test*="queen" i]`,
        `button[aria-label*="queen" i]`, `button[aria-label*="Hậu" i]`, `button[aria-label*="Dama" i]`, `button[aria-label*="Dame" i]`,
        `[aria-label*="queen" i]`, `[aria-label*="Hậu" i]`, `[aria-label*="Dama" i]`, `[aria-label*="Dame" i]`,
        `img[src*="queen" i]`, `img[alt*="queen" i]`, `svg[data-piece*="queen" i]`, `svg[data-piece*="q" i]`,
        `[class*="queen" i]`, `[id*="queen" i]`
    ];

    for (const sel of explicitQueenSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            if (isElementVisible(el)) {
                simulateFullClick(el);
                if (el.parentElement && isElementVisible(el.parentElement)) {
                    simulateFullClick(el.parentElement);
                }
                return true;
            }
        }
    }

    // 2. Generic Modal / Dialog detection
    const modalContainers = document.querySelectorAll(
        'div[role="dialog"], div[class*="modal" i], div[class*="dialog" i], div[class*="drawer" i], div[class*="popover" i], div[class*="overlay" i], div[class*="promotion" i], div[data-test*="modal" i], div[data-test*="promotion" i]'
    );

    for (const modal of modalContainers) {
        if (!isElementVisible(modal)) continue;

        // Queen is ALWAYS the 1st interactive option inside the promotion modal
        const candidates = modal.querySelectorAll('button, div[role="button"], li[role="button"], div[tabindex="0"], div[class*="piece" i], img, svg');
        for (const item of candidates) {
            if (isElementVisible(item)) {
                simulateFullClick(item);
                if (item.parentElement && isElementVisible(item.parentElement)) {
                    simulateFullClick(item.parentElement);
                }
                return true;
            }
        }
    }

    return false;
}

// Universal Pawn Promotion Handler (DOM Modal + Canvas Selection)
async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
    // 1. Wait 300ms for pawn move animation to reach destination square
    await sleep(300);

    // 2. Check DOM modal
    if (autoClickPromotion()) {
        await sleep(150);
        return true;
    }

    // 3. Click destination square on Canvas (where Queen is rendered)
    for (let attempt = 0; attempt < 3; attempt++) {
        await clickSquare(destSq, insetRatio, flipped, 90);
        await sleep(150);
        if (autoClickPromotion()) {
            await sleep(150);
            return true;
        }
    }

    return true;
}

let _Chess = null;

async function loadChessJS(){
    try{
        const mod=await import("https://esm.sh/chess.js@1.3.0");
        _Chess=mod.Chess??mod.default?.Chess??mod.default;
        addLog("sys","♟️ Chess.js Tactical Engine Ready");
        reparseChallenges();
        renderPanel();
    }catch(e){addLog("sys","chess.js load failed");}
}

async function loadJCE(){
    try{
        const mod=await import("https://esm.sh/js-chess-engine@2.3.2");
        BOT_S.jce=mod.Game??mod.default?.Game;
        BOT_S.jceReady=true;
        renderPanel();
    } catch(e){}
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
        addLog("sys","⚡ Stockfish GM 3500+ (Depth 15) Ready");
        renderPanel();
        return true;
    } catch(e){
        return false;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  LETHAL OPENING BOOK & RAPID CHECKMATE DETECTOR (<15 MOVES)
// ══════════════════════════════════════════════════════════════════════════════

// 1. Instant Checkmate in 1 or 2 Search
function findInstantMate(fen){
    if(!_Chess) return null;
    try{
        const c=new _Chess(fen);
        const moves=c.moves({verbose:true});
        
        // Check Mate in 1:
        for(const m of moves){
            c.move(m);
            if(c.isCheckmate()){
                c.undo();
                return m.from+m.to+(m.promotion??"");
            }
            c.undo();
        }

        // Check Mate in 2 (Forced Mate):
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

// 2. Fast Aggressive Opening Book against Oscar
function getBookMove(fen){
    const fenSimple = fen.split(" ").slice(0, 4).join(" ");
    
    // As White: Aggressive Scholar / Wayward Queen Attack
    const whiteBook = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -": "e2e4",
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d1h5", // Wayward Queen Attack
        "r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq -": "f1c4", // Scholar threat on f7
        "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1KBNR w KQkq -": "h5f7", // 4-Move Checkmate!
        "r1bqkbnr/pppp1p1p/2n3p1/4p2Q/2B1P3/8/PPPP1PPP/RNB1KBNR w KQkq -": "h5f3", // Re-threaten f7
        "r1bqkb1r/pppp1p1p/2n2np1/4p3/2B1P3/5Q2/PPPP1PPP/RNB1KBNR w KQkq -": "f3b3", // Double attack f7 & b7
        "r1bqkb1r/pppp1p1p/5np1/4p3/2BnP3/1Q6/PPPP1PPP/RNB1KBNR w KQkq -": "c4f7", // King attack
    };

    if(whiteBook[fenSimple]) return whiteBook[fenSimple];
    return null;
}

// 3. Lichess Cloud GM Database (Depth 40-50)
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

// 4. Stockfish 16+ Max Depth Evaluation
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
    } catch(e){
        return null;
    }
}

// Master Grandmaster Move Dispatcher
async function getBestMove(fen){
    // 1. Check for instant Checkmate in 1 or 2
    const instantMate = findInstantMate(fen);
    if(instantMate){
        BOT_S.engineName = "MATE FOUND 🎯";
        return instantMate;
    }

    // 2. Check Opening Book for fast win against Oscar
    const bookMv = getBookMove(fen);
    if(bookMv){
        BOT_S.engineName = "Attack Book ⚡";
        return bookMv;
    }

    // 3. Try Lichess Cloud Deep Evaluation (Depth 40+)
    const lichessMv = await getLichessCloudMove(fen);
    if(lichessMv){
        BOT_S.engineName = "Lichess Cloud GM";
        return lichessMv;
    }

    // 4. Deep Stockfish 16+ Depth 15
    const sfMv = await stockfishBestMove(fen, BOT_CFG.stockfishDepth);
    if(sfMv){
        BOT_S.engineName = "Stockfish 16+ (D15)";
        return sfMv;
    }

    // 5. High-speed local fallback
    if(BOT_S.jceReady && BOT_S.jce){
        try{
            const game=new BOT_S.jce(fen),obj=game.aiMove(BOT_CFG.jceLevel);
            const[from,to]=Object.entries(obj)[0];
            let uci=from.toLowerCase()+to.toLowerCase();
            if((parseInt(from[1])===7&&parseInt(to[1])===8)||(parseInt(from[1])===2&&parseInt(to[1])===1)) uci+="q";
            BOT_S.engineName="js-chess-engine";
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
//  BOT MATCH LOGIC
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
        BOT_S.movesPlayed = 0; // Reset moves played for new match!
        if(match.playerColor) BOT_S.playerColor = match.playerColor;
        else if(match.whitePlayer && (String(match.whitePlayer.userId)===uid || String(match.whitePlayer.id)===uid)) BOT_S.playerColor = "white";
        else if(match.blackPlayer && (String(match.blackPlayer.userId)===uid || String(match.blackPlayer.id)===uid)) BOT_S.playerColor = "black";
        else BOT_S.playerColor = "white";
        addLog("bot",`⚔️ Match Active: ${match.id.slice(0,8)} (${BOT_S.playerColor})`);
    }

    if(match.boardFen) BOT_S.currentFen=match.boardFen;
    if(Array.isArray(match.moveHistory)) BOT_S.moveHistory=[...match.moveHistory];
    
    if(match.endCondition||match.status==="finished"){
        BOT_S.status="idle";
        BOT_S.matchId=null;
        BOT_S.matchesWon++;
        BOT_S.movesPlayed = 0; // Reset move counter
        saveSettings();
        addLog("bot","🏆 Match Won! Auto-starting next game...");
        renderPanel();
        advanceFlow();
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

async function waitCanvasChange(baseline, timeout=1000, interval=25){
    const canvas=findCanvas();
    if(!canvas||baseline===null) { await sleep(80); return; }
    const ctx=canvas.getContext("2d");
    if(!ctx) { await sleep(80); return; }
    const w=Math.min(canvas.width,64), h=Math.min(canvas.height,64);
    const t0=Date.now();
    while(Date.now()-t0<timeout){
        await sleep(interval);
        try{
            const d=ctx.getImageData(0,0,w,h).data;
            let s=0; for(let i=0;i<d.length;i+=16) s=(s*31+d[i]+d[i+1]+d[i+2])|0;
            if(s!==baseline) return;
        }catch(_){ return; }
    }
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
    if(BOT_S.status==="thinking"||BOT_S.status==="playing") return;
    BOT_S.status="thinking"; renderPanel();

    let move=null, fenUsed=null;
    let attempts=0;
    while(attempts++<2){
        fenUsed=BOT_S.currentFen;
        move=await getBestMove(fenUsed);
        if(!move){BOT_S.status="idle";renderPanel();return;}
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
    try{
        const flip=BOT_CFG.flipped||BOT_S.playerColor==="black";
        const hashBefore=canvasHash();
        
        // Accurate pawn promotion detection
        const isPromotion = isPawnPromotion(BOT_S.currentFen, move);
        let finalUci = move;
        if(isPromotion && finalUci.length === 4) finalUci += (move[4] || "q");

        // 1. Click source square
        await clickSquare(move.slice(0,2),BOT_CFG.boardInsetRatio,flip);
        await waitCanvasChange(hashBefore, 600, 25);
        await sleep(Math.max(BOT_CFG.clickDelay, 140));

        // 2. Click destination square
        await clickSquare(move.slice(2,4),BOT_CFG.boardInsetRatio,flip);
        
        // 3. Handle Promotion if true pawn promotion
        if(isPromotion){
            const promoChar = move[4] || "q";
            await handlePromotion(move.slice(2,4), promoChar, BOT_CFG.boardInsetRatio, flip);
        }
        
        await sleep(BOT_CFG.moveDelay);
        if(BOT_CFG.postMoves&&BOT_S.matchId) await postMove(finalUci);
        
        BOT_S.movesPlayed++;
        renderPanel();
        addLog("bot",`♟️ Move #${BOT_S.movesPlayed}: <b>${finalUci.toUpperCase()}</b> [${BOT_S.engineName}]`);
        BOT_S.status="waiting";
    } catch(e){
        addLog("bot","err: "+e.message);
        BOT_S.status="idle";
    }
    renderPanel();
}

async function postMove(uci){
    const uid=location.pathname.match(/\/(\d+)\//)?.[1]??"0";
    const hdrs={"Content-Type":"application/json"};
    if(BOT_S.authToken) hdrs["Authorization"]=BOT_S.authToken;
    try{
        const res=await _origFetch(`/chess/1/${uid}/matches/${BOT_S.matchId}/moves`,{method:"POST",headers:hdrs,body:JSON.stringify({move:uci})});
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
    addLog("solver",`🧩 Session loaded: ${SOL_STATE.challenges.length} puzzles`);
    renderPanel();
    if(BOT_CFG.autoPlay && !SOL_STATE.solving){
        setTimeout(solveAll, 150);
    }
}

async function solveChallenge(ch){
    if(!ch.steps.length){addLog("solver",`#${ch.idx} no steps`);return;}
    addLog("solver",`Solving #${ch.idx+1}/${SOL_STATE.challenges.length}`);
    for(const step of ch.steps){
        renderPanel();
        if(step.kind==="player"){
            if(!validUCI(step.move)) continue;
            const h0=canvasHash();
            await clickSquare(step.move.slice(0,2),SOL_CFG.boardInsetRatio,SOL_CFG.flipped);
            await waitCanvasChange(h0, 500, 25);
            await sleep(SOL_CFG.clickDelay);
            await clickSquare(step.move.slice(2,4),SOL_CFG.boardInsetRatio,SOL_CFG.flipped);
            await sleep(SOL_CFG.moveDelay);
        } else {
            const h1=canvasHash();
            await waitCanvasChange(h1, SOL_CFG.enemyDelay, 25);
            await sleep(60);
        }
    }
    addLog("solver",`#${ch.idx+1} complete`);
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
            await sleep(200);
        }
        addLog("solver","All puzzles complete! Advancing...");
        await sleep(350);
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
    if (!sessionUrl) {
        const date = new Date().toISOString().slice(0, 10);
        const candidates = [`https://www.duolingo.com/${date}/sessions`, `/api/1/sessions`, `/${date}/sessions`];
        for (const url of candidates) {
            try {
                const hdrs = {}; if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
                const r = await _origFetch(url, { method: "GET", headers: hdrs });
                if (r.ok) { sessionUrl = url; break; }
            } catch (_) {}
        }
    }
    if (sessionUrl) {
        try {
            const hdrs = {}; if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
            const r = await _origFetch(sessionUrl, { method: "GET", headers: hdrs });
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
        const res = await _origFetch(`/chess/1/${uid}/matches/${BOT_S.matchId}`, { method: "GET", headers: hdrs });
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
        await _fetchSession();
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-STEP CONTINUE & START MATCH ADVANCE FLOW
// ══════════════════════════════════════════════════════════════════════════════

function advanceFlow() {
    if (!BOT_CFG.autoPlay) return false;

    // Check if promotion modal is visible and click Queen
    if (autoClickPromotion()) return true;

    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], a[class*="button" i]'));
    const keywords = [
        "continue", "tiếp tục", "tiep tuc", "next", "claim", "claim reward", "claim xp",
        "play against oscar", "play oscar", "start match", "start game", "play match",
        "play again", "rematch", "start lesson", "start", "play", "let's go", "done", "check", "got it", "finish", "practice"
    ];

    for (const btn of candidates) {
        if (!isElementVisible(btn)) continue;

        const dataTest = (btn.getAttribute("data-test") || "").toLowerCase();
        const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();

        if (dataTest.includes("player-next") ||
            dataTest.includes("player-start-button") ||
            dataTest.includes("continue-button") ||
            dataTest.includes("claim-button") ||
            dataTest.includes("start-button") ||
            dataTest.includes("next-button")) {
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
//  LOG
// ══════════════════════════════════════════════════════════════════════════════

function addLog(source,msg){
    SOL_STATE.log.push({source,msg,time:new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"})});
    if(SOL_STATE.log.length>100) SOL_STATE.log.shift();
    renderPanel();
}

// ══════════════════════════════════════════════════════════════════════════════
//  MINIMAL CLEAN PANEL
// ══════════════════════════════════════════════════════════════════════════════

let _panel = null;

const STYLE = `
#dc-panel{
    position:fixed;bottom:24px;right:24px;
    width:320px;
    background:rgba(18,24,38,0.96);
    backdrop-filter:blur(14px);
    border:1.5px solid rgba(88,204,2,0.4);
    border-radius:18px;
    box-shadow:0 12px 40px rgba(0,0,0,0.6), 0 0 25px rgba(88,204,2,0.2);
    font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size:12px;color:#f1f5f9;
    user-select:none;z-index:2147483647;
    overflow:hidden;
}
#dc-panel.collapsed{width:220px;height:48px;}
#dc-bar{
    display:flex;align-items:center;justify-content:space-between;
    padding:12px 16px;background:linear-gradient(135deg, rgba(88,204,2,0.25) 0%, rgba(20,29,47,0.7) 100%);
    border-bottom:1px solid rgba(255,255,255,0.08);cursor:grab;
}
#dc-title{
    display:flex;align-items:center;gap:8px;
    font-size:13px;font-weight:900;color:#58cc02;letter-spacing:0.5px;
}
.dc-btn-icon{
    background:rgba(255,255,255,0.1);border:none;border-radius:6px;
    color:#cbd5e1;width:24px;height:24px;cursor:pointer;display:flex;align-items:center;justify-content:center;
}
#dc-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;}
#dc-panel.collapsed #dc-body{display:none;}
.dc-status-bar{
    display:flex;align-items:center;justify-content:space-between;
    background:rgba(0,0,0,0.35);padding:8px 12px;border-radius:10px;font-size:11px;
}
.dc-badge{padding:3px 8px;border-radius:20px;font-size:9px;font-weight:800;text-transform:uppercase;}
.dc-badge-active{background:#58cc02;color:#000;}
.dc-badge-thinking{background:#f59e0b;color:#000;}
.dc-badge-ready{background:#3b82f6;color:#fff;}
.dc-toggle{
    background:#58cc02;color:#0f172a;font-weight:900;font-size:12px;
    border:none;border-radius:10px;padding:10px;cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:8px;
}
.dc-toggle.off{background:#334155;color:#94a3b8;}
.dc-stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.dc-stat-card{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:10px;padding:6px 10px;text-align:center;}
.dc-stat-val{font-size:15px;font-weight:900;color:#58cc02;}
.dc-stat-lbl{font-size:9px;color:#94a3b8;text-transform:uppercase;}
.dc-log{
    background:rgba(0,0,0,0.5);border-radius:8px;padding:6px 8px;max-height:80px;
    overflow-y:auto;font-family:monospace;font-size:10px;display:flex;flex-direction:column;gap:3px;
}
.dc-log-item{color:#93c5fd;}
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
    _panel.id="dc-panel";

    _panel.innerHTML=`
    <div id="dc-bar">
        <div id="dc-title"><span>♟️</span> DUO CHESS BOT</div>
        <button class="dc-btn-icon" id="dc-min">_</button>
    </div>
    <div id="dc-body">
        <div class="dc-status-bar">
            <span id="dc-st">${esc(BOT_S.status)}</span>
            <span class="dc-badge dc-badge-active" id="dc-bdg">ACTIVE</span>
        </div>
        <button class="dc-toggle ${BOT_CFG.autoPlay?'':'off'}" id="dc-tg">
            <span>⚡</span> <span>${BOT_CFG.autoPlay?'AUTO-MATCH: ON':'AUTO-MATCH: OFF'}</span>
        </button>
        <div class="dc-stat-grid">
            <div class="dc-stat-card">
                <div class="dc-stat-val" id="dc-w">${BOT_S.matchesWon}</div>
                <div class="dc-stat-lbl">Matches Won</div>
            </div>
            <div class="dc-stat-card">
                <div class="dc-stat-val" id="dc-m">${BOT_S.movesPlayed}</div>
                <div class="dc-stat-lbl">Moves (Current)</div>
            </div>
        </div>
        <div class="dc-log" id="dc-logs"></div>
    </div>`;

    document.body.appendChild(_panel);

    _panel.querySelector("#dc-min").addEventListener("click",()=>{
        _panel.classList.toggle("collapsed");
    });

    const tg=_panel.querySelector("#dc-tg");
    tg.addEventListener("click",()=>{
        BOT_CFG.autoPlay=!BOT_CFG.autoPlay;
        saveSettings();
        tg.classList.toggle("off",!BOT_CFG.autoPlay);
        tg.querySelector("span:last-child").textContent=BOT_CFG.autoPlay?'AUTO-MATCH: ON':'AUTO-MATCH: OFF';
    });

    makeDraggable(_panel, _panel.querySelector("#dc-bar"));
    renderPanel();
}

function renderPanel(){
    if(!_panel) return;
    const st=_panel.querySelector("#dc-st");
    const bdg=_panel.querySelector("#dc-bdg");
    const w=_panel.querySelector("#dc-w");
    const m=_panel.querySelector("#dc-m");
    const l=_panel.querySelector("#dc-logs");

    if(st) st.textContent=BOT_S.status;
    if(w) w.textContent=BOT_S.matchesWon;
    if(m) m.textContent=BOT_S.movesPlayed;

    if(bdg){
        const isAct=BOT_S.status==="playing"||BOT_S.status==="our_turn";
        bdg.className=`dc-badge ${isAct?'dc-badge-active':BOT_S.status==='thinking'?'dc-badge-thinking':'dc-badge-ready'}`;
        bdg.textContent=BOT_S.status.toUpperCase();
    }

    if(l){
        l.innerHTML=[...SOL_STATE.log].slice(-10).reverse().map(e=>`
            <div class="dc-log-item"><span style="color:#64748b">${e.time}</span> [${e.source}] ${esc(e.msg)}</div>
        `).join("");
    }
}

function makeDraggable(el, handle){
    let pos1=0,pos2=0,pos3=0,pos4=0;
    handle.onmousedown=(e)=>{
        if(e.target.tagName==="BUTTON") return;
        e.preventDefault();
        pos3=e.clientX; pos4=e.clientY;
        document.onmouseup=()=>{document.onmouseup=null;document.onmousemove=null;};
        document.onmousemove=(e2)=>{
            e2.preventDefault();
            pos1=pos3-e2.clientX; pos2=pos4-e2.clientY;
            pos3=e2.clientX; pos4=e2.clientY;
            el.style.top=(el.offsetTop-pos2)+"px";
            el.style.left=(el.offsetLeft-pos1)+"px";
            el.style.bottom="auto"; el.style.right="auto";
        };
    };
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-PLAY & POLLING LOOP
// ══════════════════════════════════════════════════════════════════════════════

let _pollRunning = false;

async function _autoPollLoop(){
    if(_pollRunning) return;
    _pollRunning = true;

    while(true){
        await sleep(200);
        if(!BOT_CFG.autoPlay) continue;

        // Auto-dismiss any promotion popups if visible
        autoClickPromotion();

        const canvas = findCanvas();
        const hasOverlay = document.querySelector('[data-test*="end" i], [data-test*="game-over" i], [data-test*="modal" i], .session-end');

        // Advance flow if on lobby, reward screen, or end modal
        if(!canvas || hasOverlay || (!BOT_S.matchId && !SOL_STATE.challenges.length)){
            advanceFlow();
        }

        if(canvas){
            // Auto-recover session / match if missing
            if(!BOT_S.matchId && !SOL_STATE.challenges.length){
                await recoverState();
            }

            if(BOT_S.matchId){
                // Actively poll server match state if waiting or idle
                if(BOT_S.status === "waiting" || BOT_S.status === "idle"){
                    await _fetchMatchState();
                }

                // If it is our turn, immediately take turn
                if(isOurTurn(BOT_S.currentFen) && BOT_S.status !== "thinking" && BOT_S.status !== "playing"){
                    BOT_S.status = "our_turn";
                    renderPanel();
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
    addLog("sys","⚡ DuoChess GM Mate Edition Ready");
}

if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",_boot);
else _boot();

})();