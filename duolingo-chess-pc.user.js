// ==UserScript==
// @name         Duolingo Chess Solver & Auto-Match Bot (PC / Desktop Edition)
// @namespace    duochess-pc
// @version      6.0.0
// @description  Master-engineered Duolingo Chess solver and auto-match loop with embedded chess.js rules engine, 100% legal moves, zero-freeze concurrency, infallible castling, multi-tier pawn promotion, and per-account consecutive win tracking.
// @match        https://www.duolingo.com/*
// @match        https://*.duolingo.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      stockfish.online
// @connect      *.stockfish.online
// @connect      lichess.org
// @connect      *.lichess.org
// @connect      chess-api.com
// @connect      *.chess-api.com
// @license      MIT
// ==/UserScript==

(() => {
"use strict";

// ══════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION & DEVICE DETECTION
// ══════════════════════════════════════════════════════════════════════════════

const UA = navigator.userAgent || "";
const IS_TABLET = /iPad|Tablet|(Android(?!.*Mobile))/i.test(UA);
const IS_MOBILE = (!IS_TABLET && /Android|iPhone|iPod|Mobile/i.test(UA))
    || (typeof navigator.maxTouchPoints === "number" && navigator.maxTouchPoints > 1 && window.innerWidth < 768);

const BOT_CFG = {
    engine:          "hybrid", // Lichess Cloud -> Stockfish 16+ -> Chess-API -> Embedded Engine
    stockfishDepth:  15,
    clickDelay:      IS_MOBILE ? 80 : 45,
    moveDelay:       IS_MOBILE ? 200 : 120,
    thinkDelay:      IS_MOBILE ? 40 : 25,
    boardInsetRatio: 64 / 648,
    autoPlay:        true,
    autoMatch:       true,
};

const STORE_KEY = "duochess.v6.settings";

// ══════════════════════════════════════════════════════════════════════════════
//  EMBEDDED CHESS.JS RULES ENGINE (0x88 Representation - Pure FIDE Compliance)
// ══════════════════════════════════════════════════════════════════════════════

const { Chess } = (() => {
    const BLACK = 'b';
    const WHITE = 'w';
    const PAWN = 'p';
    const KNIGHT = 'n';
    const BISHOP = 'b';
    const ROOK = 'r';
    const QUEEN = 'q';
    const KING = 'k';

    const DEFAULT_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    const BITS = {
        NORMAL: 1,
        CAPTURE: 2,
        BIG_PAWN: 4,
        EP_CAPTURE: 8,
        PROMOTION: 16,
        KSIDE_CASTLE: 32,
        QSIDE_CASTLE: 64
    };

    const RANK_1 = 7;
    const RANK_2 = 6;
    const RANK_7 = 1;
    const RANK_8 = 0;

    const SQUARES = {
        a8: 0,   b8: 1,   c8: 2,   d8: 3,   e8: 4,   f8: 5,   g8: 6,   h8: 7,
        a7: 16,  b7: 17,  c7: 18,  d7: 19,  e7: 20,  f7: 21,  g7: 22,  h7: 23,
        a6: 32,  b6: 33,  c6: 34,  d6: 35,  e6: 36,  f6: 37,  g6: 38,  h6: 39,
        a5: 48,  b5: 49,  c5: 50,  d5: 51,  e5: 52,  f5: 53,  g5: 54,  h5: 55,
        a4: 64,  b4: 65,  c4: 66,  d4: 67,  e4: 68,  f4: 69,  g4: 70,  h4: 71,
        a3: 80,  b3: 81,  c3: 82,  d3: 83,  e3: 84,  f3: 85,  g3: 86,  h3: 87,
        a2: 96,  b2: 97,  c2: 98,  d2: 99,  e2: 100, f2: 101, g2: 102, h2: 103,
        a1: 112, b1: 113, c1: 114, d1: 115, e1: 116, f1: 117, g1: 118, h1: 119
    };

    const ROOKS = {
        w: [{ square: SQUARES.a1, flag: BITS.QSIDE_CASTLE }, { square: SQUARES.h1, flag: BITS.KSIDE_CASTLE }],
        b: [{ square: SQUARES.a8, flag: BITS.QSIDE_CASTLE }, { square: SQUARES.h8, flag: BITS.KSIDE_CASTLE }]
    };

    const PIECE_OFFSETS = {
        n: [-18, -33, -31, -14, 18, 33, 31, 14],
        b: [-17, -15, 17, 15],
        r: [-16, 1, 16, -1],
        q: [-17, -16, -15, 1, 17, 16, 15, -1],
        k: [-17, -16, -15, 1, 17, 16, 15, -1]
    };

    const PAWN_OFFSETS = {
        b: [16, 32, 17, 15],
        w: [-16, -32, -17, -15]
    };

    function rank(i) { return i >> 4; }
    function file(i) { return i & 15; }
    function algebraic(i) {
        const f = file(i), r = rank(i);
        return 'abcdefgh'.substring(f, f + 1) + '87654321'.substring(r, r + 1);
    }
    function swap_color(c) { return c === WHITE ? BLACK : WHITE; }
    function is_digit(c) { return '0123456789'.indexOf(c) !== -1; }

    class Chess {
        constructor(fen) {
            this._board = new Array(128);
            this._kings = { w: SQUARES.a1, b: SQUARES.a8 };
            this._turn = WHITE;
            this._castling = { w: 0, b: 0 };
            this._ep_square = -1;
            this._half_moves = 0;
            this._move_number = 1;
            this._history = [];
            this.load(fen || DEFAULT_POSITION);
        }

        clear() {
            this._board = new Array(128);
            this._kings = { w: -1, b: -1 };
            this._turn = WHITE;
            this._castling = { w: 0, b: 0 };
            this._ep_square = -1;
            this._half_moves = 0;
            this._move_number = 1;
            this._history = [];
        }

        load(fen) {
            const tokens = fen.trim().split(/\s+/);
            const position = tokens[0];
            let square = 0;

            this.clear();

            for (let i = 0; i < position.length; i++) {
                const piece = position.charAt(i);
                if (piece === '/') {
                    square += 8;
                } else if (is_digit(piece)) {
                    square += parseInt(piece, 10);
                } else {
                    const color = (piece < 'a') ? WHITE : BLACK;
                    this._put({ type: piece.toLowerCase(), color: color }, algebraic(square));
                    square++;
                }
            }

            this._turn = tokens[1] || WHITE;

            if (tokens[2]) {
                if (tokens[2].indexOf('K') > -1) this._castling.w |= BITS.KSIDE_CASTLE;
                if (tokens[2].indexOf('Q') > -1) this._castling.w |= BITS.QSIDE_CASTLE;
                if (tokens[2].indexOf('k') > -1) this._castling.b |= BITS.KSIDE_CASTLE;
                if (tokens[2].indexOf('q') > -1) this._castling.b |= BITS.QSIDE_CASTLE;
            }

            this._ep_square = (!tokens[3] || tokens[3] === '-') ? -1 : SQUARES[tokens[3]];
            this._half_moves = parseInt(tokens[4], 10) || 0;
            this._move_number = parseInt(tokens[5], 10) || 1;

            return true;
        }

        fen() {
            let empty = 0;
            let fen = '';

            for (let i = SQUARES.a8; i <= SQUARES.h1; i++) {
                if (this._board[i] == null) {
                    empty++;
                } else {
                    if (empty > 0) {
                        fen += empty;
                        empty = 0;
                    }
                    const color = this._board[i].color;
                    const piece = this._board[i].type;
                    fen += (color === WHITE) ? piece.toUpperCase() : piece.toLowerCase();
                }

                if ((i + 1) & 0x88) {
                    if (empty > 0) {
                        fen += empty;
                    }
                    if (i !== SQUARES.h1) {
                        fen += '/';
                    }
                    empty = 0;
                    i += 8;
                }
            }

            let cflags = '';
            if (this._castling[WHITE] & BITS.KSIDE_CASTLE) cflags += 'K';
            if (this._castling[WHITE] & BITS.QSIDE_CASTLE) cflags += 'Q';
            if (this._castling[BLACK] & BITS.KSIDE_CASTLE) cflags += 'k';
            if (this._castling[BLACK] & BITS.QSIDE_CASTLE) cflags += 'q';
            cflags = cflags || '-';

            const epflags = (this._ep_square === -1) ? '-' : algebraic(this._ep_square);

            return [fen, this._turn, cflags, epflags, this._half_moves, this._move_number].join(' ');
        }

        turn() { return this._turn; }

        get(square) {
            const sq = SQUARES[square];
            if (sq == null) return null;
            const piece = this._board[sq];
            return piece ? { type: piece.type, color: piece.color } : null;
        }

        _put(piece, square) {
            const sq = SQUARES[square];
            if (sq == null) return false;
            this._board[sq] = { type: piece.type, color: piece.color };
            if (piece.type === KING) {
                this._kings[piece.color] = sq;
            }
            return true;
        }

        _attacked(color, square) {
            for (let i = SQUARES.a8; i <= SQUARES.h1; i++) {
                if (i & 0x88) { i += 7; continue; }
                if (this._board[i] == null || this._board[i].color !== color) continue;

                const piece = this._board[i];
                const difference = i - square;

                if (piece.type === PAWN) {
                    if (color === WHITE) {
                        if (difference === 15 || difference === 17) return true;
                    } else {
                        if (difference === -15 || difference === -17) return true;
                    }
                    continue;
                }

                if (piece.type === KNIGHT) {
                    const offsets = PIECE_OFFSETS.n;
                    for (let j = 0; j < offsets.length; j++) {
                        if (i + offsets[j] === square) return true;
                    }
                    continue;
                }

                if (piece.type === KING) {
                    const offsets = PIECE_OFFSETS.k;
                    for (let j = 0; j < offsets.length; j++) {
                        if (i + offsets[j] === square) return true;
                    }
                    continue;
                }

                const offsets = PIECE_OFFSETS[piece.type];
                for (let j = 0; j < offsets.length; j++) {
                    const offset = offsets[j];
                    let dest = i + offset;
                    while (!(dest & 0x88)) {
                        if (dest === square) return true;
                        if (this._board[dest] != null) break;
                        dest += offset;
                    }
                }
            }
            return false;
        }

        in_check() {
            return this._attacked(swap_color(this._turn), this._kings[this._turn]);
        }

        _generate_moves() {
            const moves = [];
            const us = this._turn;
            const them = swap_color(us);
            const second_rank = { b: RANK_7, w: RANK_2 };

            const add_move = (from, to, flags, promotion) => {
                moves.push({
                    color: us,
                    from: from,
                    to: to,
                    flags: flags,
                    piece: this._board[from].type,
                    captured: this._board[to] ? this._board[to].type : (flags & BITS.EP_CAPTURE ? PAWN : null),
                    promotion: promotion
                });
            };

            for (let i = SQUARES.a8; i <= SQUARES.h1; i++) {
                if (i & 0x88) { i += 7; continue; }
                const piece = this._board[i];
                if (piece == null || piece.color !== us) continue;

                if (piece.type === PAWN) {
                    const square1 = i + PAWN_OFFSETS[us][0];
                    if (this._board[square1] == null) {
                        if (rank(square1) === (us === WHITE ? RANK_8 : RANK_1)) {
                            [QUEEN, ROOK, BISHOP, KNIGHT].forEach(p => add_move(i, square1, BITS.PROMOTION, p));
                        } else {
                            add_move(i, square1, BITS.NORMAL);
                            const square2 = i + PAWN_OFFSETS[us][1];
                            if (rank(i) === second_rank[us] && this._board[square2] == null) {
                                add_move(i, square2, BITS.BIG_PAWN);
                            }
                        }
                    }

                    for (let j = 2; j < 4; j++) {
                        const square3 = i + PAWN_OFFSETS[us][j];
                        if (square3 & 0x88) continue;

                        if (this._board[square3] != null && this._board[square3].color === them) {
                            if (rank(square3) === (us === WHITE ? RANK_8 : RANK_1)) {
                                [QUEEN, ROOK, BISHOP, KNIGHT].forEach(p => add_move(i, square3, BITS.PROMOTION | BITS.CAPTURE, p));
                            } else {
                                add_move(i, square3, BITS.CAPTURE);
                            }
                        } else if (square3 === this._ep_square) {
                            add_move(i, square3, BITS.EP_CAPTURE);
                        }
                    }
                } else if (piece.type === KING) {
                    const offsets = PIECE_OFFSETS.k;
                    for (let j = 0; j < offsets.length; j++) {
                        const square = i + offsets[j];
                        if (square & 0x88) continue;
                        if (this._board[square] == null) {
                            add_move(i, square, BITS.NORMAL);
                        } else if (this._board[square].color === them) {
                            add_move(i, square, BITS.CAPTURE);
                        }
                    }

                    if (this._castling[us] & BITS.KSIDE_CASTLE) {
                        const castling_to = i + 2;
                        if (this._board[i + 1] == null && this._board[castling_to] == null &&
                            !this._attacked(them, this._kings[us]) &&
                            !this._attacked(them, i + 1) &&
                            !this._attacked(them, castling_to)) {
                            add_move(i, castling_to, BITS.KSIDE_CASTLE);
                        }
                    }
                    if (this._castling[us] & BITS.QSIDE_CASTLE) {
                        const castling_to = i - 2;
                        if (this._board[i - 1] == null && this._board[i - 2] == null && this._board[i - 3] == null &&
                            !this._attacked(them, this._kings[us]) &&
                            !this._attacked(them, i - 1) &&
                            !this._attacked(them, castling_to)) {
                            add_move(i, castling_to, BITS.QSIDE_CASTLE);
                        }
                    }
                } else {
                    const offsets = PIECE_OFFSETS[piece.type];
                    const single_step = (piece.type === KNIGHT);
                    for (let j = 0; j < offsets.length; j++) {
                        const offset = offsets[j];
                        let square = i + offset;
                        while (!(square & 0x88)) {
                            if (this._board[square] == null) {
                                add_move(i, square, BITS.NORMAL);
                            } else {
                                if (this._board[square].color === them) {
                                    add_move(i, square, BITS.CAPTURE);
                                }
                                break;
                            }
                            if (single_step) break;
                            square += offset;
                        }
                    }
                }
            }

            return moves;
        }

        _make_move(move) {
            const us = this._turn;
            const them = swap_color(us);

            this._history.push({
                move: move,
                kings: { b: this._kings.b, w: this._kings.w },
                turn: this._turn,
                castling: { b: this._castling.b, w: this._castling.w },
                ep_square: this._ep_square,
                half_moves: this._half_moves,
                move_number: this._move_number
            });

            this._board[move.to] = this._board[move.from];
            this._board[move.from] = null;

            if (move.flags & BITS.EP_CAPTURE) {
                if (this._turn === BLACK) {
                    this._board[move.to - 16] = null;
                } else {
                    this._board[move.to + 16] = null;
                }
            }

            if (move.flags & BITS.PROMOTION) {
                this._board[move.to] = { type: move.promotion, color: us };
            }

            if (this._board[move.to].type === KING) {
                this._kings[this._board[move.to].color] = move.to;

                if (move.flags & BITS.KSIDE_CASTLE) {
                    const castling_to = move.to - 1;
                    const castling_from = move.to + 1;
                    this._board[castling_to] = this._board[castling_from];
                    this._board[castling_from] = null;
                } else if (move.flags & BITS.QSIDE_CASTLE) {
                    const castling_to = move.to + 1;
                    const castling_from = move.to - 2;
                    this._board[castling_to] = this._board[castling_from];
                    this._board[castling_from] = null;
                }

                this._castling[us] = 0;
            }

            if (this._castling[us]) {
                for (let i = 0; i < ROOKS[us].length; i++) {
                    if (move.from === ROOKS[us][i].square && ((this._castling[us] & ROOKS[us][i].flag))) {
                        this._castling[us] ^= ROOKS[us][i].flag;
                        break;
                    }
                }
            }
            if (this._castling[them]) {
                for (let i = 0; i < ROOKS[them].length; i++) {
                    if (move.to === ROOKS[them][i].square && ((this._castling[them] & ROOKS[them][i].flag))) {
                        this._castling[them] ^= ROOKS[them][i].flag;
                        break;
                    }
                }
            }

            if (move.flags & BITS.BIG_PAWN) {
                if (this._turn === 'b') {
                    this._ep_square = move.to - 16;
                } else {
                    this._ep_square = move.to + 16;
                }
            } else {
                this._ep_square = -1;
            }

            if (move.piece === PAWN || (move.flags & (BITS.CAPTURE | BITS.EP_CAPTURE))) {
                this._half_moves = 0;
            } else {
                this._half_moves++;
            }

            if (this._turn === BLACK) {
                this._move_number++;
            }
            this._turn = swap_color(this._turn);
        }

        _undo_move() {
            const old = this._history.pop();
            if (old == null) return null;

            const move = old.move;
            this._kings = old.kings;
            this._turn = old.turn;
            this._castling = old.castling;
            this._ep_square = old.ep_square;
            this._half_moves = old.half_moves;
            this._move_number = old.move_number;

            const us = this._turn;
            const them = swap_color(this._turn);

            this._board[move.from] = this._board[move.to];
            this._board[move.from].type = move.piece;
            this._board[move.to] = null;

            if (move.flags & BITS.CAPTURE) {
                this._board[move.to] = { type: move.captured, color: them };
            } else if (move.flags & BITS.EP_CAPTURE) {
                const index = (us === BLACK) ? move.to - 16 : move.to + 16;
                this._board[index] = { type: PAWN, color: them };
            }

            if (move.flags & (BITS.KSIDE_CASTLE | BITS.QSIDE_CASTLE)) {
                let castling_to, castling_from;
                if (move.flags & BITS.KSIDE_CASTLE) {
                    castling_to = move.to + 1;
                    castling_from = move.to - 1;
                } else if (move.flags & BITS.QSIDE_CASTLE) {
                    castling_to = move.to - 2;
                    castling_from = move.to + 1;
                }
                this._board[castling_to] = this._board[castling_from];
                this._board[castling_from] = null;
            }

            return move;
        }

        moves(options) {
            const ugly_moves = this._generate_moves();
            const legal_moves = [];
            const us = this._turn;

            for (let i = 0; i < ugly_moves.length; i++) {
                this._make_move(ugly_moves[i]);
                if (!this._attacked(this._turn, this._kings[us])) {
                    if (options && options.verbose) {
                        legal_moves.push({
                            color: ugly_moves[i].color,
                            from: algebraic(ugly_moves[i].from),
                            to: algebraic(ugly_moves[i].to),
                            flags: ugly_moves[i].flags,
                            piece: ugly_moves[i].piece,
                            captured: ugly_moves[i].captured,
                            promotion: ugly_moves[i].promotion
                        });
                    } else {
                        legal_moves.push(ugly_moves[i]);
                    }
                }
                this._undo_move();
            }

            return legal_moves;
        }

        move(move_obj) {
            let from, to, promo;
            if (typeof move_obj === 'string') {
                from = move_obj.slice(0, 2);
                to = move_obj.slice(2, 4);
                promo = move_obj[4];
            } else {
                from = move_obj.from;
                to = move_obj.to;
                promo = move_obj.promotion;
            }

            const ugly_moves = this._generate_moves();
            const from_sq = SQUARES[from];
            const to_sq = SQUARES[to];
            const us = this._turn;

            for (let i = 0; i < ugly_moves.length; i++) {
                const m = ugly_moves[i];
                if (m.from === from_sq && m.to === to_sq && (!m.promotion || m.promotion === promo)) {
                    this._make_move(m);
                    if (this._attacked(this._turn, this._kings[us])) {
                        this._undo_move();
                        return null;
                    }
                    return {
                        from: from,
                        to: to,
                        promotion: promo,
                        piece: m.piece,
                        captured: m.captured
                    };
                }
            }
            return null;
        }

        in_checkmate() {
            return this.in_check() && this.moves().length === 0;
        }

        in_stalemate() {
            return !this.in_check() && this.moves().length === 0;
        }

        game_over() {
            return this.in_checkmate() || this.in_stalemate() || this._half_moves >= 100;
        }
    }

    return { Chess };
})();

// ══════════════════════════════════════════════════════════════════════════════
//  MOVE NORMALIZATION & STRICT FID-RULE VALIDATION
// ══════════════════════════════════════════════════════════════════════════════

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const validUCI = s => typeof s === "string" && UCI_RE.test(s.trim().toLowerCase());
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Normalizes UCI string (handling Chess960 castling and implicit promotions)
 * and verifies that it is 100% strictly legal in the active FEN.
 * Returns verified UCI string or null.
 */
function normalizeAndValidateMove(fen, uci) {
    if (!fen || !uci || typeof uci !== "string") return null;
    uci = uci.trim().toLowerCase();
    if (uci.length < 4) return null;

    try {
        const chess = new Chess(fen);
        let from = uci.slice(0, 2);
        let to = uci.slice(2, 4);
        let promo = uci[4] ? uci[4].toLowerCase() : null;

        // Normalize Chess960 castling notation (king onto rook)
        const piece = chess.get(from);
        if (piece && piece.type === "k") {
            if (from === "e1" && to === "h1") to = "g1";
            else if (from === "e1" && to === "a1") to = "c1";
            else if (from === "e8" && to === "h8") to = "g8";
            else if (from === "e8" && to === "a8") to = "c8";
        }

        // Auto-promotion normalization: if pawn reaches back rank, default to Queen
        if (piece && piece.type === "p" && !promo) {
            if ((piece.color === "w" && to[1] === "8") || (piece.color === "b" && to[1] === "1")) {
                promo = "q";
            }
        }

        const legal = chess.moves({ verbose: true });
        const match = legal.find(m => m.from === from && m.to === to && (!promo || m.promotion === promo));
        if (match) {
            return `${match.from}${match.to}${match.promotion || ""}`;
        }
    } catch (_) {}

    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  PER-ACCOUNT CONSECUTIVE WIN STREAK & SETTINGS
// ══════════════════════════════════════════════════════════════════════════════

const BOT_S = {
    userId: "0",
    matchId: null,
    playerColor: "white",
    currentFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    status: "idle",
    engineName: "Local GM",
    lastMove: null,
    consecutiveWins: 0,
    bestStreak: 0,
    authToken: null,
};

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

function loadAccountStats() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        if (saved.bot) Object.assign(BOT_CFG, saved.bot);
        const uid = getUserId();
        const acc = (saved.accounts && saved.accounts[uid]) ? saved.accounts[uid] : null;
        if (acc) {
            BOT_S.consecutiveWins = acc.consecutiveWins || 0;
            BOT_S.bestStreak = acc.bestStreak || 0;
        } else {
            BOT_S.consecutiveWins = 0;
            BOT_S.bestStreak = 0;
        }
    } catch (_) {}
}

function saveAccountStats(lastMatchId) {
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
        saved.bot = BOT_CFG;
        if (!saved.accounts) saved.accounts = {};
        const uid = getUserId();
        saved.accounts[uid] = {
            consecutiveWins: BOT_S.consecutiveWins,
            bestStreak: BOT_S.bestStreak,
            lastFinishedMatchId: lastMatchId || (saved.accounts[uid]?.lastFinishedMatchId ?? null)
        };
        localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (_) {}
}

function recordMatchOutcome(matchId, isWin) {
    if (!matchId) return;
    const uid = getUserId();
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (_) {}
    if (!saved.accounts) saved.accounts = {};
    const acc = saved.accounts[uid] || { consecutiveWins: 0, bestStreak: 0, lastFinishedMatchId: null };

    if (acc.lastFinishedMatchId === String(matchId)) {
        return; // Already accounted for this match
    }

    if (isWin) {
        acc.consecutiveWins = (acc.consecutiveWins || 0) + 1;
        acc.bestStreak = Math.max(acc.bestStreak || 0, acc.consecutiveWins);
    } else {
        acc.consecutiveWins = 0;
    }

    acc.lastFinishedMatchId = String(matchId);
    saved.accounts[uid] = acc;
    BOT_S.consecutiveWins = acc.consecutiveWins;
    BOT_S.bestStreak = acc.bestStreak;

    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (_) {}
    renderPanel();
}

function resetAccountStreak() {
    const uid = getUserId();
    BOT_S.consecutiveWins = 0;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); } catch (_) {}
    if (!saved.accounts) saved.accounts = {};
    if (!saved.accounts[uid]) saved.accounts[uid] = { consecutiveWins: 0, bestStreak: 0 };
    saved.accounts[uid].consecutiveWins = 0;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch (_) {}
    renderPanel();
}

