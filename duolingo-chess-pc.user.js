// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (PC / Desktop Edition)
// @namespace    duochess-pc
// @version      6.0.0
// @description  Complete rewrite: ultra-stable Duolingo Chess bot with Stockfish 16+, Lichess Cloud Eval, embedded engine fallback, zero sticking, zero stalemate, zero repetition draws, instant checkmate, and auto-match loop.
// @match        https://www.duolingo.com/*
// @match        https://*.duolingo.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      stockfish.online
// @connect      *.stockfish.online
// @connect      lichess.org
// @connect      *.lichess.org
// @connect      www.chessdb.cn
// @connect      chessdb.cn
// @license      MIT
// ==/UserScript==

(() => {
"use strict";

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ══════════════════════════════════════════════════════════════════════════════

const BOT_CFG = {
    engine:          "hybrid",
    stockfishDepth:  14,
    clickDelay:      70,
    moveDelay:       70,
    thinkDelay:      10,
    boardInsetRatio: 64 / 648,
    flipped:         false,
    autoPlay:        true,
    autoMatch:       true,
};

const SOL_CFG = {
    boardInsetRatio: 64 / 648,
    clickDelay:      70,
    moveDelay:       70,
    enemyDelay:      180,
    continueDelay:   60,
    autoContinue:    true,
    flipped:         false,
};

const STORE_KEY = "duochess.v60.settings";

function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        if (saved.bot) Object.assign(BOT_CFG, saved.bot);
        if (saved.solver) Object.assign(SOL_CFG, saved.solver);
        if (BOT_CFG.clickDelay < 60) BOT_CFG.clickDelay = 70;
        if (BOT_CFG.moveDelay < 60) BOT_CFG.moveDelay = 70;
        if (SOL_CFG.clickDelay < 60) SOL_CFG.clickDelay = 70;
        if (SOL_CFG.moveDelay < 60) SOL_CFG.moveDelay = 70;
    } catch (_) {}
}

function saveSettings() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ bot: BOT_CFG, solver: SOL_CFG }));
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  STATE & UTILITIES
// ══════════════════════════════════════════════════════════════════════════════

const sleep   = ms => new Promise(r => setTimeout(r, ms));
const UCI_RE  = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim());
const toUCI   = s => String(s).trim().split(/\s+/).filter(validUCI);
const esc     = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const fenSide = fen => (fen?.split(" ")?.[1] ?? "w").toLowerCase();

let _lastStateChange     = Date.now();
let _lastMoveAttemptTime = 0;
let _lastMoveSentTime    = 0;
let _lastAttemptedFen    = null;
let _lastAttemptCount    = 0;
let _lastFetchTime       = 0;
let _lastRecoverTime     = 0;
let _lastAutoMatchTime   = 0;
let _lastBotMove         = null;

const _finishedMatchIds    = new Set();
const _gamePositionCounts  = new Map();

/** Extract board+castling+ep (first 4 FEN fields) as a canonical position key */
function getPositionKey(fen) {
    if (!fen || typeof fen !== "string") return "";
    return fen.split(/\s+/).slice(0, 4).join(" ");
}

const BOT_S = {
    matchId:         null,
    playerColor:     "white",
    currentFen:      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    lastRecordedFen: null,
    turnInProgress:  false,
    moveHistory:     [],
    status:          "idle",
    authToken:       null,
    engineName:      "Embedded GM",
    lastMove:        null,
    userId:          null,
};

function setStatus(newStatus) {
    if (BOT_S.status !== newStatus) {
        BOT_S.status = newStatus;
        _lastStateChange = Date.now();
        renderPanel();
    }
}

const SOL_STATE = {
    raw:        null,
    challenges: [],
    currentIdx: 0,
    solving:    false,
};

loadSettings();

// ══════════════════════════════════════════════════════════════════════════════
//  FULL EMBEDDED CHESS ENGINE (ZERO NETWORK DEPENDENCY)
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

const PST_ROOK = [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0
];

const PST_QUEEN = [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20
];

const PST_KING = [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20
];

