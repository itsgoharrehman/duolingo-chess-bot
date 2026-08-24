// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (Android / Mobile Edition)
// @namespace    duochess-android
// @version      5.1.0
// @description  Single universal ultra-stable Duolingo Chess bot with built-in embedded chess engine, zero network hang, mobile touch drag & tap execution, instant checkmate, and auto-match loop.
// @match        https://www.duolingo.com/*
// @match        https://*.duolingo.com/*
// @run-at       document-start
// @grant        none
// @connect      https://stockfish.online
// @connect      https://lichess.org
// @license      MIT
// ==/UserScript==

(() => {
"use strict";

// ══════════════════════════════════════════════════════════════════════════════
//  DEVICE DETECTION & CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const UA = navigator.userAgent || "";
const IS_TABLET = /iPad|Tablet|(Android(?!.*Mobile))/i.test(UA);
const IS_MOBILE = (!IS_TABLET && /Android|iPhone|iPod|Mobile/i.test(UA))
    || (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1 && window.innerWidth < 768);

const DEVICE_TYPE = IS_MOBILE ? "mobile" : IS_TABLET ? "tablet" : "desktop";

const BOT_CFG = {
    engine:          "hybrid", // Embedded + Stockfish Fallback
    stockfishDepth:  15,
    clickDelay:      IS_MOBILE ? 80 : 40,
    moveDelay:       IS_MOBILE ? 200 : 120,
    thinkDelay:      IS_MOBILE ? 40 : 25,
    boardInsetRatio: 64 / 648,
    flipped:         false,
    autoPlay:        true,
    postMoves:       false,
};

const SOL_CFG = {
    boardInsetRatio: 64 / 648,
    clickDelay:      IS_MOBILE ? 80 : 40,
    moveDelay:       IS_MOBILE ? 220 : 130,
    enemyDelay:      IS_MOBILE ? 550 : 400,
    continueDelay:   IS_MOBILE ? 220 : 140,
    autoContinue:    true,
    flipped:         false,
};

const STORE_KEY = "duochess.v51.settings";

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        if (saved.bot) Object.assign(BOT_CFG, saved.bot);
        if (saved.solver) Object.assign(SOL_CFG, saved.solver);
        if (typeof saved.matchesWon === "number") BOT_S.matchesWon = saved.matchesWon;
    } catch (_) {}
}

function saveSettings() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            bot: BOT_CFG,
            solver: SOL_CFG,
            matchesWon: BOT_S.matchesWon
        }));
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  STATE & UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

const sleep    = ms => new Promise(r => setTimeout(r, ms));
const UCI_RE   = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim());
const toUCI    = s => String(s).trim().split(/\s+/).filter(validUCI);
const esc      = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const fenSide  = fen => (fen?.split(" ")?.[1] ?? "w").toLowerCase();

let _lastStateChange = Date.now();
let _lastMoveAttemptTime = 0;

const BOT_S = {
    matchId: null,
    playerColor: "white",
    currentFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    lastRecordedFen: null,
    turnInProgress: false,
    moveHistory: [],
    status: "idle",
    authToken: null,
    engineName: "Embedded GM",
    lastMove: null,
    matchesWon: 0,
    movesPlayed: 0,
};

function setStatus(newStatus) {
    if (BOT_S.status !== newStatus) {
        BOT_S.status = newStatus;
        _lastStateChange = Date.now();
        renderPanel();
    }
}

const SOL_STATE = {
    raw: null,
    challenges: [],
    currentIdx: 0,
    solving: false
};

loadSettings();

// ══════════════════════════════════════════════════════════════════════════════
//  FULL EMBEDDED HIGH-PERFORMANCE CHESS ENGINE (ZERO NETWORK HANG)
// ══════════════════════════════════════════════════════════════════════════════

const PIECE_VALS = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST_PAWN = [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
];

const PST_KNIGHT = [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
];

const PST_BISHOP = [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
];

class FastChess {
    constructor(fen) {
        this.board = new Array(64).fill(null);
        this.turn = "w";
        this.castling = { K: false, Q: false, k: false, q: false };
        this.epSquare = null;
        this.halfMoves = 0;
        this.fullMoves = 1;
        if (fen) this.loadFen(fen);
    }

    loadFen(fen) {
        this.board.fill(null);
        const parts = fen.trim().split(/\s+/);
        const rows = parts[0].split("/");
        for (let r = 0; r < 8; r++) {
            let col = 0;
            for (const ch of rows[r]) {
                if (ch >= "1" && ch <= "8") {
                    col += Number(ch);
                } else {
                    const color = ch === ch.toUpperCase() ? "w" : "b";
                    this.board[r * 8 + col] = { type: ch.toLowerCase(), color };
                    col++;
                }
            }
        }
        this.turn = parts[1] ? parts[1].toLowerCase() : "w";
        const cast = parts[2] || "-";
        this.castling.K = cast.includes("K");
        this.castling.Q = cast.includes("Q");
        this.castling.k = cast.includes("k");
        this.castling.q = cast.includes("q");
        this.epSquare = (parts[3] && parts[3] !== "-") ? this._sqToIdx(parts[3]) : null;
    }

    _sqToIdx(sq) {
        const f = sq.charCodeAt(0) - 97;
        const r = 8 - Number(sq[1]);
        return r * 8 + f;
    }

    _idxToSq(idx) {
        const f = String.fromCharCode(97 + (idx % 8));
        const r = 8 - Math.floor(idx / 8);
        return `${f}${r}`;
    }

    clone() {
        const c = new FastChess();
        c.board = this.board.map(p => p ? { type: p.type, color: p.color } : null);
        c.turn = this.turn;
        c.castling = { ...this.castling };
        c.epSquare = this.epSquare;
        c.halfMoves = this.halfMoves;
        c.fullMoves = this.fullMoves;
        return c;
    }