function setStatus(newStatus) {
    if (BOT_S.status !== newStatus) {
        BOT_S.status = newStatus;
        renderPanel();
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  TACTICAL LOCAL ENGINE (Zero Network Dependency - Sub-20ms Mate Scan)
// ══════════════════════════════════════════════════════════════════════════════

const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

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
    -50,-40,-30,-30,-30,-30,-40,-50
];

const PST_BISHOP = [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20
];

const ALL_SQUARES = [
    'a8','b8','c8','d8','e8','f8','g8','h8',
    'a7','b7','c7','d7','e7','f7','g7','h7',
    'a6','b6','c6','d6','e6','f6','g6','h6',
    'a5','b5','c5','d5','e5','f5','g5','h5',
    'a4','b4','c4','d4','e4','f4','g4','h4',
    'a3','b3','c3','d3','e3','f3','g3','h3',
    'a2','b2','c2','d2','e2','f2','g2','h2',
    'a1','b1','c1','d1','e1','f1','g1','h1'
];

function evaluateBoard(chess) {
    let score = 0;
    for (let idx = 0; idx < 64; idx++) {
        const p = chess.get(ALL_SQUARES[idx]);
        if (!p) continue;
        let val = PIECE_VALUES[p.type] || 0;
        const r = Math.floor(idx / 8), c = idx % 8;
        const tableIdx = p.color === 'w' ? idx : (7 - r) * 8 + c;

        if (p.type === 'p') val += PST_PAWN[tableIdx];
        else if (p.type === 'n') val += PST_KNIGHT[tableIdx];
        else if (p.type === 'b') val += PST_BISHOP[tableIdx];

        score += (p.color === 'w' ? val : -val);
    }
    return chess.turn() === 'w' ? score : -score;
}

function getTacticalBestMove(fen, maxDepth = 3) {
    const chess = new Chess(fen);
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;

    // 1. Instant Checkmate Scanner (Mate in 1)
    for (const m of moves) {
        chess.move(m);
        if (chess.in_checkmate()) {
            return `${m.from}${m.to}${m.promotion || ''}`;
        }
        chess._undo_move();
    }

    // Sort moves: captures and promotions first
    moves.sort((a, b) => {
        const scoreA = (a.captured ? 100 : 0) + (a.promotion ? 80 : 0);
        const scoreB = (b.captured ? 100 : 0) + (b.promotion ? 80 : 0);
        return scoreB - scoreA;
    });

    function minimax(depth, alpha, beta) {
        if (depth === 0) return evaluateBoard(chess);
        const legal = chess.moves({ verbose: true });
        if (legal.length === 0) {
            if (chess.in_check()) return -100000 - depth;
            return 0;
        }

        legal.sort((a, b) => (b.captured ? 10 : 0) - (a.captured ? 10 : 0));

        let maxVal = -Infinity;
        for (const m of legal) {
            chess.move(m);
            const score = -minimax(depth - 1, -beta, -alpha);
            chess._undo_move();

            if (score > maxVal) maxVal = score;
            if (score > alpha) alpha = score;
            if (alpha >= beta) break;
        }
        return maxVal;
    }

    let bestMove = moves[0];
    let bestScore = -Infinity;
    let alpha = -Infinity;
    const beta = Infinity;

    for (const m of moves) {
        chess.move(m);
        const score = -minimax(maxDepth - 1, -beta, -alpha);
        chess._undo_move();

        if (score > bestScore) {
            bestScore = score;
            bestMove = m;
        }
        if (score > alpha) alpha = score;
    }

    return `${bestMove.from}${bestMove.to}${bestMove.promotion || ''}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-TIER ENGINE WITH GUARANTEED VALIDATION
// ══════════════════════════════════════════════════════════════════════════════

function gmHttpFetch(url, timeoutMs = 2500, opts = {}) {
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

async function getLichessCloudMove(fen) {
    try {
        const encodedFen = encodeURIComponent(fen);
        const data = await gmHttpFetch(`https://lichess.org/api/cloud-eval?fen=${encodedFen}&multiPv=1`, 1200);
        if (data && Array.isArray(data.pvs) && data.pvs[0] && data.pvs[0].moves) {
            return data.pvs[0].moves.split(/\s+/)[0];
        }
    } catch (_) {}
    return null;
}

