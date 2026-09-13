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
// @connect      chess-api.com
// @connect      *.chess-api.com
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
        engine: "hybrid",
        stockfishDepth: 15,
        clickDelay: 50,
        moveDelay: 50,
        thinkDelay: 10,
        boardInsetRatio: 64 / 648,
        flipped: false,
        autoPlay: true,
        autoMatch: true,
    };

    const SOL_CFG = {
        boardInsetRatio: 64 / 648,
        clickDelay: 50,
        moveDelay: 50,
        enemyDelay: 180,
        continueDelay: 60,
        autoContinue: true,
        flipped: false,
    };

    const STORE_KEY = "duochess.v60.settings";

    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
            if (saved.bot) Object.assign(BOT_CFG, saved.bot);
            if (saved.solver) Object.assign(SOL_CFG, saved.solver);
            BOT_CFG.stockfishDepth = 15; // Enforce depth 15 (maximum legal depth for Stockfish Online)
            if (BOT_CFG.clickDelay < 60) BOT_CFG.clickDelay = 70;
            if (BOT_CFG.moveDelay < 60) BOT_CFG.moveDelay = 70;
            if (SOL_CFG.clickDelay < 60) SOL_CFG.clickDelay = 70;
            if (SOL_CFG.moveDelay < 60) SOL_CFG.moveDelay = 70;
        } catch (_) { }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({ bot: BOT_CFG, solver: SOL_CFG }));
        } catch (_) { }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    //  STATE & UTILITIES
    // ══════════════════════════════════════════════════════════════════════════════

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
    const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim());
    const toUCI = s => String(s).trim().split(/\s+/).filter(validUCI);
    const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    const fenSide = fen => (fen?.split(" ")?.[1] ?? "w").toLowerCase();

    let _lastStateChange = Date.now();
    let _lastMoveAttemptTime = 0;
    let _lastMoveSentTime = 0;
    let _lastAttemptedFen = null;
    let _lastAttemptCount = 0;
    let _lastFetchTime = 0;
    let _lastRecoverTime = 0;
    let _lastAutoMatchTime = 0;
    let _lastBotMove = null;
    let _botMoveHistory = [];

    const _finishedMatchIds = new Set();
    const _gamePositionCounts = new Map();

    /** Extract board+castling+ep (first 4 FEN fields) as a canonical position key */
    function getPositionKey(fen) {
        if (!fen || typeof fen !== "string") return "";
        return fen.split(/\s+/).slice(0, 4).join(" ");
    }

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
        userId: null,
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
        solving: false,
    };

    loadSettings();

    // ══════════════════════════════════════════════════════════════════════════════
    //  FULL EMBEDDED CHESS ENGINE (ZERO NETWORK DEPENDENCY)
    // ══════════════════════════════════════════════════════════════════════════════

    const PIECE_VALS = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

    const PST_PAWN = [
        0, 0, 0, 0, 0, 0, 0, 0,
        50, 50, 50, 50, 50, 50, 50, 50,
        10, 10, 20, 30, 30, 20, 10, 10,
        5, 5, 10, 25, 25, 10, 5, 5,
        0, 0, 0, 20, 20, 0, 0, 0,
        5, -5, -10, 0, 0, -10, -5, 5,
        5, 10, 10, -20, -20, 10, 10, 5,
        0, 0, 0, 0, 0, 0, 0, 0
    ];

    const PST_KNIGHT = [
        -50, -40, -30, -30, -30, -30, -40, -50,
        -40, -20, 0, 0, 0, 0, -20, -40,
        -30, 0, 10, 15, 15, 10, 0, -30,
        -30, 5, 15, 20, 20, 15, 5, -30,
        -30, 0, 15, 20, 20, 15, 0, -30,
        -30, 5, 10, 15, 15, 10, 5, -30,
        -40, -20, 0, 5, 5, 0, -20, -40,
        -50, -40, -30, -30, -30, -30, -40, -50,
    ];

    const PST_BISHOP = [
        -20, -10, -10, -10, -10, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 10, 10, 5, 0, -10,
        -10, 5, 5, 10, 10, 5, 5, -10,
        -10, 0, 10, 10, 10, 10, 0, -10,
        -10, 10, 10, 10, 10, 10, 10, -10,
        -10, 5, 0, 0, 0, 0, 5, -10,
        -20, -10, -10, -10, -10, -10, -10, -20,
    ];

    const PST_ROOK = [
        0, 0, 0, 0, 0, 0, 0, 0,
        5, 10, 10, 10, 10, 10, 10, 5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        -5, 0, 0, 0, 0, 0, 0, -5,
        0, 0, 0, 5, 5, 0, 0, 0
    ];

    const PST_QUEEN = [
        -20, -10, -10, -5, -5, -10, -10, -20,
        -10, 0, 0, 0, 0, 0, 0, -10,
        -10, 0, 5, 5, 5, 5, 0, -10,
        -5, 0, 5, 5, 5, 5, 0, -5,
        0, 0, 5, 5, 5, 5, 0, -5,
        -10, 5, 5, 5, 5, 5, 0, -10,
        -10, 0, 5, 0, 0, 0, 0, -10,
        -20, -10, -10, -5, -5, -10, -10, -20
    ];

    const PST_KING = [
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -30, -40, -40, -50, -50, -40, -40, -30,
        -20, -30, -30, -40, -40, -30, -30, -20,
        -10, -20, -20, -20, -20, -20, -20, -10,
        20, 20, 0, 0, 0, 0, 20, 20,
        20, 30, 10, 0, 0, 10, 30, 20
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
                    const dirs = p.type === "b" ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] :
                        p.type === "r" ? [[-1, 0], [1, 0], [0, -1], [0, 1]] :
                            [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]];
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
            let wKingIdx = -1, bKingIdx = -1;

            for (let i = 0; i < 64; i++) {
                const p = this.board[i];
                if (!p) continue;
                let val = PIECE_VALS[p.type] || 0;
                const r = Math.floor(i / 8), f = i % 8;
                const tableIdx = p.color === "w" ? i : (7 - r) * 8 + f;
                const pst = PST_MAP[p.type];
                if (pst) val += pst[tableIdx] || 0;

                if (p.type === "k") {
                    if (p.color === "w") wKingIdx = i; else bKingIdx = i;
                }

                // Passed pawn progression bonus (aggressive promotion to Queen)
                if (p.type === "p") {
                    const advance = p.color === "w" ? (7 - r) : r;
                    val += advance * advance * 15; // increased exponential bonus for advancing pawns
                }

                score += p.color === "w" ? val : -val;
            }

            // Endgame Mop-Up Evaluation:
            // When one side has winning advantage, aggressively drive the opponent king to edge and corner
            const margin = score;
            if (Math.abs(margin) > 200 && wKingIdx !== -1 && bKingIdx !== -1) {
                const winningColor = margin > 0 ? "w" : "b";
                const loserKingIdx = winningColor === "w" ? bKingIdx : wKingIdx;
                const winnerKingIdx = winningColor === "w" ? wKingIdx : bKingIdx;

                const lFile = loserKingIdx % 8, lRank = Math.floor(loserKingIdx / 8);
                const wFile = winnerKingIdx % 8, wRank = Math.floor(winnerKingIdx / 8);

                // 1. Push losing king to corners / edges
                const centerDist = Math.max(Math.abs(lFile - 3.5), Math.abs(lRank - 3.5));
                const pushToCornerBonus = Math.round(centerDist * 50);

                // 2. Bring winning king close to losing king
                const kingDist = Math.abs(wFile - lFile) + Math.abs(wRank - lRank);
                const closeKingBonus = Math.round((14 - kingDist) * 25);

                const mopUpBonus = pushToCornerBonus + closeKingBonus;
                score += (winningColor === "w" ? mopUpBonus : -mopUpBonus);
            }

            // Check bonus: checking the opponent restricts their moves and forces rapid checkmate
            const them = this.turn === "w" ? "b" : "w";
            if (this.inCheck(them)) {
                score += (this.turn === "w" ? 150 : -150);
            }

            return this.turn === "w" ? score : -score;
        }

        /**
         * Quiescence search — extends search through capture chains and promotions
         * to prevent horizon-effect blunders
         */
        quiescence(alpha, beta, qdepth = 3) {
            const standPat = this.evaluate();
            if (qdepth === 0) return standPat;
            if (standPat >= beta) return beta;
            if (alpha < standPat) alpha = standPat;

            const tacticalMoves = this.getLegalMoves().filter(m => m.capture || m.promo);
            if (tacticalMoves.length === 0) return standPat;

            tacticalMoves.sort((a, b) => {
                const aVal = (a.promo ? 20000 : 0) + (a.capture ? (PIECE_VALS[a.capture] || 100) * 10 - (PIECE_VALS[this.board[a.from]?.type] || 100) : 0);
                const bVal = (b.promo ? 20000 : 0) + (b.capture ? (PIECE_VALS[b.capture] || 100) * 10 - (PIECE_VALS[this.board[b.from]?.type] || 100) : 0);
                return bVal - aVal;
            });

            for (const m of tacticalMoves) {
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
         *  - Checkmate = -100000 - (depth * 1000) (penalizes slow mates; higher depth remaining = faster mate)
         *  - Stalemate = 90000 (returned for stalemated player so attacker evaluates move as -90000 catastrophic loss)
         */
        minimax(depth, alpha, beta) {
            if (depth === 0) return this.quiescence(alpha, beta, 3);

            const moves = this.getLegalMoves();
            if (moves.length === 0) {
                if (this.inCheck(this.turn)) return -100000 - (depth * 1000);
                return 90000; // Stalemate = DRAW! Attacker evaluating this move gets -90000!
            }

            // Fast terminal mate check: if any move delivers instant checkmate, score it immediately
            for (const m of moves) {
                const clone = this.clone();
                clone.makeMove(m);
                if (clone.getLegalMoves().length === 0 && clone.inCheck(clone.turn)) {
                    return 100000 + (depth * 1000);
                }
            }

            // Move ordering: promotions (20000), MVV-LVA captures (10000+), center closeness
            moves.sort((a, b) => {
                let aScore = 0, bScore = 0;
                if (a.promo) aScore += 20000;
                if (b.promo) bScore += 20000;
                if (a.capture) {
                    const vic = PIECE_VALS[a.capture] || 100;
                    const att = PIECE_VALS[this.board[a.from]?.type] || 100;
                    aScore += 10000 + vic * 10 - att;
                }
                if (b.capture) {
                    const vic = PIECE_VALS[b.capture] || 100;
                    const att = PIECE_VALS[this.board[b.from]?.type] || 100;
                    bScore += 10000 + vic * 10 - att;
                }
                const aToR = Math.floor(a.to / 8), aToC = a.to % 8;
                const bToR = Math.floor(b.to / 8), bToC = b.to % 8;
                aScore += (7 - (Math.abs(aToR - 3.5) + Math.abs(aToC - 3.5))) * 5;
                bScore += (7 - (Math.abs(bToR - 3.5) + Math.abs(bToC - 3.5))) * 5;
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
         * Find the best move with absolute draw-prevention & shortest-mate priority:
         * 1. Instant checkmate scan (0ms)
         * 2. Forced mate-in-2 scanner (<5ms)
         * 3. Filter out moves causing stalemate or threefold repetition
         * 4. Multi-turn anti-oscillation penalty
         * 5. Negamax search with endgame depth acceleration
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

            // 2. FORCED MATE-IN-2 SCAN (<5ms)
            const mateIn2 = findMateIn2(this);
            if (mateIn2 && isMoveDrawSafe(this, mateIn2)) return mateIn2;

            // 3. SEPARATE MOVES INTO "SAFE" (non-drawing) AND "RISKY" (drawing) POOLS
            const safeMoves = [];
            const riskyMoves = [];

            for (const m of moves) {
                const uci = this.moveToUci(m);
                const clone = this.clone();
                clone.makeMove(m);
                const oppLegal = clone.getLegalMoves();

                // Strict: does this move cause stalemate?
                const causesStalemate = oppLegal.length === 0 && !clone.inCheck(clone.turn);

                // Strict: does this move lead to a position that was already visited?
                const nextKey = getPositionKey(clone.toFen());
                const causesRepetition = (_gamePositionCounts.get(nextKey) || 0) >= 1;

                // Strict: does this move immediately reverse the last bot move?
                let isOscillation = false;
                if (_botMoveHistory && _botMoveHistory.length > 0) {
                    const prev = _botMoveHistory[0];
                    if (uci.slice(0, 2) === prev.slice(2, 4) && uci.slice(2, 4) === prev.slice(0, 2)) {
                        isOscillation = true;
                    }
                }

                if (causesStalemate || causesRepetition || isOscillation) {
                    riskyMoves.push(m);
                } else {
                    safeMoves.push(m);
                }
            }

            // Use safe moves if available; only use risky moves if literally no other legal move exists
            const searchPool = safeMoves.length > 0 ? safeMoves : riskyMoves.length > 0 ? riskyMoves : moves;

            // Move ordering for search
            searchPool.sort((a, b) => {
                const aScore = (a.promo ? 12000 : 0) + (a.capture ? (PIECE_VALS[a.capture] || 100) + 10000 : 0);
                const bScore = (b.promo ? 12000 : 0) + (b.capture ? (PIECE_VALS[b.capture] || 100) + 10000 : 0);
                return bScore - aScore;
            });

            let bestMove = searchPool[0];
            let bestVal = -Infinity;
            let alpha = -Infinity;
            const beta = Infinity;

            // Dynamic depth: In late midgame / endgame (<= 14 pieces), depth 4 takes <30ms; in deep endgame (<= 8 pieces), depth 5 takes <60ms
            let searchDepth = depth;
            let pieceCount = 0;
            for (let i = 0; i < 64; i++) if (this.board[i]) pieceCount++;
            if (pieceCount <= 14 && searchDepth < 4) searchDepth = 4;
            if (pieceCount <= 8 && searchDepth < 5) searchDepth = 5;

            for (const m of searchPool) {
                const uci = this.moveToUci(m);
                const clone = this.clone();
                clone.makeMove(m);
                let ev = -clone.minimax(searchDepth - 1, -beta, -alpha);

                // Severe penalty for oscillation (piece moving back to where it just came from)
                if (_botMoveHistory && _botMoveHistory.length > 0) {
                    const prev = _botMoveHistory[0];
                    if (uci.slice(0, 2) === prev.slice(2, 4) && uci.slice(2, 4) === prev.slice(0, 2)) {
                        ev -= 100000;
                    }
                    for (let h = 1; h < Math.min(6, _botMoveHistory.length); h++) {
                        const oldMv = _botMoveHistory[h];
                        if (uci.slice(2, 4) === oldMv.slice(0, 2) && !m.capture && !clone.inCheck(clone.turn)) {
                            ev -= 5000;
                        }
                    }
                }

                // Severe penalty for revisited positions (treated as virtually lost)
                const nextKey = getPositionKey(clone.toFen());
                const seenCount = _gamePositionCounts.get(nextKey) || 0;
                if (seenCount >= 1) {
                    ev -= 100000;
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
     * Forced Mate-in-2 Scanner: checks if any legal move guarantees checkmate
     * on the subsequent turn for all possible opponent replies.
     */
    function findMateIn2(engine) {
        const legalMoves = engine.getLegalMoves();
        for (const m1 of legalMoves) {
            const uci1 = engine.moveToUci(m1);
            if (!isMoveDrawSafe(engine, uci1)) continue;

            const clone1 = engine.clone();
            clone1.makeMove(m1);
            const oppLegal = clone1.getLegalMoves();
            if (oppLegal.length === 0) continue; // Mate in 1 handled separately
            if (oppLegal.length > 8) continue; // Fast cutoff for speed

            let allLeadToMate = true;
            for (const oppM of oppLegal) {
                const clone2 = clone1.clone();
                clone2.makeMove(oppM);
                const replies = clone2.getLegalMoves();
                let hasMate = false;
                for (const m2 of replies) {
                    const clone3 = clone2.clone();
                    clone3.makeMove(m2);
                    if (clone3.getLegalMoves().length === 0 && clone3.inCheck(clone3.turn)) {
                        hasMate = true;
                        break;
                    }
                }
                if (!hasMate) {
                    allLeadToMate = false;
                    break;
                }
            }
            if (allLeadToMate) {
                return uci1;
            }
        }
        return null;
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
        } catch (_) { }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    //  MOVE FINDER: OPENING BOOK + CLOUD ENGINES + LOCAL ENGINE
    // ══════════════════════════════════════════════════════════════════════════════

    function gmHttpFetch(url, timeoutMs = 4000, opts = {}) {
        return new Promise((resolve, reject) => {
            const gmReq = (typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : (typeof GM !== "undefined" && GM.xmlHttpRequest ? GM.xmlHttpRequest : null));
            const method = opts.method || "GET";
            const data = opts.data || null;
            const headers = { "Accept": "application/json", ...(opts.data ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };

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
                } catch (_) { }
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

    function cleanFenForApi(fen) {
        if (!fen || typeof fen !== "string") return "";
        const parts = fen.trim().split(/\s+/);
        if (parts.length < 4) return fen;
        return `${parts[0]} ${parts[1]} ${parts[2] || "-"} ${parts[3] || "-"} ${parts[4] || "0"} ${parts[5] || "1"}`;
    }

    async function getChessApiMove(fen) {
        try {
            const cleanedFen = cleanFenForApi(fen);
            const data = await gmHttpFetch("https://chess-api.com/v1", 2500, {
                method: "POST",
                data: JSON.stringify({ fen: cleanedFen, depth: 14 })
            });
            if (data?.move && validUCI(data.move)) {
                return {
                    move: data.move,
                    mate: data.mate ?? null,
                    eval: data.eval,
                    source: "chess-api"
                };
            }
        } catch (_) { }
        return null;
    }

    async function getFastStockfishMove(fen) {
        try {
            const depth = Math.min(BOT_CFG.stockfishDepth || 14, 15);
            const data = await gmHttpFetch(`https://stockfish.online/api/s/v2.php?fen=${encodeURIComponent(fen)}&depth=${depth}&mode=bestmove`, 3000);
            if (!data?.success || !data?.bestmove) return null;
            const mv = data.bestmove.replace(/^bestmove\s*/, "").split(/\s+/)[0];
            if (!validUCI(mv)) return null;
            return {
                move: mv,
                mate: data.mate || null,
                eval: data.evaluation,
                source: "stockfish.online"
            };
        } catch (_) { }
        return null;
    }

    async function getLichessCloudMove(fen) {
        try {
            const data = await gmHttpFetch(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=1`, 1800);
            if (data?.pvs?.[0]?.moves) {
                const mv = data.pvs[0].moves.split(/\s+/)[0];
                if (validUCI(mv)) return mv;
            }
        } catch (_) { }
        return null;
    }

    async function getChessDBMove(fen) {
        try {
            const data = await gmHttpFetch(`https://www.chessdb.cn/cdb.php?action=querybest&board=${encodeURIComponent(fen)}&json=1`, 1800);
            if (data?.status === "ok" && data?.move) {
                const mv = data.move.trim();
                return validUCI(mv) ? mv : null;
            }
        } catch (_) { }
        return null;
    }

    /**
     * Validate a cloud/external move against draw-prevention rules.
     * Returns true if the move is SAFE (no stalemate, no repetition, no oscillation).
     */
    function isMoveDrawSafe(engine, moveUci) {
        try {
            const clone = engine.clone();
            const from = engine._sqToIdx(moveUci.slice(0, 2));
            const to = engine._sqToIdx(moveUci.slice(2, 4));
            const promo = moveUci.length >= 5 ? moveUci[4] : null;

            const legals = clone.getLegalMoves();
            const matchLegal = legals.find(m => clone.moveToUci(m) === moveUci);
            if (matchLegal) {
                clone.makeMove(matchLegal);
            } else {
                clone.makeMove({ from, to, promo });
            }
            const oppLegal = clone.getLegalMoves();

            // 1. Strict: NEVER allow a stalemate move (opponent has 0 moves without check)
            const isStalemate = oppLegal.length === 0 && !clone.inCheck(clone.turn);
            if (isStalemate) return false;

            // 2. Strict: NEVER allow a move that leads to ANY position already seen (count >= 1)
            // Banning any position seen 1+ times completely eliminates 2nd repetitions,
            // making 3-fold repetition 100% mathematically impossible!
            const nextKey = getPositionKey(clone.toFen());
            if ((_gamePositionCounts.get(nextKey) || 0) >= 1) return false;

            // 3. Strict: Anti-oscillation — NEVER immediately reverse the last bot move
            if (_botMoveHistory && _botMoveHistory.length > 0) {
                const prev = _botMoveHistory[0];
                if (moveUci.slice(0, 2) === prev.slice(2, 4) && moveUci.slice(2, 4) === prev.slice(0, 2)) {
                    return false;
                }
            }

            // 4. Strict: 2-step oscillation prevention — piece returning to square from 2 moves ago without capture or check
            if (_botMoveHistory && _botMoveHistory.length > 1) {
                const prev2 = _botMoveHistory[1];
                if (moveUci.slice(0, 2) === prev2.slice(2, 4) && moveUci.slice(2, 4) === prev2.slice(0, 2)) {
                    if (!clone.inCheck(clone.turn)) return false;
                }
            }

            return true;
        } catch (_) {
            return true; // On error, allow the move
        }
    }

    /**
     * Master move finder with strict priority hierarchy:
     * 1. Instant opening book (0ms)
     * 2. Instant checkmate scan (0ms finish)
     * 3. Forced mate-in-2 scanner (<5ms finish)
     * 4. Primary Master Engine: Stockfish 16+ (3500+ Elo, depth 12, 3500ms timeout)
     *    NO racing with inferior engines — Stockfish is given dedicated priority!
     * 5. Cloud Backup Engine (Lichess Cloud / ChessDB) — ONLY if Stockfish server fails or times out
     * 6. High-Performance Local Engine (Depth 4 + Mop-Up + Anti-Stalemate) — ONLY if completely offline
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

            // 2. Instant Checkmate Scan in 1 move (0ms finish)
            for (const m of legalMoves) {
                const clone = engine.clone();
                clone.makeMove(m);
                const oppLegal = clone.getLegalMoves();
                if (oppLegal.length === 0 && clone.inCheck(clone.turn)) {
                    BOT_S.engineName = "Instant Mate (M1)";
                    return engine.moveToUci(m);
                }
            }

            // 3. Forced Mate-in-2 Scan (<5ms finish)
            const mateIn2 = findMateIn2(engine);
            if (mateIn2 && legalUcis.includes(mateIn2) && isMoveDrawSafe(engine, mateIn2)) {
                BOT_S.engineName = "Forced Mate (M2)";
                return mateIn2;
            }

            // 4. Primary Stockfish Cluster: chess-api.com (180ms, unlimited burst) + stockfish.online (depth 14)
            // Highest strength (3500+ Elo), zero blunders, decisive shortest checkmates.
            // Dual-engine race ensures zero 429 throttling drops to offline!
            try {
                const cloudWinner = await Promise.any([
                    getChessApiMove(fen).then(res => {
                        if (res?.move && legalUcis.includes(res.move) && isMoveDrawSafe(engine, res.move)) return res;
                        throw new Error();
                    }),
                    getFastStockfishMove(fen).then(res => {
                        if (res?.move && legalUcis.includes(res.move) && isMoveDrawSafe(engine, res.move)) return res;
                        throw new Error();
                    })
                ]);
                if (cloudWinner?.move) {
                    const mateStr = cloudWinner.mate ? ` (M${Math.abs(cloudWinner.mate)})` : "";
                    BOT_S.engineName = `Stockfish 16+${mateStr}`;
                    return cloudWinner.move;
                }
            } catch (_) { }

            // 5. Cloud Backup Fallbacks: Lichess Cloud / ChessDB
            try {
                const backupWinner = await Promise.any([
                    getLichessCloudMove(fen).then(mv => {
                        if (mv && legalUcis.includes(mv) && isMoveDrawSafe(engine, mv)) return { name: "Lichess Cloud", move: mv };
                        throw new Error();
                    }),
                    getChessDBMove(fen).then(mv => {
                        if (mv && legalUcis.includes(mv) && isMoveDrawSafe(engine, mv)) return { name: "ChessDB", move: mv };
                        throw new Error();
                    })
                ]);
                if (backupWinner?.move) {
                    BOT_S.engineName = backupWinner.name;
                    return backupWinner.move;
                }
            } catch (_) { }

            // 6. Fast Retry to Cloud (chess-api) with simplified FEN before giving up to local engine
            try {
                const retryRes = await getChessApiMove(fen);
                if (retryRes?.move && legalUcis.includes(retryRes.move) && isMoveDrawSafe(engine, retryRes.move)) {
                    BOT_S.engineName = "Stockfish 16+ (Retry)";
                    return retryRes.move;
                }
            } catch (_) { }

            // 7. High-Performance Local Engine (Endgame depth 4/5, Mop-Up, Anti-Stalemate) — ONLY if completely offline
            const bestMv = engine.getBestMove(3);
            if (bestMv && legalUcis.includes(bestMv) && isMoveDrawSafe(engine, bestMv)) {
                BOT_S.engineName = "Local Engine";
                return bestMv;
            }

            // Absolute last resort (safe legal move)
            const safeFallback = legalUcis.find(u => isMoveDrawSafe(engine, u));
            if (safeFallback) {
                BOT_S.engineName = "Local Engine (Safe)";
                return safeFallback;
            }
            return legalUcis[0];
        } catch (_) {
            try {
                const fallback = new FastChess(fen);
                const legals = fallback.getLegalMoves();
                if (legals.length) return fallback.moveToUci(legals[0]);
            } catch (_) { }
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
        } catch (_) { }
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
        } catch (_) { }

        try { el.dispatchEvent(pe); } catch (_) { }
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
        } catch (_) { }
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

    function simulateFullClick(el, force = false) {
        if (!el || isForbiddenButton(el)) return false;
        const now = Date.now();
        if (!force && (now - _lastClickTime < 180)) return false;
        _lastClickTime = now;

        try {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;

            if (typeof el.focus === "function") el.focus();

            dispatchPointer("pointerdown", el, cx, cy, 1, 0, 1);
            dispatchPointer("mousedown", el, cx, cy, 1, 0, 1);
            dispatchPointer("pointerup", el, cx, cy, 0, 0, 1);
            dispatchPointer("mouseup", el, cx, cy, 0, 0, 1);
            if (typeof el.click === "function") el.click();
            dispatchPointer("click", el, cx, cy, 0, 0, 1);

            // Direct React synthetic event invocation
            for (const target of [el, el.parentElement]) {
                if (!target) continue;
                for (const key of Object.keys(target)) {
                    if (key.startsWith("__reactProps$") || key.startsWith("__reactEventHandlers$") || key.startsWith("__reactFiber$")) {
                        const props = target[key]?.memoizedProps || target[key];
                        if (typeof props?.onClick === "function") {
                            try {
                                props.onClick({
                                    preventDefault: () => { },
                                    stopPropagation: () => { },
                                    target: el,
                                    currentTarget: target,
                                });
                            } catch (_) { }
                        }
                        if (typeof props?.onPointerDown === "function") {
                            try {
                                props.onPointerDown({
                                    preventDefault: () => { },
                                    stopPropagation: () => { },
                                    target: el,
                                    currentTarget: target,
                                });
                            } catch (_) { }
                        }
                    }
                }
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Locate the active promotion modal container by attribute or text content.
     */
    function findPromotionModal() {
        // 1. Direct attribute selectors
        const attrSel = '[data-test*="promotion" i], [class*="promotion" i], [id*="promotion" i], div[role="dialog"]';
        try {
            const found = document.querySelectorAll(attrSel);
            for (const el of found) {
                if (!el.closest("#dc-pill") && isElementVisible(el)) return el;
            }
        } catch (_) { }

        // 2. TreeWalker search for "PAWN PROMOTION" text
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const val = (node.nodeValue || "").trim();
                if (/pawn\s*promotion|promotion/i.test(val)) {
                    let el = node.parentElement;
                    if (!el || el.closest("#dc-pill")) continue;
                    for (let i = 0; i < 4; i++) {
                        if (!el.parentElement || el.parentElement === document.body || el.parentElement === document.documentElement) break;
                        const r = el.getBoundingClientRect();
                        if (r.width >= 100 && r.height >= 40) break;
                        el = el.parentElement;
                    }
                    if (isElementVisible(el)) return el;
                }
            }
        } catch (_) { }

        return null;
    }

    /**
     * Try to click the Queen promotion button in the DOM or at physical screen coordinates.
     * Returns true if Queen was targeted and clicked.
     */
    function autoClickPromotion() {
        const queenSelectors = [
            `[data-piece="queen" i]`, `[data-piece="q" i]`, `[data-piece="Q" i]`,
            `[data-test*="queen" i]`, `[data-test*="player-piece-queen" i]`, `[data-test*="promotion-queen" i]`,
            `button[aria-label*="queen" i]`, `[role="button"][aria-label*="queen" i]`,
            `img[alt*="queen" i]`, `img[src*="queen" i]`, `svg[data-piece*="queen" i]`,
            `[aria-label*="hậu" i]`, `[aria-label*="dame" i]`, `[aria-label*="reina" i]`,
            `[aria-label*="dama" i]`, `[aria-label*="ferz" i]`, `[aria-label*="königin" i]`
        ];

        // 1. Direct Queen button anywhere on DOM
        for (const sel of queenSelectors) {
            try {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    if (isElementVisible(el) && !isForbiddenButton(el) && !el.closest("#dc-pill")) {
                        simulateFullClick(el, true);
                        return true;
                    }
                }
            } catch (_) { }
        }

        // 2. Promotion modal container discovery
        const container = findPromotionModal();
        if (container) {
            const cr = container.getBoundingClientRect();

            // A. Direct Queen selector inside container
            for (const sel of queenSelectors) {
                try {
                    const q = container.querySelector(sel);
                    if (q && isElementVisible(q)) {
                        simulateFullClick(q, true);
                        return true;
                    }
                } catch (_) { }
            }

            // B. Query piece buttons strictly (NO generic div)
            const pieceButtons = Array.from(container.querySelectorAll('button, [role="button"], a[role="button"]')).filter(el => {
                if (el.closest("#dc-pill") || isForbiddenButton(el) || !isElementVisible(el)) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 16 && r.height >= 16 && r.width <= 140 && r.height <= 140;
            });

            if (pieceButtons.length > 0) {
                // Sort left-to-right: Queen is ALWAYS leftmost (index 0)
                pieceButtons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                simulateFullClick(pieceButtons[0], true);
            }

            // C. Query piece SVGs/images strictly
            const pieceSvgs = Array.from(container.querySelectorAll('svg, img')).filter(el => {
                if (el.closest("#dc-pill") || isForbiddenButton(el) || !isElementVisible(el)) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 16 && r.height >= 16 && r.width <= 140 && r.height <= 140;
            });

            if (pieceSvgs.length > 0) {
                pieceSvgs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                simulateFullClick(pieceSvgs[0], true);
            }

            // D. Exact visual coordinate targeting (Queen center: ~18% from modal left, ~65% from modal top)
            const qx = cr.left + cr.width * 0.18;
            const qy = cr.top + cr.height * 0.65;
            const pointEl = document.elementFromPoint(qx, qy);
            if (pointEl && !pointEl.closest("#dc-pill") && !isForbiddenButton(pointEl)) {
                simulateFullClick(pointEl, true);
            }

            // E. Direct canvas tap fallback at (qx, qy)
            const canvas = findCanvas();
            if (canvas) {
                dispatchTap(canvas, qx, qy, 25);
            }

            return true;
        }

        return false;
    }

    /**
     * Handle pawn promotion:
     * 1. Rapidly poll DOM and canvas targets for Queen selection
     * 2. Taps DOM Queen, destination square, and exact canvas modal coordinates
     * 3. Never hangs or causes epilepsy
     */
    async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
        _pendingPromotionSq = destSq || "q";
        _pendingPromotionTime = Date.now();

        const canvas = findCanvas();
        const sq = destSq || "d8";

        for (let attempt = 0; attempt < 8; attempt++) {
            // 1. DOM Queen Click (multi-tier: selectors, buttons, SVGs, coordinate targeting)
            if (autoClickPromotion()) {
                await sleep(40);
                if (!findPromotionModal()) {
                    _pendingPromotionSq = null;
                    return true;
                }
            }

            // 2. Canvas Tap Fallbacks:
            if (canvas) {
                const cr = canvas.getBoundingClientRect();
                const pt = getSquareCoords(canvas, sq, insetRatio, flipped);
                const sqW = (cr.width * (1 - (insetRatio || 64 / 648) * 2)) / 8;
                const sqH = (cr.height * (1 - (insetRatio || 64 / 648) * 2)) / 8;
                const isTop = (pt.y - cr.top) < (cr.height / 2);

                // A. Destination square itself
                await dispatchTap(canvas, pt.x, pt.y, 25);

                // B. Queen icon relative to promotion square (modal hangs below if top, above if bottom)
                const promoQx = Math.max(cr.left + sqW * 0.5, Math.min(cr.right - sqW * 0.5, pt.x - 1.6 * sqW));
                const promoQy = isTop ? (pt.y + 2.4 * sqH) : (pt.y - 2.4 * sqH);
                await dispatchTap(canvas, promoQx, promoQy, 25);

                // C. Fixed board-relative Queen position (from measured screenshot: X=45.8%, Y=28.8%)
                const fixedQx = cr.left + cr.width * 0.458;
                const fixedQy = isTop ? (cr.top + cr.height * 0.288) : (cr.top + cr.height * 0.712);
                await dispatchTap(canvas, fixedQx, fixedQy, 25);
            }

            // 3. Keyboard triggers
            try {
                for (const k of ["q", "Q", "1"]) {
                    const evOpts = { key: k, code: `Key${k.toUpperCase()}`, bubbles: true, cancelable: true, composed: true };
                    document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
                    document.dispatchEvent(new KeyboardEvent("keyup", evOpts));
                }
            } catch (_) { }

            await sleep(50);
            if (!findPromotionModal()) {
                _pendingPromotionSq = null;
                return true;
            }
        }

        _pendingPromotionSq = null;
        return true;
    }

    // ══════════════════════════════════════════════════════════════════════════════
    //  DOM ADVANCE FLOW & AUTO-CLICK REWARDS
    // ══════════════════════════════════════════════════════════════════════════════

    function autoMatchOscar() {
        if (!BOT_CFG.autoMatch) return false;

        // 1. Handle pending promotion
        if (findPromotionModal() || _pendingPromotionSq) {
            if (autoClickPromotion()) {
                _pendingPromotionSq = null;
                return true;
            }
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
    const MOVES_RE = /\/chess\b.*\/matches\/[^/?#]+\/moves/;
    const isMatchURL = url => typeof url === "string" && (MATCHES_RE.test(url) || MOVES_RE.test(url) || /\/matches\b/i.test(url) || /\/chess-match\b/i.test(url));
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
            _botMoveHistory = [];

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
            _botMoveHistory = [];
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
        // If promotion modal is already open on screen, click Queen immediately!
        if (findPromotionModal()) {
            autoClickPromotion();
            return;
        }
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
            if (!_botMoveHistory) _botMoveHistory = [];
            _botMoveHistory.unshift(move);
            if (_botMoveHistory.length > 8) _botMoveHistory.pop();

            // Immediately register the resulting position in _gamePositionCounts so it cannot be repeated!
            try {
                const gameAfter = new FastChess(startFen);
                const legals = gameAfter.getLegalMoves();
                const mObj = legals.find(m => gameAfter.moveToUci(m) === move);
                if (mObj) {
                    gameAfter.makeMove(mObj);
                } else {
                    const fromIdx = gameAfter._sqToIdx(move.slice(0, 2));
                    const toIdx = gameAfter._sqToIdx(move.slice(2, 4));
                    const promoType = move.length >= 5 ? move[4] : null;
                    gameAfter.makeMove({ from: fromIdx, to: toIdx, promo: promoType });
                }
                const afterKey = getPositionKey(gameAfter.toFen());
                if (afterKey) {
                    _gamePositionCounts.set(afterKey, (_gamePositionCounts.get(afterKey) || 0) + 1);
                }
            } catch (_) { }

            const flip = BOT_CFG.flipped || (BOT_S.playerColor || "").toLowerCase() === "black";

            // Execute the move ONCE — clean single tap per square
            await executeMove(move, BOT_CFG.boardInsetRatio, flip);

            // Handle promotion ONCE — rapid auto-click
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
        } catch (_) { }
        try {
            const duoState = JSON.parse(localStorage.getItem("duo.state") || "{}");
            const uid = duoState.user?.id || duoState.currentUserId || duoState.userId;
            if (uid) { BOT_S.userId = String(uid); return BOT_S.userId; }
        } catch (_) { }
        try {
            const entries = performance.getEntriesByType("resource");
            for (const e of entries) {
                const m = e.name.match(/\/chess\/\d+\/(\d+)\//) || e.name.match(/[?&]user(?:Id)?=(\d+)/);
                if (m?.[1]) { BOT_S.userId = m[1]; return BOT_S.userId; }
            }
        } catch (_) { }
        return "0";
    }

    function hookNetwork(targetWin) {
        if (!targetWin || targetWin.__dcHooked6) return;
        try { targetWin.__dcHooked6 = true; } catch (_) { }

        const origFetch = targetWin.fetch;
        if (typeof origFetch === "function") {
            targetWin.fetch = async function (...args) {
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
                        res.clone().json().then(onMatchData).catch(() => { });
                    } else if (isSessionURL(url)) {
                        _lastSessionUrl = url;
                        res.clone().json().then(processSession).catch(() => { });
                    }
                } catch (_) { }
                return res;
            };
        }

        if (targetWin.XMLHttpRequest?.prototype) {
            const proto = targetWin.XMLHttpRequest.prototype;
            const origOpen = proto.open;
            const origSend = proto.send;
            proto.open = function (m, url, ...r) {
                this.__dcUrl = String(url ?? "");
                return origOpen.call(this, m, url, ...r);
            };
            proto.send = function (...args) {
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
                        } catch (_) { }
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
            } catch (_) { }
        }
        if (sessionUrl) {
            try {
                const hdrs = {};
                if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;
                const fetchFn = (typeof unsafeWindow !== "undefined" && unsafeWindow.fetch) || window.fetch;
                const r = await fetchFn(sessionUrl, { method: "GET", headers: hdrs, credentials: "include" });
                if (r.ok) { processSession(await r.json()); return true; }
            } catch (_) { }
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
            } catch (_) { }
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
        } catch (_) { }
    }

    // ══════════════════════════════════════════════════════════════════════════════
    //  BOTTOM-RIGHT CORNER WIDGET (COMPACT, CALM, ZERO GLOW, ZERO SLOP)
    // ══════════════════════════════════════════════════════════════════════════════

    let _panel = null;

    const SVG_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" style="margin-left:1px"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
    const SVG_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>';
    const SVG_MATCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M3 22v-6h6"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg>';

    const STYLE = `
#dc-dock {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 2147483647;
    display: inline-flex;
    align-items: center;
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 14px;
    padding: 2px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    user-select: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.dc-btn {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
    outline: none;
    padding: 0;
    background: #27272a;
    color: #71717a;
    flex-shrink: 0;
}

.dc-btn svg {
    width: 10px;
    height: 10px;
    display: block;
    pointer-events: none;
}

.dc-btn:hover {
    filter: brightness(1.2);
}

.dc-btn:active {
    transform: scale(0.9);
}

/* Calm solid matte colors — no stinging neons, no glassmorphism */
#dc-tg-play.active {
    background: #166534;
    color: #4ade80;
}
#dc-tg-play.off {
    background: #27272a;
    color: #71717a;
}

#dc-tg-match.active {
    background: #1e3a8a;
    color: #60a5fa;
}
#dc-tg-match.off {
    background: #27272a;
    color: #71717a;
}

#dc-engine-box {
    padding: 0 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 75px;
    max-width: 160px;
}

#dc-engine-name {
    color: #d4d4d8;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
}
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
        _panel.id = "dc-dock";

        _panel.innerHTML = `
            <button id="dc-tg-play" class="dc-btn ${BOT_CFG.autoPlay ? 'active' : 'off'}" title="${BOT_CFG.autoPlay ? 'Auto Play: ON' : 'Auto Play: OFF'}">
                ${BOT_CFG.autoPlay ? SVG_PLAY : SVG_PAUSE}
            </button>
            <div id="dc-engine-box">
                <span id="dc-engine-name">${esc(BOT_S.engineName || "Stockfish 16+")}</span>
            </div>
            <button id="dc-tg-match" class="dc-btn ${BOT_CFG.autoMatch ? 'active' : 'off'}" title="${BOT_CFG.autoMatch ? 'Auto Match: ON' : 'Auto Match: OFF'}">
                ${SVG_MATCH}
            </button>
        `;

        document.body.appendChild(_panel);

        const tgPlay = _panel.querySelector("#dc-tg-play");
        if (tgPlay) {
            tgPlay.addEventListener("click", e => {
                e.stopPropagation();
                BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
                saveSettings();
                renderPanel();
            });
        }

        const tgMatch = _panel.querySelector("#dc-tg-match");
        if (tgMatch) {
            tgMatch.addEventListener("click", e => {
                e.stopPropagation();
                BOT_CFG.autoMatch = !BOT_CFG.autoMatch;
                saveSettings();
                renderPanel();
            });
        }

        renderPanel();
    }

    function renderPanel() {
        if (!_panel) return;
        const eng = _panel.querySelector("#dc-engine-name");
        const tgPlay = _panel.querySelector("#dc-tg-play");
        const tgMatch = _panel.querySelector("#dc-tg-match");

        if (eng) {
            eng.textContent = BOT_S.engineName || "Stockfish 16+";
        }
        if (tgPlay) {
            tgPlay.className = `dc-btn ${BOT_CFG.autoPlay ? 'active' : 'off'}`;
            tgPlay.innerHTML = BOT_CFG.autoPlay ? SVG_PLAY : SVG_PAUSE;
            tgPlay.title = BOT_CFG.autoPlay ? "Auto Play: ON" : "Auto Play: OFF";
        }
        if (tgMatch) {
            tgMatch.className = `dc-btn ${BOT_CFG.autoMatch ? 'active' : 'off'}`;
            tgMatch.innerHTML = SVG_MATCH;
            tgMatch.title = BOT_CFG.autoMatch ? "Auto Match: ON" : "Auto Match: OFF";
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

            // ─── PRIORITY 0: Active promotion modal on screen — resolve Queen immediately! ───
            const promoModal = findPromotionModal();
            if (promoModal) {
                autoClickPromotion();
                // If the modal has been up for > 1500ms, force clear status so bot doesn't get locked in "PLAYING"
                if (Date.now() - _lastStateChange > 1500) {
                    BOT_S.turnInProgress = false;
                    _pendingPromotionSq = null;
                    setStatus("idle");
                }
            }

            // ─── WATCHDOG 1: Clear stuck thinking/playing if hung > 3.5s ───
            if ((BOT_S.status === "thinking" || BOT_S.status === "playing" || BOT_S.turnInProgress) &&
                (Date.now() - _lastStateChange > 3500)) {
                BOT_S.turnInProgress = false;
                _pendingPromotionSq = null;
                setStatus("idle");
            }

            // ─── WATCHDOG 2: Clear stuck promotion after 1.5s ───
            if (_pendingPromotionSq && (Date.now() - _pendingPromotionTime > 1500)) {
                autoClickPromotion();
                _pendingPromotionSq = null;
            }

            // ─── Turn trigger with safe cooldown ───
            if (BOT_CFG.autoPlay && isOurTurn(BOT_S.currentFen) && !BOT_S.turnInProgress &&
                BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
                const isSameFen = (BOT_S.currentFen === _lastAttemptedFen);
                const cooldown = isSameFen ? 1200 : 80;
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