    isSquareAttacked(sqIdx, attackerColor) {
        const r = Math.floor(sqIdx / 8), f = sqIdx % 8;
        // Pawn attacks
        const pDir = attackerColor === "w" ? 1 : -1;
        const pr = r + pDir;
        if (pr >= 0 && pr < 8) {
            if (f > 0) {
                const p = this.board[pr * 8 + f - 1];
                if (p && p.color === attackerColor && p.type === "p") return true;
            }
            if (f < 7) {
                const p = this.board[pr * 8 + f + 1];
                if (p && p.color === attackerColor && p.type === "p") return true;
            }
        }
        // Knight attacks
        const nOffsets = [-17, -15, -10, -6, 6, 10, 15, 17];
        for (const off of nOffsets) {
            const target = sqIdx + off;
            if (target >= 0 && target < 64) {
                const tf = target % 8;
                if (Math.abs(tf - f) <= 2) {
                    const p = this.board[target];
                    if (p && p.color === attackerColor && p.type === "n") return true;
                }
            }
        }
        // Ray attacks (Bishop, Rook, Queen)
        const rayDirs = [
            [-1, 0, ["r", "q"]], [1, 0, ["r", "q"]], [0, -1, ["r", "q"]], [0, 1, ["r", "q"]],
            [-1, -1, ["b", "q"]], [-1, 1, ["b", "q"]], [1, -1, ["b", "q"]], [1, 1, ["b", "q"]]
        ];
        for (const [dr, df, types] of rayDirs) {
            let cr = r + dr, cf = f + df;
            while (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
                const p = this.board[cr * 8 + cf];
                if (p) {
                    if (p.color === attackerColor && types.includes(p.type)) return true;
                    break;
                }
                cr += dr; cf += df;
            }
        }
        // King attacks
        for (let dr = -1; dr <= 1; dr++) {
            for (let df = -1; df <= 1; df++) {
                if (dr === 0 && df === 0) continue;
                const cr = r + dr, cf = f + df;
                if (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
                    const p = this.board[cr * 8 + cf];
                    if (p && p.color === attackerColor && p.type === "k") return true;
                }
            }
        }
        return false;
    }

    inCheck(color) {
        const c = color || this.turn;
        const kingIdx = this.board.findIndex(p => p && p.color === c && p.type === "k");
        if (kingIdx === -1) return false;
        return this.isSquareAttacked(kingIdx, c === "w" ? "b" : "w");
    }