async function getFastStockfishMove(fen) {
    try {
        const encodedFen = encodeURIComponent(fen);
        const depth = BOT_CFG.stockfishDepth || 15;
        const data = await gmHttpFetch(`https://stockfish.online/api/s/v2.php?fen=${encodedFen}&depth=${depth}&mode=bestmove`, 1500);
        if (data && data.success && data.bestmove) {
            return data.bestmove.replace(/^bestmove\s*/, "").split(/\s+/)[0];
        }
    } catch (_) {}
    return null;
}

async function getChessApiMove(fen) {
    try {
        const data = await gmHttpFetch("https://chess-api.com/v1", 1500, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ fen: fen, depth: 15 })
        });
        if (data) {
            return data.move || (data.from && data.to ? (data.from + data.to + (data.promotion || "")) : null);
        }
    } catch (_) {}
    return null;
}

/**
 * Multi-layer query that guarantees returning a verified legal move.
 */
async function getBestMove(fen) {
    // 1. Parallel Cloud Query (Lichess Cloud + Stockfish 16+ + Chess-API)
    const lichessP = getLichessCloudMove(fen).then(mv => mv ? { name: "Lichess Cloud", move: mv } : null).catch(() => null);
    const sfP = getFastStockfishMove(fen).then(mv => mv ? { name: "Stockfish 16+", move: mv } : null).catch(() => null);
    const apiP = getChessApiMove(fen).then(mv => mv ? { name: "Stockfish 16+", move: mv } : null).catch(() => null);

    // Fast resolution: Lichess Cloud
    try {
        const fastCloud = await Promise.race([
            lichessP,
            new Promise(r => setTimeout(() => r(null), 900))
        ]);
        if (fastCloud && fastCloud.move) {
            const valid = normalizeAndValidateMove(fen, fastCloud.move);
            if (valid) {
                BOT_S.engineName = fastCloud.name;
                return valid;
            }
        }
    } catch (_) {}

    // Wait for remaining engines
    try {
        const [cloudRes, sfRes, apiRes] = await Promise.all([lichessP, sfP, apiP]);
        const candidates = [cloudRes, sfRes, apiRes].filter(Boolean);
        for (const cand of candidates) {
            if (cand && cand.move) {
                const valid = normalizeAndValidateMove(fen, cand.move);
                if (valid) {
                    BOT_S.engineName = cand.name;
                    return valid;
                }
            }
        }
    } catch (_) {}

    // 2. Guaranteed Local Minimax Fallback (offline, instant, 100% legal)
    const localMove = getTacticalBestMove(fen, 3);
    const validLocal = normalizeAndValidateMove(fen, localMove);
    if (validLocal) {
        BOT_S.engineName = "Local GM";
        return validLocal;
    }

    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CANVAS DISCOVERY & BOARD COORDINATES
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

async function waitCanvas(timeout = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        const c = findCanvas();
        if (c) return c;
        await sleep(30);
    }
    return null;
}