const PST_MAP = { p: PST_PAWN, n: PST_KNIGHT, b: PST_BISHOP, r: PST_ROOK, q: PST_QUEEN, k: PST_KING };

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
        this.halfMoves = parseInt(parts[4]) || 0;
        this.fullMoves = parseInt(parts[5]) || 1;
    }

    _sqToIdx(sq) {
        return (8 - Number(sq[1])) * 8 + (sq.charCodeAt(0) - 97);
    }

    _idxToSq(idx) {
        return String.fromCharCode(97 + (idx % 8)) + (8 - Math.floor(idx / 8));
    }

    toFen() {
        let fen = "";
        for (let r = 0; r < 8; r++) {
            let empty = 0;
            for (let c = 0; c < 8; c++) {
                const p = this.board[r * 8 + c];
                if (!p) {
                    empty++;
                } else {
                    if (empty > 0) { fen += empty; empty = 0; }
                    fen += (p.color === "w" ? p.type.toUpperCase() : p.type.toLowerCase());
                }
            }
            if (empty > 0) fen += empty;
            if (r < 7) fen += "/";
        }
        fen += " " + this.turn;
        let cast = "";
        if (this.castling.K) cast += "K";
        if (this.castling.Q) cast += "Q";
        if (this.castling.k) cast += "k";
        if (this.castling.q) cast += "q";
        fen += " " + (cast || "-");
        fen += " " + (this.epSquare !== null ? this._idxToSq(this.epSquare) : "-");
        fen += ` ${this.halfMoves} ${this.fullMoves}`;
        return fen;
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
                const tr = Math.floor(target / 8), tf = target % 8;
                const dr = Math.abs(tr - r), df = Math.abs(tf - f);
                if ((dr === 1 && df === 2) || (dr === 2 && df === 1)) {
                    const p = this.board[target];
                    if (p && p.color === attackerColor && p.type === "n") return true;
                }
            }
        }

        // Ray attacks (Bishop, Rook, Queen)
        const rayDirs = [
            [-1, 0, "rq"], [1, 0, "rq"], [0, -1, "rq"], [0, 1, "rq"],
            [-1, -1, "bq"], [-1, 1, "bq"], [1, -1, "bq"], [1, 1, "bq"]
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
                        // Generate ALL promotion types for completeness
                        for (const promo of ["q", "r", "b", "n"]) {
                            moves.push({ from: i, to: fwd, promo });
                        }
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
                                    for (const promo of ["q", "r", "b", "n"]) {
                                        moves.push({ from: i, to: target, promo, capture: tp.type });
                                    }
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
                    if (target >= 0 && target < 64) {
                        const tr = Math.floor(target / 8), tf = target % 8;
                        const dr = Math.abs(tr - r), df = Math.abs(tf - f);
                        if ((dr === 1 && df === 2) || (dr === 2 && df === 1)) {
                            const tp = this.board[target];
                            if (!tp) moves.push({ from: i, to: target });
                            else if (tp.color === them) moves.push({ from: i, to: target, capture: tp.type });
                        }
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
                        this.board[63]?.type === "r" && this.board[63]?.color === "w" &&
                        !this.isSquareAttacked(60, "b") && !this.isSquareAttacked(61, "b") && !this.isSquareAttacked(62, "b")) {
                        moves.push({ from: 60, to: 62, isCastle: true });
                    }
                    if (this.castling.Q && !this.board[59] && !this.board[58] && !this.board[57] &&
                        this.board[56]?.type === "r" && this.board[56]?.color === "w" &&
                        !this.isSquareAttacked(60, "b") && !this.isSquareAttacked(59, "b") && !this.isSquareAttacked(58, "b")) {
                        moves.push({ from: 60, to: 58, isCastle: true });
                    }
                } else if (us === "b" && r === 0 && f === 4) {
                    if (this.castling.k && !this.board[5] && !this.board[6] &&
                        this.board[7]?.type === "r" && this.board[7]?.color === "b" &&
                        !this.isSquareAttacked(4, "w") && !this.isSquareAttacked(5, "w") && !this.isSquareAttacked(6, "w")) {
                        moves.push({ from: 4, to: 6, isCastle: true });
                    }
                    if (this.castling.q && !this.board[3] && !this.board[2] && !this.board[1] &&
                        this.board[0]?.type === "r" && this.board[0]?.color === "b" &&
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
        if (!piece) return;
        const isPawn = piece.type === "p";
        const isCapture = !!m.capture || !!this.board[m.to];

        this.board[m.from] = null;
        if (m.promo) {
            this.board[m.to] = { type: m.promo, color: piece.color };
        } else {
            this.board[m.to] = piece;
        }

        // En Passant capture
        if (m.isEp) {
            const epCapIdx = piece.color === "w" ? m.to + 8 : m.to - 8;
            this.board[epCapIdx] = null;
        }

        // Castling rook move
        if (m.isCastle) {
            if (m.to === 62) { this.board[61] = this.board[63]; this.board[63] = null; }
            else if (m.to === 58) { this.board[59] = this.board[56]; this.board[56] = null; }
            else if (m.to === 6) { this.board[5] = this.board[7]; this.board[7] = null; }
            else if (m.to === 2) { this.board[3] = this.board[0]; this.board[0] = null; }
        }

        // Update castling rights
        if (piece.type === "k") {
            if (piece.color === "w") { this.castling.K = false; this.castling.Q = false; }
            else { this.castling.k = false; this.castling.q = false; }
        } else if (piece.type === "r") {
            if (m.from === 63) this.castling.K = false;
            else if (m.from === 56) this.castling.Q = false;
            else if (m.from === 7) this.castling.k = false;
            else if (m.from === 0) this.castling.q = false;
        }
        if (m.to === 63) this.castling.K = false;
        else if (m.to === 56) this.castling.Q = false;
        else if (m.to === 7) this.castling.k = false;
        else if (m.to === 0) this.castling.q = false;

        // Update en passant square
        if (isPawn && Math.abs(m.to - m.from) === 16) {
            this.epSquare = (m.from + m.to) / 2;
        } else {
            this.epSquare = null;
        }

        // Update half-move clock
        if (isPawn || isCapture) {
            this.halfMoves = 0;
        } else {
            this.halfMoves++;
        }

        // Update full moves
        if (this.turn === "b") this.fullMoves++;

        // Switch turn
        this.turn = this.turn === "w" ? "b" : "w";
    }

    getLegalMoves() {
        const pseudos = this.generatePseudoMoves();
        const legal = [];
        const us = this.turn;
        for (const m of pseudos) {
            const clone = this.clone();
            clone.makeMove(m);
            if (!clone.inCheck(us)) {
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
            const pst = PST_MAP[p.type];
            if (pst) val += pst[tableIdx] || 0;
            score += p.color === "w" ? val : -val;
        }
        return this.turn === "w" ? score : -score;
    }

    /**
     * Quiescence search — extends search through capture chains
     * to prevent horizon-effect blunders
     */
    quiescence(alpha, beta, qdepth = 3) {
        const standPat = this.evaluate();
        if (qdepth === 0) return standPat;
        if (standPat >= beta) return beta;
        if (alpha < standPat) alpha = standPat;

        const captures = this.getLegalMoves().filter(m => m.capture);
        if (captures.length === 0) return standPat;

        // MVV-LVA ordering
        captures.sort((a, b) => (PIECE_VALS[b.capture] || 100) - (PIECE_VALS[a.capture] || 100));

        for (const m of captures) {
            const clone = this.clone();
            clone.makeMove(m);
            const score = -clone.quiescence(-beta, -alpha, qdepth - 1);
            if (score >= beta) return beta;
            if (score > alpha) alpha = score;
        }
        return alpha;
    }

    /**
     * Negamax with alpha-beta pruning
     * Terminal conditions:
     *  - Checkmate = -100000 - depth (losing, penalize slow mates)
     *  - Stalemate = 0 (DRAW — never favorable)
     */
    minimax(depth, alpha, beta) {
        if (depth === 0) return this.quiescence(alpha, beta, 3);

        const moves = this.getLegalMoves();
        if (moves.length === 0) {
            if (this.inCheck(this.turn)) return -100000 - depth;
            return 0; // Stalemate = DRAW, score exactly 0
        }

        // Move ordering: captures first (MVV-LVA), then promotions
        moves.sort((a, b) => {
            const aScore = (a.capture ? (PIECE_VALS[a.capture] || 100) + 10000 : 0) + (a.promo ? 9000 : 0);
            const bScore = (b.capture ? (PIECE_VALS[b.capture] || 100) + 10000 : 0) + (b.promo ? 9000 : 0);
            return bScore - aScore;
        });

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

    /**
     * Find the best move with full draw-prevention guards:
     * 1. Instant checkmate scan
     * 2. Filter out moves causing immediate stalemate
     * 3. Filter out moves causing threefold repetition
     * 4. Anti-oscillation penalty
     * 5. Negamax depth-3 with quiescence
     */
    getBestMove(depth = 3) {
        const moves = this.getLegalMoves();
        if (!moves.length) return null;

        // 1. INSTANT CHECKMATE SCAN (0ms)
        for (const m of moves) {
            const clone = this.clone();
            clone.makeMove(m);
            const oppLegal = clone.getLegalMoves();
            if (oppLegal.length === 0 && clone.inCheck(clone.turn)) {
                return this.moveToUci(m);
            }
        }

        // 2. SEPARATE MOVES INTO "SAFE" (non-drawing) AND "RISKY" (drawing) POOLS
        const safeMoves = [];
        const riskyMoves = [];

        for (const m of moves) {
            const clone = this.clone();
            clone.makeMove(m);
            const oppLegal = clone.getLegalMoves();

            // Check: does this move cause immediate stalemate?
            const causesStalemate = oppLegal.length === 0 && !clone.inCheck(clone.turn);

            // Check: does this move cause threefold repetition?
            const nextKey = getPositionKey(clone.toFen());
            const causesRepetition = (_gamePositionCounts.get(nextKey) || 0) >= 2;

            if (causesStalemate || causesRepetition) {
                riskyMoves.push(m);
            } else {
                safeMoves.push(m);
            }
        }

        // Use safe moves if available; only use risky (drawing) moves as absolute last resort
        const searchPool = safeMoves.length > 0 ? safeMoves : riskyMoves.length > 0 ? riskyMoves : moves;

        // Move ordering for search
        searchPool.sort((a, b) => {
            const aScore = (a.capture ? (PIECE_VALS[a.capture] || 100) + 10000 : 0) + (a.promo ? 9000 : 0);
            const bScore = (b.capture ? (PIECE_VALS[b.capture] || 100) + 10000 : 0) + (b.promo ? 9000 : 0);
            return bScore - aScore;
        });

        let bestMove = searchPool[0];
        let bestVal = -Infinity;
        let alpha = -Infinity;
        const beta = Infinity;

        for (const m of searchPool) {
            const uci = this.moveToUci(m);
            const clone = this.clone();
            clone.makeMove(m);
            let ev = -clone.minimax(depth - 1, -beta, -alpha);

            // ANTI-OSCILLATION: Strong penalty for moving a piece back to where it came from
            if (_lastBotMove &&
                uci.slice(0, 2) === _lastBotMove.slice(2, 4) &&
                uci.slice(2, 4) === _lastBotMove.slice(0, 2)) {
                ev -= 500; // Strong penalty — 5x a pawn value
            }

            // Additional: penalize moves leading to positions we've seen before (even if < 3)
            const nextKey = getPositionKey(clone.toFen());
            const seenCount = _gamePositionCounts.get(nextKey) || 0;
            if (seenCount >= 1) {
                ev -= 150 * seenCount; // Progressive penalty for revisited positions
            }

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

/**
 * Rebuild the full position count history from a move list.
 * This ensures threefold-repetition detection works even when
 * joining a game mid-progress.
 */
function rebuildPositionCounts(startFen, moveHistory) {
    _gamePositionCounts.clear();
    try {
        const game = new FastChess(startFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
        _gamePositionCounts.set(getPositionKey(game.toFen()), 1);
        if (Array.isArray(moveHistory)) {
            for (const uci of moveHistory) {
                if (typeof uci === "string" && validUCI(uci)) {
                    const from = game._sqToIdx(uci.slice(0, 2));
                    const to = game._sqToIdx(uci.slice(2, 4));
                    const promo = uci.length >= 5 ? uci[4] : null;
                    game.makeMove({ from, to, promo });
                    const k = getPositionKey(game.toFen());
                    _gamePositionCounts.set(k, (_gamePositionCounts.get(k) || 0) + 1);
                }
            }
        }
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  MOVE FINDER: OPENING BOOK + CLOUD ENGINES + LOCAL ENGINE
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
                    method, url, data, timeout: timeoutMs, headers,
                    onload: (res) => {
                        if (res.status >= 200 && res.status < 300) {
                            try { resolve(JSON.parse(res.responseText)); }
                            catch (e) { reject(e); }
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
            .then(r => { clearTimeout(tid); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
            .then(resolve)
            .catch(reject);
    });
}

function getBookMove(fen) {
    const fenSimple = fen.split(" ").slice(0, 4).join(" ");
    const openingBook = {
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -": "e2e4",
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3",
        "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "f1c4",
        "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "d2d3",
        "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq -": "c2c3",
        "rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "g1f3",
        "rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "d7d6",
        "rnbqkbnr/pp2pppp/3p4/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq -": "d2d4",
        "rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
        "rnbqkbnr/pppp1ppp/4p3/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "d7d5",
        "rnbqkbnr/pppp1ppp/8/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq -": "e4e5",
        "rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
        "rnbqkbnr/pp1ppppp/2p5/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "d7d5",
        "rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq -": "e4e5",
        "rnbqkbnr/ppppp1pp/8/5p2/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "e4f5",
        "rnbqkbnr/pppppp1p/8/6p1/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -": "d2d4",
        "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq -": "c2c4",
        "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3": "e7e5",
        "rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3": "d7d5",
        "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq -": "d7d5",
        "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq c3": "e7e5",
        "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -": "b8c6",
        "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "g8f6",
        "r1bqkbnr/pppp1ppp/2n5/4p3/1bB1P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "g8f6",
        "r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -": "a7a6",
    };
    return openingBook[fenSimple] ?? null;
}

async function getLichessCloudMove(fen) {
    try {
        const data = await gmHttpFetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`, 1200);
        if (data?.pvs?.[0]?.moves) {
            const mv = data.pvs[0].moves.split(/\s+/)[0];
            if (validUCI(mv)) return mv;
        }
    } catch (_) {}
    return null;
}

async function getFastStockfishMove(fen) {
    try {
        const depth = BOT_CFG.stockfishDepth || 14;
        const data = await gmHttpFetch(`https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${depth}&mode=bestmove`, 2500);
        if (!data?.success || !data?.bestmove) return null;
        const mv = data.bestmove.replace(/^bestmove\s*/, "").split(/\s+/)[0];
        return validUCI(mv) ? mv : null;
    } catch (_) {}
    return null;
}

async function getChessDBMove(fen) {
    try {
        const data = await gmHttpFetch(`https://www.chessdb.cn/cdb.php?action=querybest&board=${encodeURIComponent(fen)}&json=1`, 2000);
        if (data?.status === "ok" && data?.move) {
            const mv = data.move.trim();
            return validUCI(mv) ? mv : null;
        }
    } catch (_) {}
    return null;
}

/**
 * Validate a cloud/external move against draw-prevention rules.
 * Returns true if the move is SAFE (no stalemate, no repetition).
 */
function isMoveDrawSafe(engine, moveUci) {
    try {
        const clone = engine.clone();
        const from = engine._sqToIdx(moveUci.slice(0, 2));
        const to = engine._sqToIdx(moveUci.slice(2, 4));
        const promo = moveUci.length >= 5 ? moveUci[4] : null;
        clone.makeMove({ from, to, promo });
        const oppLegal = clone.getLegalMoves();
        const isStalemate = oppLegal.length === 0 && !clone.inCheck(clone.turn);
        const nextKey = getPositionKey(clone.toFen());
        const isRepetition = (_gamePositionCounts.get(nextKey) || 0) >= 2;
        return !isStalemate && !isRepetition;
    } catch (_) {
        return true; // On error, allow the move
    }
}

/**
 * Master move finder with layered fallback:
 * 1. Opening book
 * 2. Instant checkmate scan
 * 3. Cloud engines (Stockfish, Lichess, ChessDB) — race with 2.2s timeout
 * 4. Local embedded engine (depth 3 + quiescence)
 * Every external move is validated against stalemate/repetition before use.
 */
async function getBestMove(fen) {
    try {
        const engine = new FastChess(fen);
        const legalMoves = engine.getLegalMoves();
        if (!legalMoves || legalMoves.length === 0) return null;
        const legalUcis = legalMoves.map(m => engine.moveToUci(m));

        // 1. Opening Book (0ms)
        const bookMv = getBookMove(fen);
        if (bookMv && legalUcis.includes(bookMv) && isMoveDrawSafe(engine, bookMv)) {
            BOT_S.engineName = "Book Opening";
            return bookMv;
        }

        // 2. Instant Checkmate Scan (0ms)
        for (const m of legalMoves) {
            const clone = engine.clone();
            clone.makeMove(m);
            const oppLegal = clone.getLegalMoves();
            if (oppLegal.length === 0 && clone.inCheck(clone.turn)) {
                BOT_S.engineName = "Instant Mate";
                return engine.moveToUci(m);
            }
        }

        // 3. Cloud Engines (race with 2.2s global timeout)
        const stockfishPromise = getFastStockfishMove(fen).then(mv => {
            if (mv && legalUcis.includes(mv)) return { name: "Stockfish 16+", move: mv };
            throw new Error("miss");
        });
        const lichessPromise = getLichessCloudMove(fen).then(mv => {
            if (mv && legalUcis.includes(mv)) return { name: "Lichess Cloud", move: mv };
            throw new Error("miss");
        });
        const chessdbPromise = getChessDBMove(fen).then(mv => {
            if (mv && legalUcis.includes(mv)) return { name: "ChessDB", move: mv };
            throw new Error("miss");
        });

        try {
            const cloudTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2200));
            const winner = await Promise.race([
                Promise.any([stockfishPromise, lichessPromise, chessdbPromise]),
                cloudTimeout
            ]);
            if (winner?.move && isMoveDrawSafe(engine, winner.move)) {
                BOT_S.engineName = winner.name;
                return winner.move;
            }
        } catch (_) {}

        // 4. Local Embedded Engine (depth 3 + quiescence depth 3)
        const bestMv = engine.getBestMove(3);
        if (bestMv && legalUcis.includes(bestMv)) {
            BOT_S.engineName = "Embedded GM";
            return bestMv;
        }

        // Absolute last resort
        return legalUcis[0];
    } catch (_) {
        try {
            const fallback = new FastChess(fen);
            const legals = fallback.getLegalMoves();
            if (legals.length) return fallback.moveToUci(legals[0]);
        } catch (_) {}
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS DISCOVERY
// ══════════════════════════════════════════════════════════════════════════════

let _canvasCache = { el: null, t: 0 };

function findCanvas() {
    const now = Date.now();
    if (_canvasCache.el && _canvasCache.el.isConnected && (now - _canvasCache.t) < 100) {
        return _canvasCache.el;
    }
    const candidates = [...document.querySelectorAll("canvas")]
        .filter(c => {
            if (!c.isConnected) return false;
            const r = c.getBoundingClientRect();
            if (!(r.width > 140 && r.height > 140 && Math.abs(r.width / r.height - 1) < 0.4)) return false;
            const cs = getComputedStyle(c);
            return cs.pointerEvents !== "none";
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
    while (Date.now() - t0 < timeout) {
        const c = findCanvas();
        if (c) return c;
        await sleep(20);
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

async function waitCanvasChange(baseline, timeout = 250, interval = 15) {
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
//  POINTER EVENT SYNTHESIS (CLEAN — SINGLE DISPATCH, NO DOUBLE-FIRE)
// ══════════════════════════════════════════════════════════════════════════════

function dispatchPointer(type, el, x, y, buttons = 0, button = 0, id = 1) {
    if (!el) return;
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
    const rx = Math.round(x), ry = Math.round(y);
    const px = Math.round(x + (window.scrollX || 0));
    const py = Math.round(y + (window.scrollY || 0));
    const opts = {
        bubbles: true, cancelable: true, composed: true,
        clientX: rx, clientY: ry, screenX: rx, screenY: ry,
        button, buttons,
        pressure: buttons ? 0.5 : 0,
        pointerId: id, pointerType: "mouse",
        isPrimary: true, width: 1, height: 1,
    };

    let pe;
    try {
        pe = typeof PointerEvent === "function" ? new PointerEvent(type, opts) : new MouseEvent(type, opts);
    } catch (_) {
        try { pe = new MouseEvent(type, opts); } catch (_) { return; }
    }

    try {
        Object.defineProperty(pe, "offsetX", { value: rx - r.left, configurable: true });
        Object.defineProperty(pe, "offsetY", { value: ry - r.top, configurable: true });
        Object.defineProperty(pe, "pageX", { value: px, configurable: true });
        Object.defineProperty(pe, "pageY", { value: py, configurable: true });
        Object.defineProperty(pe, "x", { value: rx, configurable: true });
        Object.defineProperty(pe, "y", { value: ry, configurable: true });
    } catch (_) {}

    try { el.dispatchEvent(pe); } catch (_) {}
}

/**
 * Clean single-target tap. Dispatches pointer events ONLY on the given element.
 * NO double-dispatching to overlay elements — this was the root cause of flickering.
 */
async function dispatchTap(el, x, y, pressMs = 25) {
    if (!el) return;
    dispatchPointer("pointerdown", el, x, y, 1, 0, 1);
    dispatchPointer("mousedown", el, x, y, 1, 0, 1);

    if (pressMs > 0) await sleep(pressMs);

    dispatchPointer("pointerup", el, x, y, 0, 0, 1);
    dispatchPointer("mouseup", el, x, y, 0, 0, 1);
    dispatchPointer("click", el, x, y, 0, 0, 1);
}

// ══════════════════════════════════════════════════════════════════════════════
//  COORDINATES & MOVE EXECUTION (CLEAN — NO RETRIES, NO DOUBLE TAP)
// ══════════════════════════════════════════════════════════════════════════════

function getSquareCoords(canvas, sq, insetRatio, flipped) {
    const r = canvas.getBoundingClientRect();
    const iw = r.width * insetRatio, ih = r.height * insetRatio;
    const bw = r.width - (iw * 2), bh = r.height - (ih * 2);
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]);
    const col = flipped ? (7 - file) : file;
    const row = flipped ? (rank - 1) : (8 - rank);
    return {
        x: r.left + iw + (col + 0.5) * (bw / 8),
        y: r.top + ih + (row + 0.5) * (bh / 8)
    };
}

/**
 * Execute a move by tapping source then destination on the canvas.
 * SINGLE dispatch per square — no overlay detection, no double-click.
 */
async function executeMove(uci, insetRatio, flipped) {
    if (!validUCI(uci)) return false;
    const fromSq = uci.slice(0, 2);
    const toSq = uci.slice(2, 4);
    const canvas = await waitCanvas();
    if (!canvas) return false;

    const pFrom = getSquareCoords(canvas, fromSq, insetRatio, flipped);
    const pTo = getSquareCoords(canvas, toSq, insetRatio, flipped);

    // Tap source square to select piece
    await dispatchTap(canvas, pFrom.x, pFrom.y, 30);
    await sleep(BOT_CFG.clickDelay || 70);

    // Tap destination square to place piece
    await dispatchTap(canvas, pTo.x, pTo.y, 30);
    await sleep(BOT_CFG.moveDelay || 70);

    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PAWN PROMOTION (CLEAN — SINGLE ATTEMPT, NO LOOP, NO KEYBOARD SPAM)
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
            return piece.type === "p" && (to[1] === "8" || to[1] === "1");
        }
    } catch (_) {}
    return (to[1] === "8" && from[1] === "7") || (to[1] === "1" && from[1] === "2");
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

let _lastClickTime = 0;

function simulateFullClick(el) {
    if (!el || isForbiddenButton(el)) return false;
    const now = Date.now();
    if (now - _lastClickTime < 180) return false;
    _lastClickTime = now;

    try {
        if (typeof el.focus === "function") el.focus();
        if (typeof el.click === "function") el.click();

        // Trigger React's synthetic onClick handler directly
        const rKey = Object.keys(el).find(k =>
            k.startsWith("__reactProps$") || k.startsWith("__reactEventHandlers$") || k.startsWith("__reactFiber$"));
        if (rKey && el[rKey]) {
            const props = el[rKey].memoizedProps || el[rKey];
            if (typeof props?.onClick === "function") {
                try {
                    props.onClick({
                        preventDefault: () => {},
                        stopPropagation: () => {},
                        target: el,
                        currentTarget: el,
                    });
                } catch (_) {}
            }
        }
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Try to click the Queen promotion button in the DOM.
 * Returns true if a queen selector was found and clicked.
 */
function autoClickPromotion() {
    const queenSelectors = [
        `[data-piece="queen" i]`, `[data-piece="q" i]`, `[data-piece="Q" i]`,
        `[data-test*="queen" i]`, `[data-test*="player-piece-queen" i]`, `[data-test*="promotion-queen" i]`,
        `button[aria-label*="queen" i]`, `div[role="button"][aria-label*="queen" i]`,
        `img[alt*="queen" i]`, `img[src*="queen" i]`, `svg[data-piece*="queen" i]`,
        `[aria-label*="hậu" i]`, `[aria-label*="dame" i]`, `[aria-label*="reina" i]`,
        `[aria-label*="dama" i]`, `[aria-label*="ferz" i]`, `[aria-label*="königin" i]`
    ];

    // Direct Queen button
    for (const sel of queenSelectors) {
        try {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                if (isElementVisible(el) && !isForbiddenButton(el) && !el.closest("#dc-pill")) {
                    simulateFullClick(el);
                    return true;
                }
            }
        } catch (_) {}
    }

    // Promotion modal containers — find Queen inside
    try {
        const promoContainers = document.querySelectorAll(
            '[data-test*="promotion" i], [class*="promotion" i], [id*="promotion" i], div[role="dialog"], [aria-label*="promotion" i]'
        );
        for (const container of promoContainers) {
            if (container.closest("#dc-pill")) continue;
            const queenEl = container.querySelector(queenSelectors.join(", "));
            if (queenEl && isElementVisible(queenEl)) {
                simulateFullClick(queenEl);
                return true;
            }

            // Fallback: find items with "queen" in class/id/content
            const items = Array.from(container.querySelectorAll(
                'button, [role="button"], img, svg, div[tabindex], div[class*="piece" i]'
            )).filter(el => {
                if (el.closest("#dc-pill") || !isElementVisible(el)) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 16 && r.height >= 16 && r.width <= 160 && r.height <= 160;
            });

            const qItem = items.find(el => /queen|dame|reina|hậu|dama|ferz|\bq\b/i.test(el.outerHTML || ""));
            if (qItem) {
                simulateFullClick(qItem);
                return true;
            }
        }
    } catch (_) {}

    return false;
}

/**
 * Handle pawn promotion: SINGLE ATTEMPT strategy.
 * 1. Wait briefly for Duolingo's promotion modal to appear
 * 2. Try DOM queen click ONCE
 * 3. If DOM fails, try canvas tap on the promotion square ONCE
 * 4. Send queen key press ONCE
 * NO LOOPING. The poll loop handles retries if promotion is still pending.
 */
async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
    _pendingPromotionSq = destSq || "q";
    _pendingPromotionTime = Date.now();

    try {
        // Wait for Duolingo's promotion modal to mount
        await sleep(200);

        // Attempt 1: DOM queen click
        if (autoClickPromotion()) {
            await sleep(60);
            _pendingPromotionSq = null;
            return true;
        }

        // Attempt 2: Canvas tap on the destination square (queen appears there)
        const canvas = findCanvas();
        if (canvas) {
            const pt = getSquareCoords(canvas, destSq, insetRatio, flipped);
            await dispatchTap(canvas, pt.x, pt.y, 30);
            await sleep(100);

            // Check if DOM promotion appeared after canvas tap
            if (autoClickPromotion()) {
                await sleep(60);
                _pendingPromotionSq = null;
                return true;
            }
        }

        // Attempt 3: Keyboard 'q' key (some Duolingo versions use keyboard shortcuts)
        try {
            const evOpts = { key: "q", code: "KeyQ", keyCode: 81, bubbles: true, cancelable: true, composed: true };
            document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            document.dispatchEvent(new KeyboardEvent("keyup", evOpts));
        } catch (_) {}

        await sleep(100);

        // Final DOM check
        if (autoClickPromotion()) {
            _pendingPromotionSq = null;
            return true;
        }

        // If we get here, the poll loop will keep trying autoClickPromotion
        // via the _pendingPromotionSq flag until it clears or times out
    } catch (_) {}

    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOM ADVANCE FLOW & AUTO-CLICK REWARDS
// ══════════════════════════════════════════════════════════════════════════════

function autoMatchOscar() {
    if (!BOT_CFG.autoMatch) return false;

    // 1. Handle pending promotion
    if (_pendingPromotionSq && autoClickPromotion()) {
        _pendingPromotionSq = null;
        return true;
    }

    // 2. Direct rematch / play-again buttons
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

    // 3. Post-match advance buttons (Continue, Claim XP, Done, Next)
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

    // 4. Oscar Bot / Start Match buttons
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

    // 5. Oscar character card
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

    // 6. Universal keyword matching
    const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, div[data-test], div[class*="card" i], div[class*="bot" i], div[class*="character" i], li'
    ));

    const oscarKws = ["play against oscar", "play oscar", "oscar", "start match", "start game", "play match", "play now", "play again", "rematch", "play", "start"];
    const flowKws = ["continue", "tiếp tục", "tiep tuc", "next", "claim", "claim reward", "claim xp", "done", "check", "got it", "finish", "ready"];

    for (const raw of candidates) {
        const el = raw.closest("button, [role='button'], a, div[data-test]") || raw;
        if (!isElementVisible(el) || isForbiddenButton(el)) continue;

        const dataTest = (el.getAttribute("data-test") || "").toLowerCase();
        const ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();

        for (const kw of oscarKws) {
            if (txt === kw || (kw === "oscar" && /\boscar\b/i.test(txt)) || ariaLabel.includes(kw) || dataTest.includes(kw.replace(/\s+/g, "-"))) {
                setStatus("matching");
                simulateFullClick(el);
                return true;
            }
        }
        for (const kw of flowKws) {
            if (txt === kw || txt.includes(kw) || ariaLabel.includes(kw) || dataTest.includes(kw.replace(/\s+/g, "-"))) {
                simulateFullClick(el);
                return true;
            }
        }
    }

    return false;
}

function advanceFlow() {
    if (!BOT_CFG.autoPlay && !BOT_CFG.autoMatch) return false;

    if (_pendingPromotionSq && autoClickPromotion()) {
        _pendingPromotionSq = null;
        return true;
    }

    const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], a, div[data-test*="button" i], div[data-test*="next" i], div[data-test*="continue" i], div[data-test*="start" i], div[data-test*="play" i]'
    ));

    const keywords = [
        "continue", "tiếp tục", "tiep tuc", "next", "claim", "claim reward", "claim xp",
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
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MATCH TURN EXECUTION & AUTO-MATCH
// ══════════════════════════════════════════════════════════════════════════════

const MATCHES_RE = /\/chess\b.*\/matches(?:\/([^/?#]+))?/;
const MOVES_RE   = /\/chess\b.*\/matches\/[^/?#]+\/moves/;
const isMatchURL   = url => typeof url === "string" && (MATCHES_RE.test(url) || MOVES_RE.test(url) || /\/matches\b/i.test(url) || /\/chess-match\b/i.test(url));
const isSessionURL = url => typeof url === "string" && /\/sessions(?:[/?#]|$)/i.test(url);

function isOurTurn(fen) {
    const s = fenSide(fen);
    const color = (BOT_S.playerColor || "white").toLowerCase();
    return (s === "w" && color === "white") || (s === "b" && color === "black");
}

function onMatchData(data) {
    if (!data) return;
    const match = data.match ?? (data.boardFen || data.fen ? data : null) ?? (data.chessMatch ? data.chessMatch : null);
    if (!match) return;

    const uid = getUserId();

    // New match detection
    if (match.id && BOT_S.matchId !== match.id) {
        BOT_S.matchId = match.id;
        BOT_S.lastRecordedFen = null;
        _lastAttemptedFen = null;
        _lastAttemptCount = 0;
        _gamePositionCounts.clear();
        _lastBotMove = null;

        if (match.playerColor) {
            BOT_S.playerColor = match.playerColor.toLowerCase();
        } else if (match.whitePlayer && (String(match.whitePlayer.userId) === uid || String(match.whitePlayer.id) === uid)) {
            BOT_S.playerColor = "white";
        } else if (match.blackPlayer && (String(match.blackPlayer.userId) === uid || String(match.blackPlayer.id) === uid)) {
            BOT_S.playerColor = "black";
        } else if (match.whitePlayer?.isBot || match.whitePlayer?.bot || String(match.whitePlayer?.name || "").toLowerCase().includes("oscar")) {
            BOT_S.playerColor = "black";
        } else if (match.blackPlayer?.isBot || match.blackPlayer?.bot || String(match.blackPlayer?.name || "").toLowerCase().includes("oscar")) {
            BOT_S.playerColor = "white";
        } else {
            BOT_S.playerColor = "white";
        }
    }

    // FEN update
    const currentFen = match.boardFen || match.fen || match.currentFen;
    if (currentFen && currentFen !== BOT_S.currentFen) {
        BOT_S.currentFen = currentFen;
        _lastAttemptedFen = null;
        _lastAttemptCount = 0;
        BOT_S.lastRecordedFen = BOT_S.currentFen;
        const pk = getPositionKey(currentFen);
        if (pk) {
            _gamePositionCounts.set(pk, (_gamePositionCounts.get(pk) || 0) + 1);
        }

        // Clear promotion flag when board state changes (move was accepted)
        if (_pendingPromotionSq) {
            _pendingPromotionSq = null;
        }
    }

    // Move history for position counting
    if (Array.isArray(match.moveHistory)) {
        BOT_S.moveHistory = [...match.moveHistory];
        rebuildPositionCounts(match.startFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", match.moveHistory);
    }

    // Match finished
    if (match.endCondition || match.status === "finished") {
        if (match.id) _finishedMatchIds.add(String(match.id));
        if (BOT_S.matchId) _finishedMatchIds.add(String(BOT_S.matchId));
        BOT_S.matchId = null;
        _lastAttemptedFen = null;
        _lastAttemptCount = 0;
        _pendingPromotionSq = null;
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

    // Active match — trigger turn
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
        let move = await getBestMove(startFen);

        // Abort if FEN changed while we were thinking (opponent moved / state changed)
        if (!move || startFen !== BOT_S.currentFen) {
            setStatus("idle");
            return;
        }

        const isPromotion = isPawnPromotion(startFen, move);
        if (isPromotion && !move.endsWith("q")) {
            move = move.slice(0, 4) + "q";
        }

        setStatus("playing");
        BOT_S.lastMove = move;
        _lastBotMove = move;

        const flip = BOT_CFG.flipped || (BOT_S.playerColor || "").toLowerCase() === "black";

        // Execute the move ONCE — clean single tap per square
        await executeMove(move, BOT_CFG.boardInsetRatio, flip);

        // Handle promotion ONCE — no loops
        if (isPromotion) {
            await handlePromotion(move.slice(2, 4), "q", BOT_CFG.boardInsetRatio, flip);
        }

        await sleep(BOT_CFG.moveDelay || 70);
        _lastMoveAttemptTime = Date.now();
        _lastAttemptedFen = startFen;
        _lastAttemptCount = 1;
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
            let m = step.move;
            const isPromotion = m.length >= 5 || (m[1] === "7" && m[3] === "8") || (m[1] === "2" && m[3] === "1");
            if (isPromotion && !m.endsWith("q")) {
                m = m.slice(0, 4) + "q";
            }
            await executeMove(m, SOL_CFG.boardInsetRatio, flip);
            if (isPromotion) {
                await handlePromotion(m.slice(2, 4), "q", SOL_CFG.boardInsetRatio, flip);
            }
            await sleep(SOL_CFG.moveDelay || 70);
        } else {
            const h1 = canvasHash();
            await waitCanvasChange(h1, SOL_CFG.enemyDelay);
            await sleep(25);
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
            await sleep(90);
        }
        await sleep(130);
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
        if (cMatch?.[1]) { BOT_S.userId = cMatch[1]; return BOT_S.userId; }
    } catch (_) {}
    try {
        const duoState = JSON.parse(localStorage.getItem("duo.state") || "{}");
        const uid = duoState.user?.id || duoState.currentUserId || duoState.userId;
        if (uid) { BOT_S.userId = String(uid); return BOT_S.userId; }
    } catch (_) {}
    try {
        const entries = performance.getEntriesByType("resource");
        for (const e of entries) {
            const m = e.name.match(/\/chess\/\d+\/(\d+)\//) || e.name.match(/[?&]user(?:Id)?=(\d+)/);
            if (m?.[1]) { BOT_S.userId = m[1]; return BOT_S.userId; }
        }
    } catch (_) {}
    return "0";
}

function hookNetwork(targetWin) {
    if (!targetWin || targetWin.__dcHooked6) return;
    try { targetWin.__dcHooked6 = true; } catch (_) {}

    const origFetch = targetWin.fetch;
    if (typeof origFetch === "function") {
        targetWin.fetch = async function(...args) {
            const res = await origFetch.apply(this, args);
            try {
                const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? res.url ?? "");
                if (MOVES_RE.test(url)) _lastMoveSentTime = Date.now();
                if (args[1]?.headers) {
                    const h = args[1].headers;
                    const tok = typeof h?.get === "function" ? h.get("authorization") : (h?.["authorization"] || h?.["Authorization"]);
                    if (tok) BOT_S.authToken = tok;
                }
                const uidMatch = url.match(/\/chess\/\d+\/(\d+)\//);
                if (uidMatch?.[1]) BOT_S.userId = uidMatch[1];

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

    if (targetWin.XMLHttpRequest?.prototype) {
        const proto = targetWin.XMLHttpRequest.prototype;
        const origOpen = proto.open;
        const origSend = proto.send;
        proto.open = function(m, url, ...r) {
            this.__dcUrl = String(url ?? "");
            return origOpen.call(this, m, url, ...r);
        };
        proto.send = function(...args) {
            const url = this.__dcUrl;
            if (MOVES_RE.test(url)) _lastMoveSentTime = Date.now();
            if (isMatchURL(url) || isSessionURL(url)) {
                this.addEventListener("load", () => {
                    try {
                        const d = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
                        const uidMatch = url.match(/\/chess\/\d+\/(\d+)\//);
                        if (uidMatch?.[1]) BOT_S.userId = uidMatch[1];
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
            const hit = performance.getEntriesByType("resource").find(e => /\/sessions(?:[/?#&]|$)/i.test(e.name));
            if (hit) sessionUrl = hit.name;
        } catch (_) {}
    }
    if (sessionUrl) {
        try {
            const hdrs = {};
            if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
            const fetchFn = (typeof unsafeWindow !== "undefined" && unsafeWindow.fetch) || window.fetch;
            const r = await fetchFn(sessionUrl, { method: "GET", headers: hdrs, credentials: "include" });
            if (r.ok) { processSession(await r.json()); return true; }
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
                onMatchData(await res.json());
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
            if (matchHit?.[2] && !e.name.includes("/moves")) {
                const mId = matchHit[2];
                if (_finishedMatchIds.has(String(mId))) continue;
                BOT_S.userId = matchHit[1];
                BOT_S.matchId = mId;
                await _fetchMatchState();
                return;
            }
            const matchHit2 = e.name.match(/\/matches\/([^/?#]+)/);
            if (matchHit2?.[1] && !e.name.includes("/moves")) {
                const mId = matchHit2[1];
                if (_finishedMatchIds.has(String(mId))) continue;
                BOT_S.matchId = mId;
                await _fetchMatchState();
                return;
            }
        }

        if (findCanvas() || location.pathname.includes("chess")) {
            await _fetchMatchState();
        }
        if (!location.pathname.includes("chess")) {
            await _fetchSession();
        }
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  DRAGGABLE HUD PANEL
// ══════════════════════════════════════════════════════════════════════════════

let _panel = null;

const STYLE = `
#dc-pill{
    position:fixed;bottom:20px;right:20px;
    background:rgba(15,23,42,0.96);border:1px solid rgba(148,163,184,0.3);
    border-radius:12px;padding:12px 16px;
    font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color:#f8fafc;z-index:2147483647;user-select:none;
    box-shadow:0 8px 32px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.06);
    display:flex;flex-direction:column;gap:8px;
    min-width:280px;max-width:320px;cursor:grab;touch-action:none;
    font-size:13px;box-sizing:border-box;
}
#dc-pill.dragging{cursor:grabbing;opacity:0.92;}
.dc-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.dc-title{font-weight:900;color:#58cc02;font-size:14px;letter-spacing:0.8px;}
.dc-status{
    font-size:11px;font-weight:800;padding:3px 8px;border-radius:5px;
    background:#334155;color:#94a3b8;text-transform:uppercase;letter-spacing:0.4px;
}
.dc-status.active{background:#16a34a;color:#fff;}
.dc-status.thinking{background:#d97706;color:#fff;}
.dc-status.matching{background:#2563eb;color:#fff;}
.dc-info{
    font-size:12px;color:#94a3b8;border-top:1px solid rgba(51,65,85,0.7);padding-top:7px;
    display:flex;align-items:center;justify-content:space-between;gap:8px;
}
.dc-engine{color:#38bdf8;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;}
.dc-move{color:#facc15;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-weight:800;font-size:13px;}
.dc-btn-grid{
    display:grid;grid-template-columns:1fr 1fr;gap:8px;
    border-top:1px solid rgba(51,65,85,0.7);padding-top:7px;
}
.dc-btn{
    background:#58cc02;color:#052e16;border:none;border-radius:7px;
    padding:8px 10px;font-size:11.5px;font-weight:800;cursor:pointer;
    line-height:1.25;text-align:center;transition:background 0.15s ease, filter 0.15s ease;
    white-space:nowrap;user-select:none;
}
.dc-btn.off{background:#334155;color:#94a3b8;}
.dc-btn:hover{filter:brightness(1.1);}
.dc-btn:active{filter:brightness(0.92);}
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
        <span class="dc-title">DUOCHESS v6</span>
        <span class="dc-status" id="dc-st">${esc(BOT_S.status)}</span>
    </div>
    <div class="dc-info">
        <span class="dc-engine" id="dc-eng">${esc(BOT_S.engineName || "Stockfish 16+")}</span>
        <span class="dc-move" id="dc-mv">${esc(BOT_S.lastMove || "-")}</span>
    </div>
    <div class="dc-btn-grid">
        <button id="dc-tg-play" class="dc-btn ${BOT_CFG.autoPlay ? '' : 'off'}">${BOT_CFG.autoPlay ? 'AUTO PLAY: ON' : 'AUTO PLAY: OFF'}</button>
        <button id="dc-tg-match" class="dc-btn ${BOT_CFG.autoMatch ? '' : 'off'}">${BOT_CFG.autoMatch ? 'AUTO MATCH: ON' : 'AUTO MATCH: OFF'}</button>
    </div>`;

    document.body.appendChild(_panel);

    const tgPlay = _panel.querySelector("#dc-tg-play");
    if (tgPlay) {
        tgPlay.addEventListener("pointerdown", e => e.stopPropagation());
        tgPlay.addEventListener("touchstart", e => e.stopPropagation());
        tgPlay.addEventListener("click", e => {
            e.stopPropagation();
            BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
            saveSettings();
            renderPanel();
        });
    }

    const tgMatch = _panel.querySelector("#dc-tg-match");
    if (tgMatch) {
        tgMatch.addEventListener("pointerdown", e => e.stopPropagation());
        tgMatch.addEventListener("touchstart", e => e.stopPropagation());
        tgMatch.addEventListener("click", e => {
            e.stopPropagation();
            BOT_CFG.autoMatch = !BOT_CFG.autoMatch;
            saveSettings();
            renderPanel();
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
        el.style.left = Math.min(maxLeft, Math.max(10, initialLeft + dx)) + "px";
        el.style.top = Math.min(maxTop, Math.max(10, initialTop + dy)) + "px";
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

    const POLL_MS = 25;

    while (true) {
        await sleep(POLL_MS);

        // ─── WATCHDOG 1: Clear stuck thinking/playing if hung > 2.5s ───
        // Reduced from 5s to 2.5s for faster recovery from stuck promotions
        if ((BOT_S.status === "thinking" || BOT_S.status === "playing" || BOT_S.turnInProgress) &&
            (Date.now() - _lastStateChange > 2500)) {
            BOT_S.turnInProgress = false;
            _pendingPromotionSq = null;
            setStatus("idle");
        }

        // ─── WATCHDOG 2: Clear stuck promotion after 1.5s ───
        if (_pendingPromotionSq && (Date.now() - _pendingPromotionTime > 1500)) {
            // Try one more DOM click before giving up
            autoClickPromotion();
            _pendingPromotionSq = null;
        }

        // ─── Turn trigger with safe cooldown ───
        if (BOT_CFG.autoPlay && isOurTurn(BOT_S.currentFen) && !BOT_S.turnInProgress &&
            BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
            const isSameFen = (BOT_S.currentFen === _lastAttemptedFen);
            const cooldown = isSameFen ? 1500 : 80;
            if (Date.now() - _lastMoveAttemptTime > cooldown) {
                setStatus("our_turn");
                takeTurn();
            }
        }

        if (!BOT_CFG.autoPlay && !BOT_CFG.autoMatch) continue;

        // Poll for pending promotion (in case the initial attempt missed)
        if (_pendingPromotionSq) {
            if (autoClickPromotion()) {
                _pendingPromotionSq = null;
            }
        }

        // Auto-match/advance flow (throttled to once per 2s)
        if (BOT_S.status !== "playing" && BOT_S.status !== "thinking" && !BOT_S.turnInProgress) {
            if (Date.now() - _lastAutoMatchTime > 2000) {
                _lastAutoMatchTime = Date.now();
                if (BOT_CFG.autoMatch) {
                    autoMatchOscar();
                } else if (BOT_CFG.autoPlay) {
                    advanceFlow();
                }
            }
        }

        // State recovery
        const canvas = findCanvas();
        if (canvas) {
            if (!BOT_S.matchId && !SOL_STATE.challenges.length) {
                if (Date.now() - _lastRecoverTime > 5000) {
                    _lastRecoverTime = Date.now();
                    await recoverState();
                }
            }

            if (BOT_S.matchId) {
                if (BOT_S.status === "waiting" || BOT_S.status === "idle") {
                    if (Date.now() - _lastFetchTime > 2000) {
                        _lastFetchTime = Date.now();
                        await _fetchMatchState();
                    }
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