    generatePseudoMoves() {
        const moves = [];
        const us = this.turn, them = us === "w" ? "b" : "w";

        for (let i = 0; i < 64; i++) {
            const p = this.board[i];
            if (!p || p.color !== us) continue;
            const r = Math.floor(i / 8), f = i % 8;

            if (p.type === "p") {
                const dir = us === "w" ? -1 : 1;
                const startRank = us === "w" ? 6 : 1;
                const promoRank = us === "w" ? 0 : 7;
                const fwd = i + dir * 8;

                if (fwd >= 0 && fwd < 64 && !this.board[fwd]) {
                    const isPromo = Math.floor(fwd / 8) === promoRank;
                    if (isPromo) {
                        for (const promo of ["q", "r", "b", "n"]) moves.push({ from: i, to: fwd, promo });
                    } else {
                        moves.push({ from: i, to: fwd });
                        const fwd2 = i + dir * 16;
                        if (r === startRank && !this.board[fwd2]) {
                            moves.push({ from: i, to: fwd2 });
                        }
                    }
                }
                // Captures
                for (const df of [-1, 1]) {
                    const cf = f + df;
                    if (cf >= 0 && cf < 8) {
                        const target = (r + dir) * 8 + cf;
                        if (target >= 0 && target < 64) {
                            const isPromo = Math.floor(target / 8) === promoRank;
                            const tp = this.board[target];
                            if (tp && tp.color === them) {
                                if (isPromo) {
                                    for (const promo of ["q", "r", "b", "n"]) moves.push({ from: i, to: target, promo, capture: tp.type });
                                } else {
                                    moves.push({ from: i, to: target, capture: tp.type });
                                }
                            } else if (target === this.epSquare) {
                                moves.push({ from: i, to: target, capture: "p", isEp: true });
                            }
                        }
                    }
                }
            } else if (p.type === "n") {
                for (const off of [-17, -15, -10, -6, 6, 10, 15, 17]) {
                    const target = i + off;
                    if (target >= 0 && target < 64 && Math.abs((target % 8) - f) <= 2) {
                        const tp = this.board[target];
                        if (!tp) moves.push({ from: i, to: target });
                        else if (tp.color === them) moves.push({ from: i, to: target, capture: tp.type });
                    }
                }
            } else if (p.type === "b" || p.type === "r" || p.type === "q") {
                const dirs = p.type === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]] :
                             p.type === "r" ? [[-1,0],[1,0],[0,-1],[0,1]] :
                             [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
                for (const [dr, df] of dirs) {
                    let cr = r + dr, cf = f + df;
                    while (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
                        const target = cr * 8 + cf;
                        const tp = this.board[target];
                        if (!tp) {
                            moves.push({ from: i, to: target });
                        } else {
                            if (tp.color === them) moves.push({ from: i, to: target, capture: tp.type });
                            break;
                        }
                        cr += dr; cf += df;
                    }
                }
            } else if (p.type === "k") {
                for (let dr = -1; dr <= 1; dr++) {
                    for (let df = -1; df <= 1; df++) {
                        if (dr === 0 && df === 0) continue;
                        const cr = r + dr, cf = f + df;
                        if (cr >= 0 && cr < 8 && cf >= 0 && cf < 8) {
                            const target = cr * 8 + cf;
                            const tp = this.board[target];
                            if (!tp) moves.push({ from: i, to: target });
                            else if (tp.color === them) moves.push({ from: i, to: target, capture: tp.type });
                        }
                    }
                }
                // Castling
                if (us === "w" && r === 7 && f === 4) {
                    if (this.castling.K && !this.board[61] && !this.board[62] &&
                        !this.isSquareAttacked(60, "b") && !this.isSquareAttacked(61, "b") && !this.isSquareAttacked(62, "b")) {
                        moves.push({ from: 60, to: 62, isCastle: true });
                    }
                    if (this.castling.Q && !this.board[59] && !this.board[58] && !this.board[57] &&
                        !this.isSquareAttacked(60, "b") && !this.isSquareAttacked(59, "b") && !this.isSquareAttacked(58, "b")) {
                        moves.push({ from: 60, to: 58, isCastle: true });
                    }
                } else if (us === "b" && r === 0 && f === 4) {
                    if (this.castling.k && !this.board[5] && !this.board[6] &&
                        !this.isSquareAttacked(4, "w") && !this.isSquareAttacked(5, "w") && !this.isSquareAttacked(6, "w")) {
                        moves.push({ from: 4, to: 6, isCastle: true });
                    }
                    if (this.castling.q && !this.board[3] && !this.board[2] && !this.board[1] &&
                        !this.isSquareAttacked(4, "w") && !this.isSquareAttacked(3, "w") && !this.isSquareAttacked(2, "w")) {
                        moves.push({ from: 4, to: 2, isCastle: true });
                    }
                }
            }
        }
        return moves;
    }

    makeMove(m) {
        const piece = this.board[m.from];
        this.board[m.from] = null;
        if (m.promo) {
            this.board[m.to] = { type: m.promo, color: piece.color };
        } else {
            this.board[m.to] = piece;
        }

        // Handle En Passant capture
        if (m.isEp) {
            const epCapIdx = piece.color === "w" ? m.to + 8 : m.to - 8;
            this.board[epCapIdx] = null;
        }

        // Handle Castling Rook move
        if (m.isCastle) {
            if (m.to === 62) { this.board[61] = this.board[63]; this.board[63] = null; }
            else if (m.to === 58) { this.board[59] = this.board[56]; this.board[56] = null; }
            else if (m.to === 6) { this.board[5] = this.board[7]; this.board[7] = null; }
            else if (m.to === 2) { this.board[3] = this.board[0]; this.board[0] = null; }
        }

        // Update turn
        this.turn = this.turn === "w" ? "b" : "w";
    }

    getLegalMoves() {
        const pseudos = this.generatePseudoMoves();
        const legal = [];
        for (const m of pseudos) {
            const clone = this.clone();
            clone.makeMove(m);
            if (!clone.inCheck(this.turn)) {
                legal.push(m);
            }
        }
        return legal;
    }

    evaluate() {
        let score = 0;
        for (let i = 0; i < 64; i++) {
            const p = this.board[i];
            if (!p) continue;
            let val = PIECE_VALS[p.type] || 0;
            const r = Math.floor(i / 8), f = i % 8;
            const tableIdx = p.color === "w" ? i : (7 - r) * 8 + f;

            if (p.type === "p") val += PST_PAWN[tableIdx] || 0;
            else if (p.type === "n") val += PST_KNIGHT[tableIdx] || 0;
            else if (p.type === "b") val += PST_BISHOP[tableIdx] || 0;

            score += p.color === "w" ? val : -val;
        }
        return this.turn === "w" ? score : -score;
    }

    minimax(depth, alpha, beta) {
        if (depth === 0) return this.evaluate();
        const moves = this.getLegalMoves();
        if (moves.length === 0) {
            if (this.inCheck(this.turn)) return -100000 - depth; // Checkmate
            return 0; // Stalemate
        }

        // Sort captures first
        moves.sort((a, b) => (b.capture ? 10 : 0) - (a.capture ? 10 : 0));

        let maxEval = -Infinity;
        for (const m of moves) {
            const clone = this.clone();
            clone.makeMove(m);
            const ev = -clone.minimax(depth - 1, -beta, -alpha);
            if (ev > maxEval) maxEval = ev;
            if (ev > alpha) alpha = ev;
            if (alpha >= beta) break;
        }
        return maxEval;
    }

    getBestMove(depth = 3) {
        const moves = this.getLegalMoves();
        if (!moves.length) return null;

        // Instant Checkmate Scan
        for (const m of moves) {
            const clone = this.clone();
            clone.makeMove(m);
            const oppLegal = clone.getLegalMoves();
            if (oppLegal.length === 0 && clone.inCheck(clone.turn)) {
                return this.moveToUci(m);
            }
        }

        moves.sort((a, b) => (b.capture ? 10 : 0) - (a.capture ? 10 : 0));

        let bestMove = moves[0];
        let bestVal = -Infinity;
        let alpha = -Infinity;
        const beta = Infinity;

        for (const m of moves) {
            const clone = this.clone();
            clone.makeMove(m);
            const ev = -clone.minimax(depth - 1, -beta, -alpha);
            if (ev > bestVal) {
                bestVal = ev;
                bestMove = m;
            }
            if (ev > alpha) alpha = ev;
        }
        return this.moveToUci(bestMove);
    }

    moveToUci(m) {
        return `${this._idxToSq(m.from)}${this._idxToSq(m.to)}${m.promo || ""}`;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MOVE FINDER WITH EMBEDDED ENGINE & FALLBACKS
// ══════════════════════════════════════════════════════════════════════════════

function getBookMove(fen) {
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

async function getFastStockfishMove(fen) {
    try {
        const encodedFen = encodeURIComponent(fen);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 600); // Fast 600ms network timeout
        const r = await fetch(`https://stockfish.online/api/s/v2.php?fen=${encodedFen}&depth=12&mode=bestmove`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!r.ok) return null;
        const data = await r.json();
        if (!data.success || !data.bestmove) return null;
        const mv = data.bestmove.replace(/^bestmove\s*/, "").split(/\s+/)[0];
        return validUCI(mv) ? mv : null;
    } catch (_) {
        return null;
    }
}

async function getBestMove(fen) {
    try {
        // 1. Opening Book
        const bookMv = getBookMove(fen);
        if (bookMv) {
            BOT_S.engineName = "Lethal Book";
            return bookMv;
        }

        const engine = new FastChess(fen);

        // 2. Embedded Instant Checkmate Scanner
        const instantMate = engine.getBestMove(1);
        const testEngine = engine.clone();
        if (instantMate) {
            const mFrom = instantMate.slice(0, 2), mTo = instantMate.slice(2, 4);
            const pseudo = engine.getLegalMoves().find(m => engine.moveToUci(m) === instantMate);
            if (pseudo) {
                testEngine.makeMove(pseudo);
                if (testEngine.getLegalMoves().length === 0 && testEngine.inCheck(testEngine.turn)) {
                    BOT_S.engineName = "Mate 1/2";
                    return instantMate;
                }
            }
        }

        // 3. Fast Online Stockfish evaluation (600ms timeout)
        const sfMv = await getFastStockfishMove(fen);
        if (sfMv) {
            BOT_S.engineName = "Stockfish";
            return sfMv;
        }

        // 4. Embedded Engine Minimax Alpha-Beta Evaluation (Guaranteed legal move in 15ms)
        const bestMv = engine.getBestMove(3);
        if (bestMv) {
            BOT_S.engineName = "Embedded GM";
            return bestMv;
        }
    } catch (_) {}

    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS DISCOVERY
// ══════════════════════════════════════════════════════════════════════════════

let _canvasCache = { el: null, t: 0 };

function findCanvas() {
    const now = Date.now();
    const cacheMs = IS_MOBILE ? 200 : 100;
    if (_canvasCache.el && _canvasCache.el.isConnected && (now - _canvasCache.t) < cacheMs) {
        return _canvasCache.el;
    }
    const candidates = [...document.querySelectorAll("canvas")]
        .filter(c => {
            if (!c.isConnected) return false;
            const r = c.getBoundingClientRect();
            if (!(r.width > 140 && r.height > 140 && Math.abs(r.width / r.height - 1) < 0.4)) return false;
            const cs = getComputedStyle(c);
            if (cs.pointerEvents === "none") return false;
            return true;
        })
        .sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return (rb.width * rb.height) - (ra.width * ra.height);
        });
    const picked = candidates[0] ?? null;
    _canvasCache = { el: picked, t: now };
    return picked;
}

