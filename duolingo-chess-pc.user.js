// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (PC / Desktop Edition)
// @namespace    duochess-pc
// @version      5.2.0
// @description  Single universal ultra-stable Duolingo Chess bot with Stockfish 16+, Lichess Cloud Eval, embedded engine fallback, zero network hang, instant checkmate, and auto-match loop.
// @match        https://www.duolingo.com/*
// @match        https://*.duolingo.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      stockfish.online
// @connect      *.stockfish.online
// @connect      lichess.org
// @connect      *.lichess.org
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
    autoMatch:       true,
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
        if (typeof saved.movesPlayed === "number") BOT_S.movesPlayed = saved.movesPlayed;
    } catch (_) {}
}

function saveSettings() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            bot: BOT_CFG,
            solver: SOL_CFG,
            matchesWon: BOT_S.matchesWon,
            movesPlayed: BOT_S.movesPlayed
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
const _finishedMatchIds = new Set();

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

function resetStats() {
    BOT_S.matchesWon = 0;
    BOT_S.movesPlayed = 0;
    saveSettings();
    renderPanel();
}

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
//  MOVE FINDER WITH STOCKFISH 16+, LICHESS CLOUD & EMBEDDED ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function gmHttpFetch(url, timeoutMs = 4000, opts = {}) {
    return new Promise((resolve, reject) => {
        const gmReq = (typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : (typeof GM !== "undefined" && GM.xmlHttpRequest ? GM.xmlHttpRequest : null));
        const method = opts.method || "GET";
        const data = opts.data || null;
        const headers = { "Accept": "application/json", ...(opts.headers || {}) };

        if (gmReq) {
            try {
                gmReq({
                    method: method,
                    url: url,
                    data: data,
                    timeout: timeoutMs,
                    headers: headers,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            try {
                                resolve(JSON.parse(res.responseText));
                            } catch (e) {
                                reject(e);
                            }
                        } else {
                            reject(new Error(`HTTP ${res.status}`));
                        }
                    },
                    onerror: (err) => reject(err),
                    ontimeout: () => reject(new Error("Timeout"))
                });
                return;
            } catch (_) {}
        }

        // Fallback to fetch
        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), timeoutMs);
        const fetchOpts = { method, headers, signal: controller.signal };
        if (data) fetchOpts.body = data;

        fetch(url, fetchOpts)
            .then(r => {
                clearTimeout(tid);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(resolve)
            .catch(reject);
    });
}

function getBookMove(fen) {
    const fenSimple = fen.split(" ").slice(0, 4).join(" ");
    const openingBook = {
        // Standard high-level openings for White
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -": "e2e4",
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3", // King's Knight
        "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f1c4", // Italian Game
        "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "d2d3", // Giuoco Pianissimo
        "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "c2c3", // Main Italian line
        "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3", // Open Sicilian
        "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4", // French Defense
        "rnbqkbnr/ppppp1pp/8/5p2/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "e4f5", // vs Dutch
        "rnbqkbnr/pppppp1p/8/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4", // vs Borg / Grob

        // High-level defense for Black
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3": "e7e5", // Open Game
        "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "d7d5", // Queen's Pawn Game
        "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -": "d7d5", // Reti Opening
        "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3": "e7e5", // English Opening
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "b8c6", // Defense against Nf3
        "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "g8f6", // Two Knights Defense
        "r1bqkbnr/pppp1ppp/2n5/4p3/1bB1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "g8f6",
        "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "a7a6", // Ruy Lopez Morphy Defense
    };
    return openingBook[fenSimple] ?? null;
}

async function getLichessCloudMove(fen) {
    try {
        const encodedFen = encodeURIComponent(fen);
        const data = await gmHttpFetch(`https://lichess.org/api/cloud-eval?fen=${encodedFen}&multiPv=1`, 1500);
        if (data && Array.isArray(data.pvs) && data.pvs[0] && data.pvs[0].moves) {
            const mv = data.pvs[0].moves.split(/\s+/)[0];
            if (validUCI(mv)) return mv;
        }
        return null;
    } catch (_) {
        return null;
    }
}

async function getFastStockfishMove(fen) {
    try {
        const encodedFen = encodeURIComponent(fen);
        const depth = BOT_CFG.stockfishDepth || 15;
        const data = await gmHttpFetch(`https://stockfish.online/api/s/v2.php?fen=${encodedFen}&depth=${depth}&mode=bestmove`, 3500);
        if (!data || !data.success || !data.bestmove) return null;
        const mv = data.bestmove.replace(/^bestmove\s*/, "").split(/\s+/)[0];
        return validUCI(mv) ? mv : null;
    } catch (_) {
        return null;
    }
}

async function getChessApiMove(fen) {
    try {
        const data = await gmHttpFetch("https://chess-api.com/v1", 3500, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ fen: fen, depth: 15 })
        });
        if (data && (data.move || (data.from && data.to))) {
            const mv = data.move || (data.from + data.to + (data.promotion || ""));
            return validUCI(mv) ? mv : null;
        }
        return null;
    } catch (_) {
        return null;
    }
}