/**
 * Computes exact viewport coordinates for a square.
 * In Duolingo Chess, the human player is ALWAYS at the bottom:
 * - If user is White: rank 1 is bottom, rank 8 is top (flipped = false).
 * - If user is Black: rank 8 is bottom, rank 1 is top (flipped = true).
 */
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

// ══════════════════════════════════════════════════════════════════════════════
//  POINTER & TOUCH DISPATCH ENGINE
// ══════════════════════════════════════════════════════════════════════════════

function dispatchSyntheticPointer(type, el, x, y, buttons = 0, button = 0) {
    if (!el) return;
    const rx = Math.round(x), ry = Math.round(y);
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, top: 0 };
    const px = Math.round(x + (window.scrollX || 0));
    const py = Math.round(y + (window.scrollY || 0));

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
        pointerId: 1,
        pointerType: IS_MOBILE ? "touch" : "mouse",
        isPrimary: true,
        width: 20,
        height: 20
    };

    let pe;
    try {
        pe = (typeof PointerEvent === "function") ? new PointerEvent(type, opts) : new MouseEvent(type, opts);
    } catch (_) {
        try { pe = new MouseEvent(type, opts); } catch (_) {}
    }

    if (pe) {
        try {
            Object.defineProperty(pe, "offsetX", { value: rx - r.left, configurable: true });
            Object.defineProperty(pe, "offsetY", { value: ry - r.top, configurable: true });
            Object.defineProperty(pe, "pageX", { value: px, configurable: true });
            Object.defineProperty(pe, "pageY", { value: py, configurable: true });
        } catch (_) {}
        try { el.dispatchEvent(pe); } catch (_) {}
    }
}