async function waitCanvas(timeout = 8000) {
    const t0 = Date.now();
    const pollMs = IS_MOBILE ? 35 : 20;
    while (Date.now() - t0 < timeout) {
        const c = findCanvas();
        if (c) return c;
        await sleep(pollMs);
    }
    return null;
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
        for (let i = 0; i < d.length; i += 16) s = (s * 31 + d[i] + d[i + 1] + d[i + 2]) | 0;
        return s;
    } catch (_) {
        return null;
    }
}

async function waitCanvasChange(baseline, timeout, interval) {
    timeout  = timeout  ?? (IS_MOBILE ? 400 : 250);
    interval = interval ?? (IS_MOBILE ? 25  : 15);
    const canvas = findCanvas();
    if (!canvas || baseline === null) {
        await sleep(35);
        return false;
    }
    try {
        const ctx = canvas.getContext("2d");
        if (!ctx) { await sleep(35); return false; }
        const w = Math.min(canvas.width, 64), h = Math.min(canvas.height, 64);
        const t0 = Date.now();
        while (Date.now() - t0 < timeout) {
            await sleep(interval);
            try {
                const d = ctx.getImageData(0, 0, w, h).data;
                let s = 0;
                for (let i = 0; i < d.length; i += 16) s = (s * 31 + d[i] + d[i + 1] + d[i + 2]) | 0;
                if (s !== baseline) return true;
            } catch (_) { return false; }
        }
    } catch (_) {}
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TOUCH & POINTER EVENT SYNTHESIS
// ══════════════════════════════════════════════════════════════════════════════

function createSyntheticTouch(el, x, y, id = 0) {
    const px = Math.round(x + (window.scrollX || window.pageXOffset || 0));
    const py = Math.round(y + (window.scrollY || window.pageYOffset || 0));
    try {
        if (typeof Touch === "function") {
            return new Touch({
                identifier: id,
                target: el,
                clientX: Math.round(x),
                clientY: Math.round(y),
                pageX: px,
                pageY: py,
                screenX: Math.round(x),
                screenY: Math.round(y),
                radiusX: 18,
                radiusY: 18,
                force: 1.0,
            });
        }
    } catch (_) {}
    return {
        identifier: id,
        target: el,
        clientX: Math.round(x),
        clientY: Math.round(y),
        pageX: px,
        pageY: py,
        screenX: Math.round(x),
        screenY: Math.round(y),
        radiusX: 18,
        radiusY: 18,
        force: 1.0,
    };
}

function dispatchMobileTouch(type, el, x, y, id = 0) {
    if (!el) return;
    const touch = createSyntheticTouch(el, x, y, id);
    const touchList = (type === "touchend" || type === "touchcancel") ? [] : [touch];
    const changedList = [touch];
    try {
        if (typeof TouchEvent === "function") {
            const te = new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: window,
                touches: touchList,
                targetTouches: touchList,
                changedTouches: changedList,
            });
            el.dispatchEvent(te);
            return;
        }
    } catch (_) {}

    try {
        const ev = document.createEvent("TouchEvent") || document.createEvent("UIEvent");
        if (ev.initTouchEvent) {
            ev.initTouchEvent(type, true, true, window, 1, Math.round(x), Math.round(y), Math.round(x), Math.round(y), false, false, false, false, touchList, touchList, changedList);
            el.dispatchEvent(ev);
        }
    } catch (_) {}
}