async function getBestMove(fen) {
    try {
        // 1. Opening Book for instant, infallible master opening lines
        const bookMv = getBookMove(fen);
        if (bookMv) {
            BOT_S.engineName = "Book Opening";
            return bookMv;
        }

        // 2. Multi-Provider Grandmaster Parallel Evaluation (Lichess Cloud + Stockfish Online + Chess-API)
        const lichessPromise = getLichessCloudMove(fen).then(mv => mv ? { name: "Lichess Cloud", move: mv } : null).catch(() => null);
        const stockfishOnlinePromise = getFastStockfishMove(fen).then(mv => mv ? { name: "Stockfish 16+", move: mv } : null).catch(() => null);
        const chessApiPromise = getChessApiMove(fen).then(mv => mv ? { name: "Stockfish 16+", move: mv } : null).catch(() => null);

        // Fast path: Lichess Cloud
        const cloudRes = await Promise.race([
            lichessPromise,
            new Promise(r => setTimeout(() => r(null), 1000))
        ]);
        if (cloudRes && cloudRes.move) {
            BOT_S.engineName = cloudRes.name;
            return cloudRes.move;
        }

        // Parallel Stockfish 16+ Engines
        const fastSf = await Promise.race([stockfishOnlinePromise, chessApiPromise]);
        if (fastSf && fastSf.move) {
            BOT_S.engineName = fastSf.name;
            return fastSf.move;
        }

        const [sf1, sf2, lcs] = await Promise.all([stockfishOnlinePromise, chessApiPromise, lichessPromise]);
        const bestOnline = sf1 || sf2 || lcs;
        if (bestOnline && bestOnline.move) {
            BOT_S.engineName = bestOnline.name;
            return bestOnline.move;
        }

        // 3. Fallback: Local Minimax Engine (only if offline)
        const engine = new FastChess(fen);
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
        if (ev && ev.initTouchEvent) {
            ev.initTouchEvent(type, true, true, null, 1, Math.round(x), Math.round(y), Math.round(x), Math.round(y), false, false, false, false, touchList, touchList, changedList);
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
    try {
        if (typeof PointerEvent === "function") {
            pe = new PointerEvent(type, opts);
        } else {
            pe = new MouseEvent(type, opts);
        }
    } catch (_) {
        try {
            pe = new MouseEvent(type, opts);
        } catch (_) {
            try {
                pe = document.createEvent("MouseEvents");
                pe.initMouseEvent(type, true, true, null, 1, rx, ry, rx, ry, false, false, false, false, button, null);
            } catch (_) {}
        }
    }

    if (pe) {
        try {
            Object.defineProperty(pe, "offsetX", { value: rx - r.left, configurable: true });
            Object.defineProperty(pe, "offsetY", { value: ry - r.top,  configurable: true });
            Object.defineProperty(pe, "pageX",   { value: px, configurable: true });
            Object.defineProperty(pe, "pageY",   { value: py, configurable: true });
            Object.defineProperty(pe, "x",       { value: rx, configurable: true });
            Object.defineProperty(pe, "y",       { value: ry, configurable: true });
        } catch (_) {}

        try {
            el.dispatchEvent(pe);
        } catch (_) {}
    }
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
 * On Desktop & Mobile: Dual Click/Tap + Drag fallback + Castling King/Rook dual fallbacks.
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

    // 1. Primary: Dual Click / Tap
    await dispatchTap(canvas, pFrom.x, pFrom.y, 30);
    await sleep(BOT_CFG.clickDelay || 40);
    await dispatchTap(canvas, pTo.x, pTo.y, 30);

    let moved = await waitCanvasChange(h0, 250);
    if (moved) return true;

    // 2. Drag Fallback
    await sleep(25);
    await dispatchDrag(canvas, pFrom.x, pFrom.y, pTo.x, pTo.y);
    moved = await waitCanvasChange(h0, 280);
    if (moved) return true;

    // 3. Castling Special Target Fallback (e1g1, e1c1, e8g8, e8c8)
    const isCastling = (uci === "e1g1" || uci === "e1c1" || uci === "e8g8" || uci === "e8c8");
    if (isCastling) {
        let rookSq = null;
        if (uci === "e1g1") rookSq = "h1";
        else if (uci === "e1c1") rookSq = "a1";
        else if (uci === "e8g8") rookSq = "h8";
        else if (uci === "e8c8") rookSq = "a8";

        if (rookSq) {
            const pRook = getSquareCoords(canvas, rookSq, insetRatio, flipped);
            await dispatchTap(canvas, pFrom.x, pFrom.y, 35);
            await sleep(50);
            await dispatchTap(canvas, pRook.x, pRook.y, 35);
            moved = await waitCanvasChange(h0, 250);
            if (moved) return true;

            await dispatchDrag(canvas, pFrom.x, pFrom.y, pRook.x, pRook.y);
            moved = await waitCanvasChange(h0, 250);
            if (moved) return true;
        }
    }

    return moved;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAWN PROMOTION
// ══════════════════════════════════════════════════════════════════════════════

let _pendingPromotionSq = null;
let _pendingPromotionTime = 0;

function isPawnPromotion(fen, uci) {
    if (!uci || uci.length < 4) return false;
    if (uci.length >= 5) return true;
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    try {
        const game = new FastChess(fen);
        const sqIdx = game._sqToIdx(from);
        const piece = game.board[sqIdx];
        if (piece) {
            return (piece.type === "p" || piece.type === "P") && (to[1] === "8" || to[1] === "1");
        }
    } catch (_) {}
    return (to[1] === "8" && (from[1] === "7" || from[1] === "8")) || (to[1] === "1" && (from[1] === "2" || from[1] === "1"));
}

async function tapCanvasAt(canvas, x, y, pressMs = 35) {
    if (!canvas) return;
    await dispatchTap(canvas, x, y, pressMs);
    try {
        const topEl = document.elementFromPoint(x, y);
        if (topEl && topEl !== canvas && !topEl.closest("#dc-pill")) {
            await dispatchTap(topEl, x, y, pressMs);
            simulateFullClick(topEl);
        }
    } catch (_) {}
}

function getPromotionQueenCoords(canvas, destSq, insetRatio, flipped) {
    const r = canvas.getBoundingClientRect();
    const iw = r.width * (insetRatio ?? 64 / 648);
    const ih = r.height * (insetRatio ?? 64 / 648);
    const bw = r.width - (iw * 2);
    const bh = r.height - (ih * 2);

    const coords = [];

    // 1. Exact Queen icon in Duolingo "PAWN PROMOTION" canvas modal (File c, Row 3.0)
    coords.push({ x: r.left + iw + 2.5 * (bw / 8), y: r.top + ih + 3.0 * (bh / 8) });
    coords.push({ x: r.left + iw + 2.4 * (bw / 8), y: r.top + ih + 2.9 * (bh / 8) });
    coords.push({ x: r.left + iw + 2.6 * (bw / 8), y: r.top + ih + 3.1 * (bh / 8) });

    // 2. Alternate vertical alignments (Row 4.0 center, Row 5.0 lower)
    coords.push({ x: r.left + iw + 2.5 * (bw / 8), y: r.top + ih + 4.0 * (bh / 8) });
    coords.push({ x: r.left + iw + 2.5 * (bw / 8), y: r.top + ih + 5.0 * (bh / 8) });

    // 3. Alternate horizontal alignment if modal is mirrored (File f, Column 5.5)
    coords.push({ x: r.left + iw + 5.5 * (bw / 8), y: r.top + ih + 3.0 * (bh / 8) });

    // 4. Destination square itself
    if (destSq && destSq.length >= 2) {
        coords.push(getSquareCoords(canvas, destSq, insetRatio, flipped));
        coords.push(getSquareCoords(canvas, destSq, insetRatio, !flipped));
    }

    return coords;
}

function autoClickPromotion() {
    let clicked = false;

    // 1. Find any promotion popup container by text/class/attribute
    try {
        const promoContainers = Array.from(document.querySelectorAll(
            '[data-test*="promotion" i], [class*="promotion" i], [id*="promotion" i], div[role="dialog"], [aria-label*="promotion" i]'
        ));
        for (const container of promoContainers) {
            if (container.closest("#dc-pill")) continue;
            const items = Array.from(container.querySelectorAll('button, [role="button"], img, svg, div[tabindex], div[class*="piece" i]'))
                .filter(el => {
                    if (el.closest("#dc-pill")) return false;
                    const r = el.getBoundingClientRect();
                    return r.width >= 16 && r.height >= 16 && r.width <= 160 && r.height <= 160;
                });
            if (items.length > 0) {
                items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                const queen = items[0];
                const qr = queen.getBoundingClientRect();
                dispatchTap(queen, qr.left + qr.width / 2, qr.top + qr.height / 2, 35);
                simulateFullClick(queen);
                return true;
            }
        }
    } catch (_) {}

    // 2. Direct Queen Selectors & Modal Dialogs
    const queenSelectors = [
        `[data-piece="queen"]`, `[data-piece="q"]`, `[data-piece="Q"]`,
        `[data-test*="queen" i]`, `[data-test*="player-piece-queen" i]`, `[data-test*="promotion-queen" i]`,
        `button[aria-label*="queen" i]`, `div[role="button"][aria-label*="queen" i]`,
        `img[alt*="queen" i]`, `img[src*="queen" i]`, `svg[data-piece*="queen" i]`,
        `[aria-label*="hậu" i]`, `[aria-label*="dame" i]`, `[aria-label*="reina" i]`
    ];

    for (const sel of queenSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            if (isElementVisible(el) && !isForbiddenButton(el) && !el.closest("#dc-pill")) {
                simulateFullClick(el);
                clicked = true;
                return true;
            }
        }
    }

    // 3. Fallback: Search all visible SVG icons inside the canvas bounding area (above board)
    try {
        const canvas = findCanvas();
        if (canvas) {
            const cr = canvas.getBoundingClientRect();
            const svgs = Array.from(document.querySelectorAll("svg, img"))
                .filter(s => {
                    if (s.closest("#dc-pill")) return false;
                    const r = s.getBoundingClientRect();
                    return r.left >= cr.left && r.right <= cr.right && r.top >= cr.top && r.bottom <= cr.bottom && r.width >= 18 && r.height >= 18 && r.width <= 140;
                });
            if (svgs.length >= 4) {
                svgs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                simulateFullClick(svgs[0]);
                clicked = true;
                return true;
            }
        }
    } catch (_) {}

    return clicked;
}

async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
    _pendingPromotionSq = destSq || "q";
    _pendingPromotionTime = Date.now();

    // 1. Allow Duolingo canvas promotion modal to mount and render piece options
    await sleep(IS_MOBILE ? 240 : 180);

    const canvas = findCanvas();
    if (!canvas) return false;

    const coords = getPromotionQueenCoords(canvas, destSq, insetRatio, flipped);

    for (let attempt = 0; attempt < 12; attempt++) {
        // A. Check DOM promotion popup (if any)
        if (autoClickPromotion()) {
            _pendingPromotionSq = null;
            return true;
        }

        // B. Canvas piece selection: Tap Queen modal icons on canvas
        for (const pt of coords) {
            await tapCanvasAt(canvas, pt.x, pt.y, 35);
        }

        // C. Send Queen keyboard triggers (Duolingo canvas listens to keydown 'q' / '1')
        try {
            for (const key of ["q", "Q", "1", "Enter", " "]) {
                const evOpts = { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true };
                window.dispatchEvent(new KeyboardEvent("keydown", evOpts));
                document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
                window.dispatchEvent(new KeyboardEvent("keyup", evOpts));
                document.dispatchEvent(new KeyboardEvent("keyup", evOpts));
            }
        } catch (_) {}

        await sleep(IS_MOBILE ? 110 : 75);
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

let _lastClickTime = 0;

function simulateFullClick(el) {
    if (!el || isForbiddenButton(el)) return false;
    const now = Date.now();
    if (now - _lastClickTime < 180) return false;
    _lastClickTime = now;

    try {
        if (typeof el.focus === "function") el.focus();
        if (typeof el.click === "function") el.click();

        const rKey = Object.keys(el).find(k => k.startsWith("__reactProps$") || k.startsWith("__reactEventHandlers$") || k.startsWith("__reactFiber$"));
        if (rKey && el[rKey]) {
            const props = el[rKey].memoizedProps || el[rKey];
            if (typeof props?.onClick === "function") {
                try { props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: el, currentTarget: el }); } catch (_) {}
            }
        }

        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            dispatchTap(el, x, y, 15);
        }
        return true;
    } catch (_) {
        return false;
    }
}

