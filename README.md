<div align="center">

# 🦉♟️ Duolingo Chess Auto-Match Bot (Universal Master Edition)

**An ultra-fast, automated Userscript with a built-in offline chess engine that blitzes Duolingo Chess matches in under 15 moves, solves puzzle lessons, handles pawn promotions, auto-clicks rewards, and plays seamlessly on both PC and Android!**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-5.1.0-brightgreen.svg)]()
[![Engine](https://img.shields.io/badge/Engine-Embedded%20Minimax%20%2B%20Stockfish-blue.svg)]()
[![Platform](https://img.shields.io/badge/Platform-PC%20%26%20Android-58cc02.svg)]()

</div>

---

## 🌟 Single Universal Script (`duolingo-chess-ai.user.js`)

- **Unified Master Userscript**: [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js)

---

## ⚡ Key Improvements (v5.1.0)

1. **Embedded High-Performance Chess Engine (`FastChess`)**:
   - 100% self-contained minimax alpha-beta chess engine embedded directly inside the userscript.
   - **Zero Network Hang**: Calculates guaranteed legal, tactical moves in **15ms** without depending on external web servers or getting blocked by Duolingo's CSP.
   - Built-in instant checkmate scanner (mate in 1/2) and lethal Wayward Queen opening book.

2. **Touch Drag & Move Execution for Android / Mobile**:
   - Dispatches authentic continuous `pointerdown` + `touchstart` ➔ smooth multi-step `pointermove` + `touchmove` path ➔ `pointerup` + `touchend` with consistent touch identifiers.
   - Guarantees pieces reach their destination square on mobile touchscreens without staying suspended.

3. **Active Watchdog & Anti-Freeze Timer**:
   - Immediately breaks out of stuck `thinking` or `playing` states after 2.5s.
   - Automatically re-triggers turn calculations if idle on our turn for > 2.0s.

---

## 🚀 Quick Installation

### On PC / Desktop (Chrome, Edge, Firefox, Brave):
1. Install **[Tampermonkey](https://www.tampermonkey.net/)**.
2. Create a new userscript and copy-paste the contents of [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js).
3. Save (`Ctrl + S`) and navigate to [duolingo.com](https://www.duolingo.com/).

### On Android / Mobile (Kiwi Browser / Firefox Android):
1. Install **Kiwi Browser** or **Firefox for Android**.
2. Install **Tampermonkey** or **Violentmonkey**.
3. Create a new userscript and paste [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js).
4. Save and open [duolingo.com](https://www.duolingo.com/).