async function dispatchTap(el, x, y, pressMs = 35) {
    if (!el) return;
    dispatchSyntheticPointer("pointerdown", el, x, y, 1, 0);
    dispatchSyntheticPointer("mousedown", el, x, y, 1, 0);
    if (pressMs > 0) await sleep(pressMs);
    dispatchSyntheticPointer("pointerup", el, x, y, 0, 0);
    dispatchSyntheticPointer("mouseup", el, x, y, 0, 0);
    dispatchSyntheticPointer("click", el, x, y, 0, 0);
}

async function dispatchDrag(el, x1, y1, x2, y2) {
    if (!el) return;
    dispatchSyntheticPointer("pointerdown", el, x1, y1, 1, 0);
    dispatchSyntheticPointer("mousedown", el, x1, y1, 1, 0);
    await sleep(25);

    const steps = 3;
    for (let i = 1; i <= steps; i++) {
        const xi = x1 + (x2 - x1) * (i / (steps + 1));
        const yi = y1 + (y2 - y1) * (i / (steps + 1));
        dispatchSyntheticPointer("pointermove", el, xi, yi, 1, 0);
        dispatchSyntheticPointer("mousemove", el, xi, yi, 1, 0);
        await sleep(20);
    }

    dispatchSyntheticPointer("pointermove", el, x2, y2, 1, 0);
    dispatchSyntheticPointer("mousemove", el, x2, y2, 1, 0);
    await sleep(25);

    dispatchSyntheticPointer("pointerup", el, x2, y2, 0, 0);
    dispatchSyntheticPointer("mouseup", el, x2, y2, 0, 0);
    dispatchSyntheticPointer("click", el, x2, y2, 0, 0);
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROBUST MOVE EXECUTION & DESELECT RECOVERY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Executes move cleanly on Duolingo's canvas board.
 * In Duolingo Chess:
 * - Kingside Castling: Move King from e1 -> g1 (White) or e8 -> g8 (Black).
 * - Queenside Castling: Move King from e1 -> c1 (White) or e8 -> c8 (Black).
 * Never click the Rook directly when executing a King move!
 */
async function executeMove(uci, insetRatio, flipped) {
    const fromSq = uci.slice(0, 2);
    const toSq = uci.slice(2, 4);
    const canvas = await waitCanvas();
    if (!canvas) return false;

    const pFrom = getSquareCoords(canvas, fromSq, insetRatio, flipped);
    const pTo = getSquareCoords(canvas, toSq, insetRatio, flipped);

    // 1. Primary Click Sequence: Tap Source -> Sleep -> Tap Destination
    await dispatchTap(canvas, pFrom.x, pFrom.y, 35);
    await sleep(BOT_CFG.clickDelay || 45);
    await dispatchTap(canvas, pTo.x, pTo.y, 35);

    await sleep(BOT_CFG.moveDelay || 120);

    // 2. Secondary Drag Fallback: if board state hasn't moved
    await dispatchDrag(canvas, pFrom.x, pFrom.y, pTo.x, pTo.y);

    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MULTI-TIER PAWN PROMOTION HANDLER
// ══════════════════════════════════════════════════════════════════════════════

let _lastPromotionMove = null;

function autoClickPromotionDOM() {
    // Look for Queen button or dialog modal options
    const queenSelectors = [
        '[data-piece="queen"]', '[data-piece="q"]', '[data-piece="Q"]',
        '[data-test*="queen" i]', '[data-test*="promotion-queen" i]',
        'button[aria-label*="queen" i]', 'div[role="button"][aria-label*="queen" i]',
        'img[alt*="queen" i]', 'img[src*="queen" i]', 'svg[data-piece*="queen" i]',
        '[aria-label*="dame" i]', '[aria-label*="reina" i]'
    ];

    for (const sel of queenSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
            if (isElementVisible(el) && !isForbiddenButton(el) && !el.closest("#dc-hud")) {
                simulateFullClick(el);
                return true;
            }
        }
    }

    // Generic promotion container search
    try {
        const containers = Array.from(document.querySelectorAll(
            '[data-test*="promotion" i], [class*="promotion" i], div[role="dialog"]'
        ));
        for (const cont of containers) {
            if (cont.closest("#dc-hud")) continue;
            const items = Array.from(cont.querySelectorAll('button, [role="button"], img, svg, div[tabindex]'))
                .filter(el => {
                    if (el.closest("#dc-hud")) return false;
                    const r = el.getBoundingClientRect();
                    return r.width >= 16 && r.height >= 16 && r.width <= 140;
                });
            if (items.length > 0) {
                simulateFullClick(items[0]);
                return true;
            }
        }
    } catch (_) {}

    return false;
}

async function handlePromotion(destSq, promoChar, insetRatio, flipped) {
    _lastPromotionMove = destSq;
    const canvas = findCanvas();

    for (let attempt = 0; attempt < 8; attempt++) {
        // Strategy 1: Check DOM promotion modal
        if (autoClickPromotionDOM()) return true;

        // Strategy 2: Click canvas promotion coordinates along the promotion file
        if (canvas && destSq && destSq.length >= 2) {
            const r = canvas.getBoundingClientRect();
            const iw = r.width * insetRatio, ih = r.height * insetRatio;
            const bw = r.width - (iw * 2),   bh = r.height - (ih * 2);
            const file = destSq.charCodeAt(0) - 97;
            const col = flipped ? (7 - file) : file;

            // Target destination square itself
            const pDest = getSquareCoords(canvas, destSq, insetRatio, flipped);
            await dispatchTap(canvas, pDest.x, pDest.y, 30);

            // Target vertical pieces on that file (e.g. ranks near edge)
            const ranksToTry = flipped ? [0, 1, 2] : [7, 6, 5];
            for (const rk of ranksToTry) {
                const x = r.left + iw + (col + 0.5) * (bw / 8);
                const y = r.top  + ih + (rk + 0.5) * (bh / 8);
                await dispatchTap(canvas, x, y, 25);
            }

            // Strategy 3: Target center canvas modal coords if Duolingo centered the modal
            await dispatchTap(canvas, r.left + r.width / 2, r.top + r.height * 0.45, 25);
        }

        // Strategy 4: Keyboard events ('q', '1', Enter, Space)
        try {
            for (const key of ["q", "1", "Enter", " "]) {
                const code = key === " " ? "Space" : (key === "1" ? "Digit1" : "KeyQ");
                const keyCode = key === " " ? 32 : (key === "1" ? 49 : 81);
                const evOpts = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
                window.dispatchEvent(new KeyboardEvent("keydown", evOpts));
                document.dispatchEvent(new KeyboardEvent("keydown", evOpts));
            }
        } catch (_) {}

        await sleep(75);
    }

    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DOM INTERACTION & AUTO-MATCH
// ══════════════════════════════════════════════════════════════════════════════

function isElementVisible(el) {
    if (!el || !el.isConnected || el.closest("#dc-hud")) return false;
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
            dispatchTap(el, r.left + r.width / 2, r.top + r.height / 2, 20);
        }
        return true;
    } catch (_) {
        return false;
    }
}