let _lastAdvanceKeyTime = 0;
function pressGlobalAdvanceKeys() {
    const now = Date.now();
    if (now - _lastAdvanceKeyTime < 450) return;
    _lastAdvanceKeyTime = now;

    try {
        for (const key of ["Enter", " "]) {
            const code = key === " " ? "Space" : "Enter";
            const keyCode = key === " " ? 32 : 13;
            const evOpts = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
            window.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            window.dispatchEvent(new KeyboardEvent("keyup", evOpts));
            document.dispatchEvent(new KeyboardEvent("keyup", evOpts));
        }
    } catch (_) {}
}

function autoMatchOscar() {
    if (!BOT_CFG.autoMatch) return false;

    // 1. Pawn promotion handling
    if (autoClickPromotion()) return true;

    // 2. Direct Rematch / Play Again on Game-Over / Victory Screen
    const rematchSelectors = [
        'button[data-test*="rematch" i]', 'button[data-test*="play-again" i]',
        'button[data-test*="new-game" i]', 'a[data-test*="rematch" i]',
        '[role="button"][data-test*="rematch" i]'
    ];
    for (const sel of rematchSelectors) {
        const btn = document.querySelector(sel);
        if (btn && isElementVisible(btn) && !isForbiddenButton(btn)) {
            setStatus("matching");
            simulateFullClick(btn);
            return true;
        }
    }

    // 3. Clear Post-Match Summary / Reward screens ("Continue", "Claim XP", "Done", "Next")
    const advanceSelectors = [
        '[data-test*="player-next" i]', '[data-test*="continue-button" i]',
        '[data-test*="claim-button" i]', '[data-test*="session-end-button" i]',
        '[data-test*="next-button" i]', '[data-test*="bottom-nav-next-button" i]',
        '[data-test*="challenge-next" i]', '[data-test*="player-practice-button" i]'
    ];
    for (const sel of advanceSelectors) {
        const btn = document.querySelector(sel);
        if (btn && isElementVisible(btn) && !isForbiddenButton(btn)) {
            simulateFullClick(btn);
            return true;
        }
    }

    // 4. Oscar Modal / Drawer Launch CTA ("Start Match", "Play", "Play Oscar", "Start Game")
    const launchSelectors = [
        'button[data-test*="start-match" i]', 'button[data-test*="start-button" i]',
        'button[data-test*="play-button" i]', 'button[data-test*="player-start-button" i]',
        'button[data-test*="challenge-button" i]', 'button[data-test*="bot-play" i]'
    ];
    for (const sel of launchSelectors) {
        const btn = document.querySelector(sel);
        if (btn && isElementVisible(btn) && !isForbiddenButton(btn)) {
            setStatus("matching");
            simulateFullClick(btn);
            return true;
        }
    }

    // 5. Target Oscar Bot Tile / Card on Chess / Bots Screen
    const oscarCardSelectors = [
        '[data-test*="bot-oscar" i]', '[data-test*="character-oscar" i]',
        '[data-test*="oscar-bot" i]', '[data-test*="character-card-oscar" i]',
        '[aria-label*="oscar" i]'
    ];
    for (const sel of oscarCardSelectors) {
        const card = document.querySelector(sel);
        if (card && isElementVisible(card) && !isForbiddenButton(card)) {
            setStatus("matching");
            simulateFullClick(card);
            return true;
        }
    }

    // 6. Universal Semantic Keyword Match for Oscar, Rematch, and Advance CTAs
    const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, div[data-test], div[class*="card" i], div[class*="bot" i], div[class*="character" i], li'
    ));

    const oscarKws = ["play against oscar", "play oscar", "oscar", "start match", "start game", "play match", "play now", "play again", "rematch", "play", "start"];
    const flowKws = ["continue", "tiếp tục", "tiep tuc", "next", "claim", "claim reward", "claim xp", "claim prize", "done", "check", "got it", "finish", "ready"];

    for (const raw of candidates) {
        const el = raw.closest("button, [role='button'], a, div[data-test]") || raw;
        if (!isElementVisible(el) || isForbiddenButton(el)) continue;

        const dataTest = (el.getAttribute("data-test") || "").toLowerCase();
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();

        // Check Oscar / Rematch CTAs
        for (const kw of oscarKws) {
            if (txt === kw || (kw === "oscar" && /\boscar\b/i.test(txt)) || ariaLabel.includes(kw) || dataTest.includes(kw.replace(/\s+/g, "-"))) {
                setStatus("matching");
                simulateFullClick(el);
                return true;
            }
        }

        // Check End Flow CTAs
        for (const kw of flowKws) {
            if (txt === kw || txt.includes(kw) || ariaLabel.includes(kw) || dataTest.includes(kw.replace(/\s+/g, "-"))) {
                simulateFullClick(el);
                return true;
            }
        }
    }

    // 7. Fallback to global space/enter key if end-screen banner is active
    pressGlobalAdvanceKeys();
    return false;
}

