<div align="center">

# ♟️ Duolingo Chess Solver & Auto-Match Bot (v6.0.0)

**A master-engineered, ultra-reliable Userscript with an embedded `chess.js` rules engine, guaranteed 100% legal moves, infallible castling, multi-tier pawn promotion, per-account consecutive win tracking, and freeze-proof concurrency.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-6.0.0-brightgreen.svg)]()
[![Engine](https://img.shields.io/badge/Engine-chess.js%20%2B%20Lichess%20Cloud%20%2B%20Stockfish-blue.svg)]()
[![Platform](https://img.shields.io/badge/Platform-PC%20%26%20Android-58cc02.svg)]()

</div>

---

## 🌟 Available Userscripts

- **PC / Desktop Edition**: [`duolingo-chess-pc.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-pc.user.js)
- **Universal Master Edition**: [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js)
- **Android Edition**: [`duolingo-chess-android.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-android.user.js)

---

## ⚡ Core Engineering Improvements (v6.0.0)

1. **Embedded `chess.js` Rules Engine & Strict Move Validation**:
   - 0x88 board representation with 100% FIDE rule adherence embedded directly inside the userscript (zero external CDN dependency, 100% offline).
   - Every candidate move from any engine (Lichess Cloud, Stockfish 16+, Chess-API, or local engine) is strictly normalized and validated before being dispatched.
   - **Zero Illegal Moves**: Moves that are not strictly legal in the active position are rejected immediately.

2. **Infallible Castling**:
   - Full normalization for Chess960-style castling output (`e1h1 -> e1g1`, `e1a1 -> e1c1`, `e8h8 -> e8g8`, `e8a8 -> e8c8`).
   - Executes castling strictly by moving the King to its destination square (`e1 -> g1`/`c1` or `e8 -> g8`/`c8`). Never taps or drags the Rook directly during a King move.

3. **Multi-Tier Pawn Promotion Handler**:
   - Queries DOM modal dialogs and piece pickers (`[role="dialog"]`, `[data-test*="promotion"]`, SVG piece buttons).
   - Targets exact promotion coordinates along the promotion file and center canvas overlay.
   - Dispatches keyboard shortcuts (`q`, `1`, `Enter`, `Space`).

4. **Freeze-Proof Concurrency Mutex**:
   - Strict `_turnMutex` prevents overlapping `takeTurn()` instances or race conditions.
   - Self-healing watchdog clears any stalled operation after 4.5 seconds.
   - Zero UI thread freezing or rate-limit spamming.

5. **Per-Account Consecutive Win Tracking**:
   - Tracks win streaks individually per account (`duo_user_id` / account ID).
   - Real victory detection: win streak increments on genuine wins and resets to `0` on losses/draws.
   - Dedicated Reset button resets the active account's streak.

6. **Refined, Logical HUD**:
   - Clean, dark-mode card layout with SVG vector icons and zero emojis.
   - Displays real-time status (`ACTIVE`, `THINKING`, `MATCHING`, `WAITING`, `IDLE`), active engine name, formatted last move (`e2 → e4`), win streak, and toggle controls (`Auto Play`, `Auto Match`, `Reset`).
   - Draggable with boundary clamping and saved coordinate persistence.

---

## 🚀 Quick Installation

### On PC / Desktop (Chrome, Brave, Edge, Firefox):
1. Install **[Tampermonkey](https://www.tampermonkey.net/)**.
2. Create a new userscript and paste [`duolingo-chess-pc.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-pc.user.js).
3. Save (`Ctrl + S`) and navigate to [duolingo.com/chess-match](https://www.duolingo.com/chess-match).

### On Android / Mobile (Kiwi Browser / Firefox Android):
1. Install **Kiwi Browser** or **Firefox for Android**.
2. Install **Tampermonkey** or **Violentmonkey**.
3. Create a new userscript and paste [`duolingo-chess-android.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-android.user.js).
4. Save and open [duolingo.com/chess-match](https://www.duolingo.com/chess-match).