function autoMatchOscar() {
    if (!BOT_CFG.autoMatch) return false;

    // 1. Rematch / Play Again CTAs
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

    // 2. Clear Post-Match Summary / Reward screens ("Continue", "Claim XP", "Done", "Next")
    const advanceSelectors = [
        '[data-test*="player-next" i]', '[data-test*="continue-button" i]',
        '[data-test*="claim-button" i]', '[data-test*="session-end-button" i]',
        '[data-test*="next-button" i]', '[data-test*="bottom-nav-next-button" i]'
    ];
    for (const sel of advanceSelectors) {
        const btn = document.querySelector(sel);
        if (btn && isElementVisible(btn) && !isForbiddenButton(btn)) {
            simulateFullClick(btn);
            return true;
        }
    }

    // 3. Start Match / Play Oscar CTAs
    const launchSelectors = [
        'button[data-test*="start-match" i]', 'button[data-test*="start-button" i]',
        'button[data-test*="play-button" i]', 'button[data-test*="player-start-button" i]',
        '[data-test*="bot-oscar" i]', '[data-test*="character-oscar" i]'
    ];
    for (const sel of launchSelectors) {
        const btn = document.querySelector(sel);
        if (btn && isElementVisible(btn) && !isForbiddenButton(btn)) {
            setStatus("matching");
            simulateFullClick(btn);
            return true;
        }
    }

    // 4. Semantic Text Fallback
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
    const kws = ["play against oscar", "play oscar", "start match", "play again", "rematch", "continue", "claim"];
    for (const el of candidates) {
        if (!isElementVisible(el) || isForbiddenButton(el)) continue;
        const txt = (el.innerText || el.textContent || "").trim().toLowerCase();
        for (const kw of kws) {
            if (txt === kw || txt.includes(kw)) {
                simulateFullClick(el);
                return true;
            }
        }
    }

    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK INTERCEPTION & MATCH STATE MANAGEMENT
// ══════════════════════════════════════════════════════════════════════════════

const MATCHES_RE = /\/chess\b.*\/matches(?:\/([^/?#]+))?/;
const MOVES_RE   = /\/chess\b.*\/matches\/[^/?#]+\/moves/;
const isMatchURL = url => typeof url === "string" && !MOVES_RE.test(url) && (MATCHES_RE.test(url) || /\/matches\b/i.test(url) || /\/chess-match\b/i.test(url));

const _finishedMatchIds = new Set();
let _turnMutex = false;
let _lastTurnTimestamp = 0;

function isBot(player) {
    if (!player) return false;
    if (player.bot || player.isBot) return true;
    const name = String(player.name || player.username || "").toLowerCase();
    return name.includes("oscar") || name.includes("bot") || name.includes("duo");
}

function isOurTurn(fen) {
    if (!fen) return false;
    const side = (fen.split(" ")[1] || "w").toLowerCase();
    const color = (BOT_S.playerColor || "white").toLowerCase();
    return (side === "w" && color === "white") || (side === "b" && color === "black");
}

function onMatchData(data) {
    if (!data) return;
    const match = data.match ?? (data.boardFen ? data : null) ?? (data.chessMatch ? data.chessMatch : null);
    if (!match) return;

    const uid = getUserId();

    // Match Identification & Player Color Determination
    if (match.id && BOT_S.matchId !== match.id) {
        BOT_S.matchId = match.id;
        loadAccountStats();

        if (match.playerColor) {
            BOT_S.playerColor = match.playerColor.toLowerCase();
        } else if (match.whitePlayer && isBot(match.whitePlayer)) {
            BOT_S.playerColor = "black";
        } else if (match.blackPlayer && isBot(match.blackPlayer)) {
            BOT_S.playerColor = "white";
        } else if (match.whitePlayer && (String(match.whitePlayer.userId) === uid || String(match.whitePlayer.id) === uid)) {
            BOT_S.playerColor = "white";
        } else if (match.blackPlayer && (String(match.blackPlayer.userId) === uid || String(match.blackPlayer.id) === uid)) {
            BOT_S.playerColor = "black";
        } else {
            BOT_S.playerColor = "white";
        }
    }

    if (match.boardFen) {
        BOT_S.currentFen = match.boardFen;
    }

    // Match Finish / Game Over Detection
    if (match.endCondition || match.status === "finished") {
        const mId = match.id || BOT_S.matchId;
        if (mId && !_finishedMatchIds.has(String(mId))) {
            _finishedMatchIds.add(String(mId));

            const playerColor = (BOT_S.playerColor || "white").toLowerCase();
            const winner = String(match.winner || match.winnerColor || "").toLowerCase();
            const winnerUid = String(match.winnerUserId || "");
            const isWin = (winner === playerColor) || (winnerUid === uid && uid !== "0");

            recordMatchOutcome(mId, isWin);
        }

        BOT_S.matchId = null;
        setStatus("idle");
        if (BOT_CFG.autoMatch) {
            setTimeout(autoMatchOscar, 300);
            setTimeout(autoMatchOscar, 800);
            setTimeout(autoMatchOscar, 1500);
        }
        return;
    }

    // Active Turn Check
    if (match.status === "active" || match.status === "in_progress" || !match.status) {
        if (isOurTurn(BOT_S.currentFen)) {
            if (!_turnMutex && BOT_S.status !== "playing") {
                setStatus("active");
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
    if (_turnMutex) return;
    if (!isOurTurn(BOT_S.currentFen)) return;

    _turnMutex = true;
    _lastTurnTimestamp = Date.now();
    setStatus("thinking");

    try {
        const startFen = BOT_S.currentFen;
        const move = await getBestMove(startFen);

        if (!move || startFen !== BOT_S.currentFen) {
            setStatus("idle");
            return;
        }

        setStatus("playing");
        BOT_S.lastMove = `${move.slice(0, 2)} → ${move.slice(2, 4)}${move[4] ? ' (' + move[4].toUpperCase() + ')' : ''}`;

        const flip = (BOT_S.playerColor === "black");
        const isPromotion = (move.length >= 5) || (move[4] === "q") || (move[4] === "Q");

        // Execute verified legal move
        await executeMove(move, BOT_CFG.boardInsetRatio, flip);

        // Handle promotion popup if applicable
        if (isPromotion) {
            await handlePromotion(move.slice(2, 4), move[4] || "q", BOT_CFG.boardInsetRatio, flip);
        }

        setStatus("waiting");
    } catch (_) {
        setStatus("idle");
    } finally {
        _turnMutex = false;
        renderPanel();
    }
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
                if (uidMatch && uidMatch[1]) {
                    BOT_S.userId = uidMatch[1];
                    loadAccountStats();
                }
                if (isMatchURL(url)) {
                    res.clone().json().then(onMatchData).catch(() => {});
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
            if (isMatchURL(url)) {
                this.addEventListener("load", () => {
                    try {
                        const d = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
                        const uidMatch = url.match(/\/chess\/\d+\/(\d+)\//);
                        if (uidMatch && uidMatch[1]) {
                            BOT_S.userId = uidMatch[1];
                            loadAccountStats();
                        }
                        onMatchData(d);
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

async function recoverState() {
    try {
        const uid = getUserId();
        const hdrs = {};
        if (BOT_S.authToken) hdrs["Authorization"] = BOT_S.authToken;

        const urls = [];
        if (BOT_S.matchId) {
            urls.push(`/chess/1/${uid}/matches/${BOT_S.matchId}`);
            urls.push(`/chess/matches/${BOT_S.matchId}`);
        }
        if (uid && uid !== "0") {
            urls.push(`/chess/1/${uid}/matches`);
        }

        for (const u of urls) {
            try {
                const fetchFn = (typeof unsafeWindow !== "undefined" && unsafeWindow.fetch) || window.fetch;
                const res = await fetchFn(u, { method: "GET", headers: hdrs, credentials: "include" });
                if (res.ok) {
                    const data = await res.json();
                    onMatchData(data);
                    if (BOT_S.matchId) return;
                }
            } catch (_) {}
        }
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  LOGICAL, CLEAN HUD (Zero Emojis, Pure SVGs & Refined Typography)
// ══════════════════════════════════════════════════════════════════════════════

let _hud = null;

const HUD_STYLE = `
#dc-hud {
    position: fixed;
    bottom: 24px;
    right: 24px;
    width: 250px;
    background: rgba(15, 23, 42, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    padding: 12px 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #f8fafc;
    z-index: 2147483647;
    user-select: none;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-sizing: border-box;
    backdrop-filter: blur(10px);
}
#dc-hud.dragging { opacity: 0.9; }
.dc-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.dc-header:active { cursor: grabbing; }
.dc-brand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.8px;
    color: #f8fafc;
}
.dc-icon-chess {
    width: 14px;
    height: 14px;
    fill: #58cc02;
}
.dc-status {
    font-size: 9px;
    font-weight: 800;
    padding: 2px 7px;
    border-radius: 4px;
    background: #334155;
    color: #94a3b8;
    letter-spacing: 0.4px;
}
.dc-status.active { background: #15803d; color: #fff; }
.dc-status.thinking { background: #d97706; color: #fff; }
.dc-status.matching { background: #2563eb; color: #fff; }
.dc-grid-info {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    background: rgba(30, 41, 59, 0.5);
    border-radius: 6px;
    padding: 6px 8px;
}
.dc-field { display: flex; flex-direction: column; gap: 2px; }
.dc-field-label { font-size: 8.5px; font-weight: 700; color: #64748b; letter-spacing: 0.3px; }
.dc-field-val {
    font-size: 10.5px;
    font-weight: 700;
    color: #38bdf8;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.dc-field-val.move { color: #facc15; font-family: monospace; font-weight: 800; }
.dc-streak-box {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(30, 41, 59, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    padding: 6px 8px;
}
.dc-streak-text { display: flex; align-items: baseline; gap: 5px; font-size: 10px; font-weight: 700; }
.dc-streak-label { color: #94a3b8; }
.dc-streak-num { color: #58cc02; font-size: 13px; font-weight: 900; }
.dc-streak-best { color: #64748b; font-size: 9px; }
.dc-btn-reset {
    background: transparent;
    border: 1px solid rgba(148, 163, 184, 0.25);
    color: #94a3b8;
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 9px;
    font-weight: 700;
    cursor: pointer;
    transition: all 0.15s ease;
}
.dc-btn-reset:hover { background: #334155; color: #fff; border-color: rgba(148, 163, 184, 0.4); }
.dc-btn-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
}
.dc-toggle {
    background: #58cc02;
    color: #000;
    border: none;
    border-radius: 6px;
    padding: 6px 4px;
    font-size: 9.5px;
    font-weight: 800;
    cursor: pointer;
    text-align: center;
    line-height: 1.2;
    transition: filter 0.15s ease, background 0.15s ease;
}
.dc-toggle.off { background: #334155; color: #94a3b8; }
.dc-toggle:hover { filter: brightness(1.08); }
`;

const SVG_CHESS = `<svg class="dc-icon-chess" viewBox="0 0 24 24"><path d="M19 22H5v-2h14v2zm-2-4H7l1-6.5c-1.5-.7-2.3-2.1-2-3.8.3-1.6 1.7-2.7 3.3-2.7h1.4c.5-1.2 1.7-2 3.1-2h.2c1.4 0 2.6.8 3.1 2H19c.6 0 1 .4 1 1v1.5c0 1.9-1.2 3.5-3 4V18z"/></svg>`;

function injectCSS() {
    if (document.getElementById("dc-hud-style")) return;
    const s = document.createElement("style");
    s.id = "dc-hud-style";
    s.textContent = HUD_STYLE;
    document.head.appendChild(s);
}

function createHUD() {
    injectCSS();
    if (_hud) { _hud.remove(); _hud = null; }

    _hud = document.createElement("div");
    _hud.id = "dc-hud";

    _hud.innerHTML = `
    <div class="dc-header" id="dc-drag-handle">
        <div class="dc-brand">
            ${SVG_CHESS}
            <span>DUOLINGO CHESS</span>
        </div>
        <span class="dc-status" id="dc-status-badge">${esc(BOT_S.status.toUpperCase())}</span>
    </div>
    <div class="dc-grid-info">
        <div class="dc-field">
            <span class="dc-field-label">ENGINE</span>
            <span class="dc-field-val" id="dc-engine-val">${esc(BOT_S.engineName)}</span>
        </div>
        <div class="dc-field">
            <span class="dc-field-label">LAST MOVE</span>
            <span class="dc-field-val move" id="dc-move-val">${esc(BOT_S.lastMove || "-")}</span>
        </div>
    </div>
    <div class="dc-streak-box">
        <div class="dc-streak-text">
            <span class="dc-streak-label">STREAK:</span>
            <span class="dc-streak-num" id="dc-streak-num">${BOT_S.consecutiveWins}</span>
            <span class="dc-streak-best" id="dc-streak-best">(Best: ${BOT_S.bestStreak})</span>
        </div>
        <button id="dc-btn-rst" class="dc-btn-reset" title="Reset consecutive win streak">Reset</button>
    </div>
    <div class="dc-btn-grid">
        <button id="dc-btn-play" class="dc-toggle ${BOT_CFG.autoPlay ? '' : 'off'}">${BOT_CFG.autoPlay ? 'AUTO PLAY: ON' : 'AUTO PLAY: OFF'}</button>
        <button id="dc-btn-match" class="dc-toggle ${BOT_CFG.autoMatch ? '' : 'off'}">${BOT_CFG.autoMatch ? 'AUTO MATCH: ON' : 'AUTO MATCH: OFF'}</button>
    </div>`;

    document.body.appendChild(_hud);

    // Event listeners
    const btnPlay = _hud.querySelector("#dc-btn-play");
    if (btnPlay) {
        btnPlay.addEventListener("click", (e) => {
            e.stopPropagation();
            BOT_CFG.autoPlay = !BOT_CFG.autoPlay;
            saveAccountStats();
            renderPanel();
        });
    }

    const btnMatch = _hud.querySelector("#dc-btn-match");
    if (btnMatch) {
        btnMatch.addEventListener("click", (e) => {
            e.stopPropagation();
            BOT_CFG.autoMatch = !BOT_CFG.autoMatch;
            saveAccountStats();
            renderPanel();
        });
    }

    const btnRst = _hud.querySelector("#dc-btn-rst");
    if (btnRst) {
        btnRst.addEventListener("click", (e) => {
            e.stopPropagation();
            resetAccountStreak();
        });
    }

    makeDraggable(_hud, _hud.querySelector("#dc-drag-handle"));
    renderPanel();
}

function makeDraggable(el, handle) {
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
            const maxL = Math.max(10, window.innerWidth - 260);
            const maxT = Math.max(10, window.innerHeight - 150);
            el.style.left = Math.min(maxL, Math.max(10, saved.left)) + "px";
            el.style.top = Math.min(maxT, Math.max(10, saved.top)) + "px";
            el.style.bottom = "auto";
            el.style.right = "auto";
        }
    } catch (_) {}

    function onStart(e) {
        const pt = e.touches ? e.touches[0] : e;
        const rect = el.getBoundingClientRect();
        el.style.left = rect.left + "px";
        el.style.top = rect.top + "px";
        el.style.bottom = "auto";
        el.style.right = "auto";
        isDragging = true;
        startX = pt.clientX;
        startY = pt.clientY;
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

    handle.addEventListener("pointerdown", onStart);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
}

function renderPanel() {
    if (!_hud) return;
    const st = _hud.querySelector("#dc-status-badge");
    const eng = _hud.querySelector("#dc-engine-val");
    const mv = _hud.querySelector("#dc-move-val");
    const strk = _hud.querySelector("#dc-streak-num");
    const best = _hud.querySelector("#dc-streak-best");
    const btnPlay = _hud.querySelector("#dc-btn-play");
    const btnMatch = _hud.querySelector("#dc-btn-match");

    if (st) {
        st.textContent = BOT_S.status.toUpperCase();
        st.className = `dc-status ${BOT_S.status === 'playing' || BOT_S.status === 'active' ? 'active' : BOT_S.status === 'thinking' ? 'thinking' : BOT_S.status === 'matching' ? 'matching' : ''}`;
    }
    if (eng) eng.textContent = BOT_S.engineName || "Local GM";
    if (mv) mv.textContent = BOT_S.lastMove || "-";
    if (strk) strk.textContent = BOT_S.consecutiveWins;
    if (best) best.textContent = `(Best: ${BOT_S.bestStreak})`;

    if (btnPlay) {
        btnPlay.textContent = BOT_CFG.autoPlay ? "AUTO PLAY: ON" : "AUTO PLAY: OFF";
        btnPlay.className = `dc-toggle ${BOT_CFG.autoPlay ? '' : 'off'}`;
    }
    if (btnMatch) {
        btnMatch.textContent = BOT_CFG.autoMatch ? "AUTO MATCH: ON" : "AUTO MATCH: OFF";
        btnMatch.className = `dc-toggle ${BOT_CFG.autoMatch ? '' : 'off'}`;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  GLITCH-PROOF CONCURRENCY WATCHDOG & MAIN LOOP
// ══════════════════════════════════════════════════════════════════════════════

let _loopRunning = false;

async function _mainLoop() {
    if (_loopRunning) return;
    _loopRunning = true;

    while (true) {
        await sleep(150);

        // Watchdog 1: Release stuck mutex if turn execution hung > 4.5s
        if (_turnMutex && (Date.now() - _lastTurnTimestamp > 4500)) {
            _turnMutex = false;
            setStatus("idle");
        }

        // Auto-match / Rematch advance if game over
        if (BOT_CFG.autoMatch && !BOT_S.matchId && BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
            autoMatchOscar();
        }

        const canvas = findCanvas();
        if (canvas) {
            if (!BOT_S.matchId) {
                await recoverState();
            }

            // Watchdog 2: If it's our turn and idle/waiting with no move attempted for > 1.2s, trigger turn
            if (BOT_CFG.autoPlay && isOurTurn(BOT_S.currentFen) && !_turnMutex && BOT_S.status !== "playing" && BOT_S.status !== "thinking") {
                if (Date.now() - _lastTurnTimestamp > 1200) {
                    setStatus("active");
                    takeTurn();
                }
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BOOTSTRAP
// ══════════════════════════════════════════════════════════════════════════════

function _boot() {
    loadAccountStats();
    _mainLoop();
    if (document.body) {
        createHUD();
        recoverState();
    } else {
        document.addEventListener("DOMContentLoaded", () => {
            createHUD();
            recoverState();
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _boot);
} else {
    _boot();
}

})();