function advanceFlow() {
    if (!BOT_CFG.autoPlay && !BOT_CFG.autoMatch) return false;

    if (autoClickPromotion()) return true;

    const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, div[data-test*="button" i], div[data-test*="next" i], div[data-test*="continue" i], div[data-test*="start" i], div[data-test*="play" i]'
    ));

    const keywords = [
        "continue", "tiếp tục", "tiep tuc", "next", "claim", "claim reward", "claim xp", "claim prize",
        "play again", "rematch", "start lesson", "start session", "start", "play", "let's go", "done",
        "check", "got it", "finish", "practice", "ready", "keep going", "continue learning"
    ];

    for (const rawBtn of candidates) {
        const btn = rawBtn.closest("button, [role='button'], a") || rawBtn;
        if (!isElementVisible(btn) || isForbiddenButton(btn)) continue;

        const dataTest = (btn.getAttribute("data-test") || rawBtn.getAttribute("data-test") || "").toLowerCase();
        const ariaLabel = (btn.getAttribute("aria-label") || rawBtn.getAttribute("aria-label") || "").toLowerCase();
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();

        if (dataTest.includes("player-next") || dataTest.includes("player-start-button") ||
            dataTest.includes("continue-button") || dataTest.includes("claim-button") ||
            dataTest.includes("start-button") || dataTest.includes("next-button") ||
            dataTest.includes("bottom-nav-next-button") || dataTest.includes("play-button") ||
            dataTest.includes("rematch-button") || dataTest.includes("session-end-button") ||
            dataTest.includes("challenge-next") || dataTest.includes("player-practice-button")) {
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
    pressGlobalAdvanceKeys();
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MATCH TURN EXECUTION & AUTO-MATCH
// ══════════════════════════════════════════════════════════════════════════════

const MATCHES_RE = /\/chess\b.*\/matches(?:\/([^/?#]+))?/;
const MOVES_RE   = /\/chess\b.*\/matches\/[^/?#]+\/moves/;
const isMatchURL = url => typeof url === "string" && !MOVES_RE.test(url) && (MATCHES_RE.test(url) || /\/matches\b/i.test(url) || /\/chess-match\b/i.test(url));
const isSessionURL = url => typeof url === "string" && /\/sessions(?:[/?#]|$)/i.test(url);

function isOurTurn(fen) {
    const s = fenSide(fen);
    const color = (BOT_S.playerColor || "white").toLowerCase();
    return (s === "w" && color === "white") || (s === "b" && color === "black");
}

function onMatchData(data) {
    if (!data) return;
    const match = data.match ?? (data.boardFen ? data : null) ?? (data.chessMatch ? data.chessMatch : null);
    if (!match) return;

    const uid = getUserId();
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
        if (match.id) _finishedMatchIds.add(String(match.id));
        if (BOT_S.matchId) _finishedMatchIds.add(String(BOT_S.matchId));
        BOT_S.matchId = null;
        BOT_S.matchesWon++;
        saveSettings();
        setStatus("idle");
        if (BOT_CFG.autoMatch) {
            autoMatchOscar();
            setTimeout(autoMatchOscar, 250);
            setTimeout(autoMatchOscar, 650);
            setTimeout(autoMatchOscar, 1200);
        } else {
            advanceFlow();
            setTimeout(advanceFlow, 300);
            setTimeout(advanceFlow, 700);
        }
        return;
    }

    if (match.status === "active" || match.status === "in_progress" || !match.status) {
        if (isOurTurn(BOT_S.currentFen)) {
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
            const isPromotion = step.move.length >= 5 || (step.move[1] === "7" && step.move[3] === "8") || (step.move[1] === "2" && step.move[3] === "1");
            await executeMove(step.move, SOL_CFG.boardInsetRatio, flip);
            if (isPromotion) {
                const promoChar = step.move[4] || "q";
                await handlePromotion(step.move.slice(2, 4), promoChar, SOL_CFG.boardInsetRatio, flip);
            }
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

function getUserId() {
    if (BOT_S.userId && BOT_S.userId !== "0") return BOT_S.userId;
    try {
        const cMatch = document.cookie.match(/(?:duo_user_id|logged_in_user_id|userId)=([0-9]+)/i);
        if (cMatch && cMatch[1]) {
            BOT_S.userId = cMatch[1];
            return BOT_S.userId;
        }
    } catch (_) {}
    try {
        const duoState = JSON.parse(localStorage.getItem("duo.state") || "{}");
        const uid = duoState.user?.id || duoState.currentUserId || duoState.userId;
        if (uid) {
            BOT_S.userId = String(uid);
            return BOT_S.userId;
        }
    } catch (_) {}
    try {
        const entries = performance.getEntriesByType("resource");
        for (const e of entries) {
            const m = e.name.match(/\/chess\/\d+\/(\d+)\//) || e.name.match(/[?&]user(?:Id)?=(\d+)/);
            if (m && m[1]) {
                BOT_S.userId = m[1];
                return BOT_S.userId;
            }
        }
    } catch (_) {}
    return "0";
}

function hookNetwork(targetWin) {
    if (!targetWin || targetWin.__dcHooked) return;
    try { targetWin.__dcHooked = true; } catch (_) {}

    const origFetch = targetWin.fetch;
    if (typeof origFetch === "function") {
        targetWin.fetch = async function(...args) {
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? res.url ?? "");
                if (args[1]?.headers) {
                    const h = args[1].headers;
                    const tok = typeof h?.get === "function" ? h.get("authorization") : (h?.["authorization"] || h?.["Authorization"]);
                    if (tok) BOT_S.authToken = tok;
                }
                const uidMatch = url.match(/\/chess\/\d+\/(\d+)\//);
                if (uidMatch && uidMatch[1]) BOT_S.userId = uidMatch[1];

                if (isMatchURL(url)) {
                    res.clone().json().then(onMatchData).catch(() => {});
                } else if (isSessionURL(url)) {
                    _lastSessionUrl = url;
                    res.clone().json().then(processSession).catch(() => {});
                }
            } catch (_) {}
            return res;
        };
    }

    if (targetWin.XMLHttpRequest && targetWin.XMLHttpRequest.prototype) {
        const proto = targetWin.XMLHttpRequest.prototype;
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = function(m, url, ...r) {
            this.__dcUrl = String(url ?? "");
            return origOpen.call(this, m, url, ...r);
        };
        proto.send = function(...args) {
            const url = this.__dcUrl;
            if (isMatchURL(url) || isSessionURL(url)) {
                this.addEventListener("load", () => {
                    try {
                        const d = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
                        const uidMatch = url.match(/\/chess\/\d+\/(\d+)\//);
                        if (uidMatch && uidMatch[1]) BOT_S.userId = uidMatch[1];
                        if (isMatchURL(url)) onMatchData(d);
                        if (isSessionURL(url)) { _lastSessionUrl = url; processSession(d); }
                    } catch (_) {}
                });
            }
            return origSend.apply(this, args);
        };
    }
}

hookNetwork(window);
if (typeof unsafeWindow !== "undefined" && unsafeWindow !== window) {
    hookNetwork(unsafeWindow);
}

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
            const fetchFn = (typeof unsafeWindow !== "undefined" && unsafeWindow.fetch) || window.fetch;
            const r = await fetchFn(sessionUrl, { method: "GET", headers: hdrs, credentials: "include" });
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
    const uid = getUserId();
    const hdrs = {};
    if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;

    const urlsToTry = [];
    if (BOT_S.matchId) {
        urlsToTry.push(`/chess/1/${uid}/matches/${BOT_S.matchId}`);
        urlsToTry.push(`/chess/matches/${BOT_S.matchId}`);
    }
    if (uid && uid !== "0") {
        urlsToTry.push(`/chess/1/${uid}/matches`);
    }

    for (const u of urlsToTry) {
        try {
            const fetchFn = (typeof unsafeWindow !== "undefined" && unsafeWindow.fetch) || window.fetch;
            const res = await fetchFn(u, { method: "GET", headers: hdrs, credentials: "include" });
            if (res.ok) {
                const data = await res.json();
                onMatchData(data);
                if (BOT_S.matchId) return true;
            }
        } catch (_) {}
    }
    return false;
}

async function recoverState() {
    try {
        const entries = performance.getEntriesByType("resource");
        for (const e of entries) {
            const matchHit = e.name.match(/\/chess\/\d+\/(\d+)\/matches\/([^/?#]+)/);
            if (matchHit && matchHit[2] && !e.name.includes('/moves')) {
                const mId = matchHit[2];
                if (_finishedMatchIds.has(String(mId))) continue;
                BOT_S.userId = matchHit[1];
                BOT_S.matchId = mId;
                await _fetchMatchState();
                return;
            }
            const matchHit2 = e.name.match(/\/matches\/([^/?#]+)/);
            if (matchHit2 && matchHit2[1] && !e.name.includes('/moves')) {
                const mId = matchHit2[1];
                if (_finishedMatchIds.has(String(mId))) continue;
                BOT_S.matchId = mId;
                await _fetchMatchState();
                return;
            }
        }

        const canvas = findCanvas();
        if (canvas || location.pathname.includes("chess")) {
            await _fetchMatchState();
        }

        if (!location.pathname.includes("chess")) {
            await _fetchSession();
        }
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  SVG DEVICE ICONS & DRAGGABLE HUD (ZERO EMOJIS)
// ══════════════════════════════════════════════════════════════════════════════

let _panel = null;

const STYLE = `
#dc-pill{
    position:fixed;bottom:18px;right:18px;
    background:rgba(15,23,42,0.96);border:1px solid rgba(148,163,184,0.25);
    border-radius:10px;padding:9px 12px;
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace, sans-serif;
    color:#f8fafc;z-index:2147483647;user-select:none;
    box-shadow:0 6px 22px rgba(0,0,0,0.6);
    display:flex;flex-direction:column;gap:6px;
    min-width:215px;max-width:260px;cursor:grab;touch-action:none;
    font-size:11px;box-sizing:border-box;
}
#dc-pill.dragging{cursor:grabbing;opacity:0.92;}
.dc-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.dc-title{font-weight:900;color:#58cc02;font-size:11px;letter-spacing:0.6px;}
.dc-status{
    font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;
    background:#334155;color:#94a3b8;text-transform:uppercase;letter-spacing:0.3px;
}
.dc-status.active{background:#16a34a;color:#fff;}
.dc-status.thinking{background:#d97706;color:#fff;}
.dc-status.matching{background:#2563eb;color:#fff;}
.dc-info{
    font-size:10px;color:#94a3b8;border-top:1px solid #1e293b;padding-top:5px;
    display:flex;align-items:center;justify-content:space-between;gap:6px;
}
.dc-engine{color:#38bdf8;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px;}
.dc-move{color:#facc15;font-family:monospace;font-weight:800;font-size:10px;}
.dc-btn-grid{
    display:grid;grid-template-columns:1fr 1fr;gap:6px;
    border-top:1px solid #1e293b;padding-top:5px;
}
.dc-btn{
    background:#58cc02;color:#000;border:none;border-radius:5px;
    padding:5px 6px;font-size:9.5px;font-weight:800;cursor:pointer;
    line-height:1.2;text-align:center;transition:background 0.15s ease;
    white-space:nowrap;user-select:none;
}
.dc-btn.off{background:#334155;color:#94a3b8;}
.dc-btn:hover{filter:brightness(1.08);}
.dc-btn:active{filter:brightness(0.92);}
.dc-footer{
    border-top:1px solid #1e293b;padding-top:5px;
    display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.dc-stats{display:flex;align-items:center;gap:8px;font-size:10px;font-weight:700;}
.dc-stat{color:#64748b;}
.dc-w-num{color:#58cc02;font-weight:800;font-size:11px;}
.dc-m-num{color:#38bdf8;font-weight:800;font-size:11px;}
.dc-btn-rst{
    background:#1e293b;color:#94a3b8;border:1px solid rgba(148,163,184,0.2);
    border-radius:4px;padding:2px 6px;font-size:9px;font-weight:700;
    cursor:pointer;line-height:1.2;text-transform:uppercase;transition:all 0.15s ease;
}
.dc-btn-rst:hover{background:#334155;color:#f8fafc;border-color:rgba(148,163,184,0.4);}
.dc-btn-rst:active{background:#475569;}
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
    <div class="dc-row">
        <span class="dc-title">DUOCHESS</span>
        <span class="dc-status" id="dc-st">${esc(BOT_S.status)}</span>
    </div>
    <div class="dc-info">
        <span class="dc-engine" id="dc-eng">${esc(BOT_S.engineName || "Stockfish 16+")}</span>
        <span class="dc-move" id="dc-mv">${esc(BOT_S.lastMove || "-")}</span>
    </div>
    <div class="dc-btn-grid">
        <button id="dc-tg-play" class="dc-btn ${BOT_CFG.autoPlay ? '' : 'off'}">${BOT_CFG.autoPlay ? 'AUTO PLAY: ON' : 'AUTO PLAY: OFF'}</button>
        <button id="dc-tg-match" class="dc-btn ${BOT_CFG.autoMatch ? '' : 'off'}">${BOT_CFG.autoMatch ? 'AUTO MATCH: ON' : 'AUTO MATCH: OFF'}</button>
    </div>
    <div class="dc-footer">
        <div class="dc-stats">
            <span class="dc-stat">WINS: <b id="dc-w" class="dc-w-num">${BOT_S.matchesWon}</b></span>
            <span class="dc-stat">MOVES: <b id="dc-m" class="dc-m-num">${BOT_S.movesPlayed}</b></span>
        </div>
        <button id="dc-rst" class="dc-btn-rst" title="Reset match stats">RESET</button>
    </div>`;

    document.body.appendChild(_panel);

    const tgPlay = _panel.querySelector("#dc-tg-play");
    if (tgPlay) {
        tgPlay.addEventListener("pointerdown", (e) => e.stopPropagation());
        tgPlay.addEventListener("touchstart", (e) => e.stopPropagation());
        tgPlay.addEventListener("click", (e) => {
            e.stopPropagation();
            BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
            saveSettings();
            renderPanel();
        });
    }

    const tgMatch = _panel.querySelector("#dc-tg-match");
    if (tgMatch) {
        tgMatch.addEventListener("pointerdown", (e) => e.stopPropagation());
        tgMatch.addEventListener("touchstart", (e) => e.stopPropagation());
        tgMatch.addEventListener("click", (e) => {
            e.stopPropagation();
            BOT_CFG.autoMatch = !BOT_CFG.autoMatch;
            saveSettings();
            renderPanel();
        });
    }

    const rst = _panel.querySelector("#dc-rst");
    if (rst) {
        rst.addEventListener("pointerdown", (e) => e.stopPropagation());
        rst.addEventListener("touchstart", (e) => e.stopPropagation());
        rst.addEventListener("click", (e) => {
            e.stopPropagation();
            resetStats();
        });
    }

    makeDraggable(_panel);
    renderPanel();
}

function makeDraggable(el) {
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    function keepInBounds() {
        if (!el || !el.isConnected) return;
        const rect = el.getBoundingClientRect();
        const maxL = Math.max(10, window.innerWidth - rect.width - 12);
        const maxT = Math.max(10, window.innerHeight - rect.height - 12);
        if (rect.right > window.innerWidth || rect.left < 0 || rect.bottom > window.innerHeight || rect.top < 0) {
            el.style.left = Math.min(maxL, Math.max(10, rect.left)) + "px";
            el.style.top = Math.min(maxT, Math.max(10, rect.top)) + "px";
            el.style.bottom = "auto";
            el.style.right = "auto";
        }
    }

    window.addEventListener("resize", keepInBounds);

    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY + "_pos") || "null");
        if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
            const maxL = Math.max(10, window.innerWidth - 240);
            const maxT = Math.max(10, window.innerHeight - 90);
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
    const eng = _panel.querySelector("#dc-eng");
    const mv = _panel.querySelector("#dc-mv");
    const w  = _panel.querySelector("#dc-w");
    const m  = _panel.querySelector("#dc-m");
    const tgPlay = _panel.querySelector("#dc-tg-play");
    const tgMatch = _panel.querySelector("#dc-tg-match");

    if (st) {
        st.textContent = BOT_S.status.toUpperCase();
        const isAct = BOT_S.status === "playing" || BOT_S.status === "our_turn";
        const isMatch = BOT_S.status === "matching";
        st.className = `dc-status ${isAct ? 'active' : BOT_S.status === 'thinking' ? 'thinking' : isMatch ? 'matching' : ''}`;
    }
    if (eng) eng.textContent = BOT_S.engineName || "Stockfish 16+";
    if (mv) mv.textContent = BOT_S.lastMove || "-";
    if (w) w.textContent = BOT_S.matchesWon;
    if (m) m.textContent = BOT_S.movesPlayed;
    if (tgPlay) {
        tgPlay.textContent = BOT_CFG.autoPlay ? "AUTO PLAY: ON" : "AUTO PLAY: OFF";
        tgPlay.className = `dc-btn ${BOT_CFG.autoPlay ? '' : 'off'}`;
    }
    if (tgMatch) {
        tgMatch.textContent = BOT_CFG.autoMatch ? "AUTO MATCH: ON" : "AUTO MATCH: OFF";
        tgMatch.className = `dc-btn ${BOT_CFG.autoMatch ? '' : 'off'}`;
    }
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

        // Watchdog 2: If it's our turn and idle/waiting with no move attempted for > 1.5s, re-trigger takeTurn
        if (isOurTurn(BOT_S.currentFen) && !BOT_S.turnInProgress && BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
            if (Date.now() - _lastMoveAttemptTime > 1500) {
                setStatus("our_turn");
                if (BOT_CFG.autoPlay) {
                    takeTurn();
                }
            }
        }

        if (!BOT_CFG.autoPlay && !BOT_CFG.autoMatch) continue;

        // Auto promote & advance flow / auto match
        autoClickPromotion();

        if (BOT_S.status !== "playing" && BOT_S.status !== "thinking" && !BOT_S.turnInProgress) {
            if (BOT_CFG.autoMatch) {
                autoMatchOscar();
            } else if (BOT_CFG.autoPlay) {
                advanceFlow();
            }
        }

        // Watchdog: If promotion is pending or last move was promotion, tap Queen canvas modal coordinates
        const isPromoMove = BOT_S.lastMove && (BOT_S.lastMove.length >= 5 || BOT_S.lastMove.endsWith("q") || BOT_S.lastMove.endsWith("Q"));
        if ((_pendingPromotionSq || isPromoMove) && BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
            const canvas = findCanvas();
            if (canvas) {
                const flip = BOT_CFG.flipped || (BOT_S.playerColor || "").toLowerCase() === "black";
                const coords = getPromotionQueenCoords(canvas, _pendingPromotionSq || (BOT_S.lastMove ? BOT_S.lastMove.slice(2, 4) : null), BOT_CFG.boardInsetRatio, flip);
                for (const pt of coords) {
                    dispatchTap(canvas, pt.x, pt.y, 35);
                }
                try {
                    for (const key of ["q", "Q", "1", "Enter", " "]) {
                        const evOpts = { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true, composed: true };
                        window.dispatchEvent(new KeyboardEvent("keydown", evOpts));
                        document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
                    }
                } catch (_) {}
            }
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
            } else if (BOT_CFG.autoPlay && isOurTurn(BOT_S.currentFen) && (BOT_S.status === "idle" || BOT_S.status === "waiting")) {
                if (!BOT_S.turnInProgress && (Date.now() - _lastMoveAttemptTime > 1200)) {
                    setStatus("our_turn");
                    takeTurn();
                }
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