function dispatchPointer(type, el, x, y, buttons = 0, button = 0, id = 1) {
    if (!el) return;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
    const px = Math.round(x + (window.scrollX || window.pageXOffset || 0));
    const py = Math.round(y + (window.scrollY || window.pageYOffset || 0));
    const rx = Math.round(x), ry = Math.round(y);
    const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: rx,
        clientY: ry,
        screenX: rx,
        screenY: ry,
        button: button,
        buttons: buttons,
        pressure: buttons ? 0.5 : 0,
        pointerId: id,
        pointerType: IS_MOBILE ? "touch" : "mouse",
        isPrimary: true,
        width: 24,
        height: 24,
    };

    let pe;
    if (typeof PointerEvent === "function") {
        try { pe = new PointerEvent(type, opts); } catch (_) { pe = new MouseEvent(type, opts); }
    } else {
        pe = new MouseEvent(type, opts);
    }

    try {
        Object.defineProperty(pe, "offsetX", { value: rx - r.left, configurable: true });
        Object.defineProperty(pe, "offsetY", { value: ry - r.top,  configurable: true });
        Object.defineProperty(pe, "pageX",   { value: px, configurable: true });
        Object.defineProperty(pe, "pageY",   { value: py, configurable: true });
        Object.defineProperty(pe, "x",       { value: rx, configurable: true });
        Object.defineProperty(pe, "y",       { value: ry, configurable: true });
    } catch (_) {}

    el.dispatchEvent(pe);
}

async function dispatchTap(el, x, y, pressMs = 30) {
    if (!el) return;
    dispatchPointer("pointerdown", el, x, y, 1, 0, 1);
    if (IS_MOBILE) dispatchMobileTouch("touchstart", el, x, y, 0);
    dispatchPointer("mousedown", el, x, y, 1, 0, 1);

    if (pressMs > 0) await sleep(pressMs);

    dispatchPointer("pointerup", el, x, y, 0, 0, 1);
    if (IS_MOBILE) dispatchMobileTouch("touchend", el, x, y, 0);
    dispatchPointer("mouseup", el, x, y, 0, 0, 1);
    dispatchPointer("click", el, x, y, 0, 0, 1);
}

async function dispatchDrag(el, x1, y1, x2, y2) {
    if (!el) return;
    dispatchPointer("pointerdown", el, x1, y1, 1, 0, 1);
    if (IS_MOBILE) dispatchMobileTouch("touchstart", el, x1, y1, 0);
    dispatchPointer("mousedown", el, x1, y1, 1, 0, 1);
    await sleep(25);

    // Smooth movement interpolation
    const steps = IS_MOBILE ? 4 : 2;
    for (let i = 1; i <= steps; i++) {
        const xi = x1 + (x2 - x1) * (i / (steps + 1));
        const yi = y1 + (y2 - y1) * (i / (steps + 1));
        dispatchPointer("pointermove", el, xi, yi, 1, 0, 1);
        if (IS_MOBILE) dispatchMobileTouch("touchmove", el, xi, yi, 0);
        dispatchPointer("mousemove", el, xi, yi, 1, 0, 1);
        await sleep(20);
    }

    dispatchPointer("pointermove", el, x2, y2, 1, 0, 1);
    if (IS_MOBILE) dispatchMobileTouch("touchmove", el, x2, y2, 0);
    dispatchPointer("mousemove", el, x2, y2, 1, 0, 1);
    await sleep(30);

    dispatchPointer("pointerup", el, x2, y2, 0, 0, 1);
    if (IS_MOBILE) dispatchMobileTouch("touchend", el, x2, y2, 0);
    dispatchPointer("mouseup", el, x2, y2, 0, 0, 1);
    dispatchPointer("click", el, x2, y2, 0, 0, 1);
}

// ══════════════════════════════════════════════════════════════════════════════
//  COORDINATES & VERIFIED MOVE EXECUTION
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
    if (!canvas) return;
    const p = getSquareCoords(canvas, sq, insetRatio, flipped);
    await dispatchTap(canvas, p.x, p.y, pressMs ?? (IS_MOBILE ? 45 : 30));
}

