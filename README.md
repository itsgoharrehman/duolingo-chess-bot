<div align="center">

# 🦉♟️ Duolingo Chess Auto-Match Bot (PC / Desktop Edition)

**An ultra-fast, rock-solid automated Userscript with a built-in offline chess engine that blitzes Duolingo Chess matches in under 15 moves, solves puzzle lessons, handles pawn promotions, auto-matches Oscar, and features a clean, high-visibility desktop HUD.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-5.2.1-brightgreen.svg)]()
[![Engine](https://img.shields.io/badge/Engine-Embedded%20Minimax%20%2B%20Stockfish-blue.svg)]()
[![Platform](https://img.shields.io/badge/Platform-PC%20%2F%20Desktop-58cc02.svg)]()

</div>

---

## 🌟 Main Script

- **PC Userscript**: [`duolingo-chess-pc.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/duolingo-chess-bot/duolingo-chess-pc.user.js)

---

## ⚡ Key Improvements (v5.2.1)

1. **Zero Move Sticking & Glitch-Free Moves**:
   - **Castling Execution**: Ultra-fast, smooth pointer drag (`e1g1`, `e1c1`, `e8g8`, `e8c8`) with automatic fallback to rook square drag (`h1`/`a1`/`h8`/`a8`) if needed.
   - **Instant Network Move Acknowledgment**: Hooks into `/moves` API requests so confirmed moves return immediately without redundant clicks or hesitations.
   - **Eliminated Freeze Watchdog**: Removed arbitrary retry cutoffs (`< 3`) and replaced slow 4s delays with a 350ms retry cooldown. The bot never freezes.

2. **Ultra-Fast Speed**:
   - High-speed delays (25ms click, 35ms move, 10ms think).
   - Instant Checkmate scanner in 0ms.
   - Lichess Cloud and Stockfish Online queries capped with short timeouts, falling back to embedded 10ms `FastChess`.

2. **Clean & High-Visibility Desktop HUD**:
   - Enlarged overlay box with crisp, readable, high-contrast typography (12px–14px bold) replacing previous cramped 9px–11px text.
   - Removed unused stats counters (Wins, Moves) and the reset button for an uncluttered, distraction-free control panel.

3. **Embedded High-Performance Chess Engine (`FastChess`)**:
   - 100% self-contained minimax alpha-beta chess engine embedded directly inside the userscript.
   - Calculates guaranteed legal tactical moves in **15ms** without depending on external web servers or getting blocked by Duolingo's CSP.
   - Built-in instant checkmate scanner and lethal opening book.

4. **Surgical Bloat Removal**:
   - Removed conflicting background timers, dead SVG clickers, and duplicate loop watchdogs.

---

## 🚀 Quick Installation

### On PC / Desktop (Chrome, Edge, Firefox, Brave):
1. Install **[Tampermonkey](https://www.tampermonkey.net/)**.
2. Create a new userscript and copy-paste the contents of [`duolingo-chess-pc.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/duolingo-chess-bot/duolingo-chess-pc.user.js).
3. Save (`Ctrl + S`) and navigate to [duolingo.com](https://www.duolingo.com/).