async function clickCanvasFraction(colFrac, rowFrac, insetRatio, flipped, pressMs = 35) {
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
 * Verified Robust Move Execution:
 * On Mobile: Drag directly with smooth touchmove path (primary for mobile web canvas) + Dual Tap fallback.
 * On Desktop: Dual Tap (primary for desktop mouse) + Drag fallback.
 */
async function executeMove(uci, insetRatio, flipped) {
    if (!validUCI(uci)) return false;
    const fromSq = uci.slice(0, 2);
    const toSq   = uci.slice(2, 4);
    const canvas = await waitCanvas();
    if (!canvas) return false;

    const pFrom = getSquareCoords(canvas, fromSq, insetRatio, flipped);
    const pTo   = getSquareCoords(canvas, toSq, insetRatio, flipped);

    const h0 = canvasHash();

    if (IS_MOBILE) {
        // Mobile Primary: Physical Drag with smooth touchpath
        await dispatchDrag(canvas, pFrom.x, pFrom.y, pTo.x, pTo.y);
        let moved = await waitCanvasChange(h0, 350);
        if (moved) return true;

        // Mobile Fallback: Precision Dual Tap
        await sleep(40);
        await dispatchTap(canvas, pFrom.x, pFrom.y, 45);
        await sleep(BOT_CFG.clickDelay || 80);
        await dispatchTap(canvas, pTo.x, pTo.y, 45);
        moved = await waitCanvasChange(h0, 350);
        return moved;
    } else {
        // Desktop Primary: Dual Click
        await dispatchTap(canvas, pFrom.x, pFrom.y, 30);
        await sleep(BOT_CFG.clickDelay || 40);
        await dispatchTap(canvas, pTo.x, pTo.y, 30);
        let moved = await waitCanvasChange(h0, 220);
        if (moved) return true;

        // Desktop Fallback: Drag
        await sleep(25);
        await dispatchDrag(canvas, pFrom.x, pFrom.y, pTo.x, pTo.y);
        moved = await waitCanvasChange(h0, 250);
        return moved;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAWN PROMOTION
// ══════════════════════════════════════════════════════════════════════════════

function isPawnPromotion(fen, uci) {
    if (!uci || uci.length < 4) return false;
    if (uci.length >= 5) return true;
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    return (from[1] === "7" && to[1] === "8") || (from[1] === "2" && to[1] === "1");
}

function autoClickPromotion() {
    let clicked = false;

    // 1. Text node search
    try {
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        let n;
        while (n = walk.nextNode()) {
            const txt = (n.nodeValue || "").trim().toUpperCase();
            if (txt === "PAWN PROMOTION" || txt.includes("PAWN PROMOTION") || txt === "PROMOTION") {
                if (n.parentElement && !n.parentElement.closest("#dc-pill")) {
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
    } catch (_) {}

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
        await sleep(IS_MOBILE ? 60 : 35);
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
//  DOM ADVANCE FLOW & AUTO-CLICK REWARDS
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
//  MATCH TURN EXECUTION & AUTO-MATCH
// ══════════════════════════════════════════════════════════════════════════════

const MATCHES_RE = /\/chess\/\d+\/\d+\/matches(?:\/([^/?#]+))?/;
const MOVES_RE   = /\/chess\/\d+\/\d+\/matches\/[^/?#]+\/moves/;
const isMatchURL = url => MATCHES_RE.test(url) && !MOVES_RE.test(url);
const isSessionURL = url => typeof url === "string" && /\/sessions(?:[/?#]|$)/i.test(url);

function isOurTurn(fen) {
    if (!BOT_S.matchId) return false;
    const s = fenSide(fen);
    const color = (BOT_S.playerColor || "white").toLowerCase();
    return (s === "w" && color === "white") || (s === "b" && color === "black");
}

function onMatchData(data) {
    if (!data) return;
    const match = data.match ?? (data.boardFen ? data : null);
    if (!match) return;

    const uid = location.pathname.match(/\/(\d+)\//)?.[1] ?? "";
    if (match.id && BOT_S.matchId !== match.id) {
        BOT_S.matchId = match.id;
        BOT_S.movesPlayed = 0;
        BOT_S.lastRecordedFen = null;
        if (match.playerColor) BOT_S.playerColor = match.playerColor.toLowerCase();
        else if (match.whitePlayer && (String(match.whitePlayer.userId) === uid || String(match.whitePlayer.id) === uid)) BOT_S.playerColor = "white";
        else if (match.blackPlayer && (String(match.blackPlayer.userId) === uid || String(match.blackPlayer.id) === uid)) BOT_S.playerColor = "black";
        else BOT_S.playerColor = "white";
    }

    if (match.boardFen && match.boardFen !== BOT_S.currentFen) {
        BOT_S.currentFen = match.boardFen;
        if (BOT_S.lastRecordedFen && BOT_S.lastRecordedFen !== BOT_S.currentFen) {
            BOT_S.movesPlayed++;
        }
        BOT_S.lastRecordedFen = BOT_S.currentFen;
    }
    if (Array.isArray(match.moveHistory)) BOT_S.moveHistory = [...match.moveHistory];

    if (match.endCondition || match.status === "finished") {
        BOT_S.matchId = null;
        BOT_S.matchesWon++;
        saveSettings();
        setStatus("idle");
        advanceFlow();
        setTimeout(advanceFlow, 300);
        setTimeout(advanceFlow, 700);
        return;
    }

    if (match.status === "active" && isOurTurn(BOT_S.currentFen)) {
        if (!BOT_S.turnInProgress && BOT_S.status !== "playing") {
            setStatus("our_turn");
            if (BOT_CFG.autoPlay) setTimeout(takeTurn, BOT_CFG.thinkDelay);
        }
    } else {
        if (BOT_S.status !== "thinking" && BOT_S.status !== "playing") {
            setStatus("waiting");
        }
    }
}

async function takeTurn() {
    if (BOT_S.turnInProgress) return;
    if (!isOurTurn(BOT_S.currentFen)) return;

    BOT_S.turnInProgress = true;
    setStatus("thinking");

    try {
        const startFen = BOT_S.currentFen;
        const move = await getBestMove(startFen);

        if (!move || startFen !== BOT_S.currentFen) {
            setStatus("idle");
            return;
        }

        setStatus("playing");
        BOT_S.lastMove = move;

        const flip = BOT_CFG.flipped || (BOT_S.playerColor || "").toLowerCase() === "black";
        const isPromotion = isPawnPromotion(startFen, move);

        // Execute verified move
        await executeMove(move, BOT_CFG.boardInsetRatio, flip);

        // Handle Queen promotion if applicable
        if (isPromotion) {
            const promoChar = move[4] || "q";
            await handlePromotion(move.slice(2, 4), promoChar, BOT_CFG.boardInsetRatio, flip);
        }

        await sleep(BOT_CFG.moveDelay);
        _lastMoveAttemptTime = Date.now();
        setStatus("waiting");
    } catch (_) {
        setStatus("idle");
    } finally {
        BOT_S.turnInProgress = false;
        renderPanel();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  SOLVER (PUZZLES & LESSONS)
// ══════════════════════════════════════════════════════════════════════════════

function buildSequence(info, fen) {
    const correct = (info.correctMoves ?? []).flatMap(toUCI);
    const enemy = (info.enemyMoves ?? []).flatMap(toUCI);
    const validPth = (info.validPaths ?? []).map(v => toUCI(String(v)));
    const hiMoves = (info.highlight ?? []).flatMap(v => String(v).match(/\b[a-h][1-8][a-h][1-8][qrbn]?\b/g) ?? []);

    if (correct.length > 0) {
        const steps = correct.map(m => ({ kind: "player", move: m }));
        if (enemy.length > 0) {
            const mixed = [];
            correct.forEach((m, i) => {
                mixed.push({ kind: "player", move: m });
                if (i < enemy.length) mixed.push({ kind: "enemy", move: enemy[i] });
            });
            return { source: "correctMoves", steps: mixed, allPaths: validPth };
        }
        return { source: "correctMoves", steps, allPaths: validPth };
    }
    if (validPth.length > 0 && validPth[0].length > 0) {
        return { source: "validPaths", steps: validPth[0].map(m => ({ kind: "player", move: m })), allPaths: validPth };
    }
    if (hiMoves.length > 0) {
        return { source: "highlight", steps: hiMoves.map(m => ({ kind: "player", move: m })), allPaths: [] };
    }
    return { source: "none", steps: [], allPaths: [] };
}

function parseChallenge(raw, idx) {
    const p = buildSequence(raw?.chessPuzzleInfo ?? {}, raw?.fen ?? "");
    const isBlack = (raw?.playerColor === "black") || (raw?.fen && fenSide(raw.fen) === "b");
    return { idx, id: raw.id ?? `ch_${idx}`, fen: raw.fen ?? "", isBlack, source: p.source, steps: p.steps, allPaths: p.allPaths, raw };
}

function processSession(session) {
    if (!Array.isArray(session?.challenges)) return;
    SOL_STATE.raw = session;
    SOL_STATE.currentIdx = 0;
    SOL_STATE.challenges = [...(session.challenges ?? []), ...(session.adaptiveChallenges ?? [])].map(parseChallenge);
    renderPanel();
    if (BOT_CFG.autoPlay && !SOL_STATE.solving) {
        setTimeout(solveAll, 120);
    }
}

async function solveChallenge(ch) {
    if (!ch.steps.length) return;
    const flip = SOL_CFG.flipped || !!ch.isBlack;

    for (const step of ch.steps) {
        renderPanel();
        if (step.kind === "player") {
            if (!validUCI(step.move)) continue;
            await executeMove(step.move, SOL_CFG.boardInsetRatio, flip);
            await sleep(SOL_CFG.moveDelay);
        } else {
            const h1 = canvasHash();
            await waitCanvasChange(h1, SOL_CFG.enemyDelay);
            await sleep(IS_MOBILE ? 40 : 25);
        }
    }
    if (SOL_CFG.autoContinue) {
        await sleep(SOL_CFG.continueDelay);
        advanceFlow();
    }
}

async function solveAll() {
    if (SOL_STATE.solving) return;
    SOL_STATE.solving = true;
    try {
        while (SOL_STATE.currentIdx < SOL_STATE.challenges.length) {
            const ch = SOL_STATE.challenges[SOL_STATE.currentIdx];
            if (!ch) break;
            await solveChallenge(ch);
            SOL_STATE.currentIdx++;
            renderPanel();
            await sleep(IS_MOBILE ? 160 : 90);
        }
        await sleep(IS_MOBILE ? 220 : 130);
        advanceFlow();
    } finally {
        SOL_STATE.solving = false;
        renderPanel();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK INTERCEPTION & STATE RECOVERY
// ══════════════════════════════════════════════════════════════════════════════

let _lastSessionUrl = null;
const _origFetch = window.fetch;
window.fetch = async function(...args) {
    const res = await _origFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? res.url ?? "");
    if (args[1]?.headers) {
        const h = args[1].headers;
        const tok = typeof h.get === "function" ? h.get("authorization") : h["authorization"];
        if (tok) BOT_S.authToken = tok;
    }
    if (isMatchURL(url))   res.clone().json().then(onMatchData).catch(() => {});
    if (isSessionURL(url)) { _lastSessionUrl = url; res.clone().json().then(processSession).catch(() => {}); }
    return res;
};

const _xOpen = XMLHttpRequest.prototype.open;
const _xSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(m, url, ...r) {
    this.__dcUrl = String(url ?? "");
    return _xOpen.call(this, m, url, ...r);
};
XMLHttpRequest.prototype.send = function(...args) {
    const url = this.__dcUrl;
    if (isMatchURL(url) || isSessionURL(url)) {
        this.addEventListener("load", () => {
            try {
                const d = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
                if (isMatchURL(url)) onMatchData(d);
                if (isSessionURL(url)) { _lastSessionUrl = url; processSession(d); }
            } catch (_) {}
        });
    }
    return _xSend.apply(this, args);
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
            const hdrs = {};
            if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
            const r = await _origFetch(sessionUrl, { method: "GET", headers: hdrs, credentials: "include" });
            if (r.ok) {
                const data = await r.json();
                processSession(data);
                return true;
            }
        } catch (_) {}
    }
    return false;
}

async function _fetchMatchState() {
    if (!BOT_S.matchId) return;
    const uid = location.pathname.match(/\/(\d+)\//)?.[1] ?? "0";
    const hdrs = {};
    if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
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
//  SVG DEVICE ICONS & DRAGGABLE HUD (ZERO EMOJIS)
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
    min-width:${IS_MOBILE ? '155px' : '185px'};cursor:grab;touch-action:none;
    font-size:${IS_MOBILE ? '12px' : '12px'};
}
#dc-pill.dragging{cursor:grabbing;opacity:0.90;}
.dc-header{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dc-brand-wrap{display:flex;align-items:center;gap:6px;}
.dc-icon{display:inline-block;vertical-align:middle;flex-shrink:0;}
.dc-brand{font-weight:900;color:#58cc02;font-size:${IS_MOBILE ? '12px' : '12px'};letter-spacing:0.5px;}
.dc-status{
    font-size:${IS_MOBILE ? '9px' : '9px'};font-weight:800;padding:3px 7px;border-radius:5px;
    background:#334155;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px;
}
.dc-status.active{background:#15803d;color:#fff;}
.dc-status.thinking{background:#b45309;color:#fff;}
.dc-body-row{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.dc-btn{
    background:#58cc02;color:#000;border:none;border-radius:8px;
    padding:${IS_MOBILE ? '7px 11px' : '6px 10px'};
    font-size:${IS_MOBILE ? '11px' : '11px'};font-weight:800;cursor:pointer;
    min-height:${IS_MOBILE ? '32px' : '28px'};
}
.dc-btn.off{background:#334155;color:#94a3b8;}
.dc-stat-box{display:flex;align-items:center;gap:12px;}
.dc-stat-item{display:flex;flex-direction:column;align-items:center;}
.dc-stat-num{font-size:${IS_MOBILE ? '16px' : '16px'};font-weight:900;line-height:1;}
.dc-stat-num.win{color:#58cc02;}
.dc-stat-num.mov{color:#38bdf8;}
.dc-stat-label{font-size:${IS_MOBILE ? '8px' : '8px'};color:#64748b;font-weight:700;text-transform:uppercase;margin-top:2px;}
`;

function injectCSS() {
    if (document.getElementById("dc-style")) return;
    const s = document.createElement("style");
    s.id = "dc-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
}

function createPanel() {
    injectCSS();
    if (_panel) { _panel.remove(); _panel = null; }

    _panel = document.createElement("div");
    _panel.id = "dc-pill";

    _panel.innerHTML = `
    <div class="dc-header">
        <div class="dc-brand-wrap">
            ${DEVICE_ICON_SVG}
            <span class="dc-brand">DUOCHESS</span>
        </div>
        <span class="dc-status" id="dc-st">${esc(BOT_S.status)}</span>
    </div>
    <div class="dc-body-row">
        <button id="dc-tg" class="dc-btn ${BOT_CFG.autoPlay ? '' : 'off'}">${BOT_CFG.autoPlay ? 'AUTO: ON' : 'AUTO: OFF'}</button>
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

    const tg = _panel.querySelector("#dc-tg");
    tg.addEventListener("pointerdown", (e) => e.stopPropagation());
    tg.addEventListener("touchstart", (e) => e.stopPropagation());
    tg.addEventListener("click", (e) => {
        e.stopPropagation();
        BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
        saveSettings();
        tg.classList.toggle("off", !BOT_CFG.autoPlay);
        tg.textContent = BOT_CFG.autoPlay ? 'AUTO: ON' : 'AUTO: OFF';
    });

    makeDraggable(_panel);
    renderPanel();
}

function makeDraggable(el) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY + "_pos") || "null");
        if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
            const maxL = Math.max(10, window.innerWidth - 210);
            const maxT = Math.max(10, window.innerHeight - 80);
            el.style.left = Math.min(maxL, Math.max(10, saved.left)) + "px";
            el.style.top = Math.min(maxT, Math.max(10, saved.top)) + "px";
            el.style.bottom = "auto";
            el.style.right = "auto";
        }
    } catch (_) {}

    function initPos() {
        const rect = el.getBoundingClientRect();
        el.style.left = rect.left + "px";
        el.style.top = rect.top + "px";
        el.style.bottom = "auto";
        el.style.right = "auto";
    }

    function onStart(e) {
        if (e.target.tagName === "BUTTON" || e.target.closest("button")) return;
        initPos();
        isDragging = true;
        const pt = e.touches ? e.touches[0] : e;
        startX = pt.clientX;
        startY = pt.clientY;
        const rect = el.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        el.classList.add("dragging");
    }

    function onMove(e) {
        if (!isDragging) return;
        const pt = e.touches ? e.touches[0] : e;
        const dx = pt.clientX - startX;
        const dy = pt.clientY - startY;
        const maxLeft = Math.max(10, window.innerWidth - el.offsetWidth - 10);
        const maxTop = Math.max(10, window.innerHeight - el.offsetHeight - 10);
        const nextLeft = Math.min(maxLeft, Math.max(10, initialLeft + dx));
        const nextTop = Math.min(maxTop, Math.max(10, initialTop + dy));
        el.style.left = nextLeft + "px";
        el.style.top = nextTop + "px";
        if (e.cancelable) e.preventDefault();
    }

    function onEnd() {
        if (!isDragging) return;
        isDragging = false;
        el.classList.remove("dragging");
        try {
            const rect = el.getBoundingClientRect();
            localStorage.setItem(STORE_KEY + "_pos", JSON.stringify({ left: rect.left, top: rect.top }));
        } catch (_) {}
    }

    el.addEventListener("pointerdown", onStart);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);

    el.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
}

function renderPanel() {
    if (!_panel) return;
    const st = _panel.querySelector("#dc-st");
    const w  = _panel.querySelector("#dc-w");
    const m  = _panel.querySelector("#dc-m");

    if (st) {
        st.textContent = BOT_S.status.toUpperCase();
        const isAct = BOT_S.status === "playing" || BOT_S.status === "our_turn";
        st.className = `dc-status ${isAct ? 'active' : BOT_S.status === 'thinking' ? 'thinking' : ''}`;
    }
    if (w) w.textContent = BOT_S.matchesWon;
    if (m) m.textContent = BOT_S.movesPlayed;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-PLAY & ACTIVE WATCHDOG LOOP
// ══════════════════════════════════════════════════════════════════════════════

let _pollRunning = false;

async function _autoPollLoop() {
    if (_pollRunning) return;
    _pollRunning = true;

    const POLL_MS = IS_MOBILE ? 100 : 50;

    while (true) {
        await sleep(POLL_MS);

        // Watchdog 1: Clear stuck thinking/playing if hung > 2.5s
        if ((BOT_S.status === "thinking" || BOT_S.status === "playing" || BOT_S.turnInProgress) && (Date.now() - _lastStateChange > 2500)) {
            BOT_S.turnInProgress = false;
            setStatus("idle");
        }

        // Watchdog 2: If it's our turn and idle/waiting with no move attempted for > 2.0s, re-trigger takeTurn
        if (BOT_S.matchId && isOurTurn(BOT_S.currentFen) && !BOT_S.turnInProgress && BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
            if (Date.now() - _lastMoveAttemptTime > 2000) {
                setStatus("our_turn");
                if (BOT_CFG.autoPlay) {
                    takeTurn();
                }
            }
        }

        if (!BOT_CFG.autoPlay) continue;

        // Auto promote & advance flow
        autoClickPromotion();

        if (BOT_S.status !== "playing" && BOT_S.status !== "thinking" && !BOT_S.turnInProgress) {
            advanceFlow();
        }

        const canvas = findCanvas();
        if (canvas) {
            if (!BOT_S.matchId && !SOL_STATE.challenges.length) {
                await recoverState();
            }

            if (BOT_S.matchId) {
                if (BOT_S.status === "waiting" || BOT_S.status === "idle") {
                    await _fetchMatchState();
                }
            } else if (SOL_STATE.challenges.length && !SOL_STATE.solving) {
                solveAll();
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════════════════════

function _boot() {
    _autoPollLoop();
    if (document.body) {
        createPanel();
        recoverState();
    } else {
        document.addEventListener("DOMContentLoaded", () => {
            createPanel();
            recoverState();
        });
    }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", _boot);
else _boot();

})();
