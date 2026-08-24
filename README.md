<div align="center">

# 🦉♟️ Duolingo Chess Auto-Match Bot (Universal Pro Edition)

**An ultra-fast, automated Tampermonkey Userscript that blitzes Duolingo Chess matches in under 15 moves, solves puzzle lessons, handles pawn promotions flawlessly, auto-clicks all reward screens, and plays endlessly on both PC and Android!**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-5.0.0-brightgreen.svg)]()
[![Engine](https://img.shields.io/badge/Engine-Stockfish%2016%2B%20%26%20Lichess%20GM-blue.svg)]()
[![Platform](https://img.shields.io/badge/Platform-PC%20%26%20Android-58cc02.svg)]()

</div>

---

## 🌟 Single Universal Script (`duolingo-chess-ai.user.js`)

One clean, unified script works across all devices (Desktop Chrome/Firefox/Edge and Android Kiwi Browser / Firefox Mobile):

- **Main Script**: [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js)

---

## ⚡ Key Fixes & Enhancements

- 🎯 **Single-Pass Verified Move Execution**:
  - Eliminates rapid duplicate attempts and piece sticking.
  - Taps source square then target square with exact timing. Only falls back to a clean drag if the tap was unacknowledged.
  - Never clicks arbitrary corners during moves.
- 🛡️ **Active Anti-Freeze Watchdog**:
  - Automatically recovers and re-triggers turn calculations if stuck in `thinking`, `playing`, or `waiting` state for more than 2.5–3.5 seconds.
  - Prevents permanent lockouts.
- 📱 **Authentic Pointer & Touch Event Synthesis**:
  - Emulates standard `TouchEvent` (`touchstart`, `touchmove`, `touchend`) alongside `PointerEvent` (`pointerdown`, `pointermove`, `pointerup`) and `MouseEvent`.
- 📊 **Accurate Move Counter**:
  - `Moves Played` increments only when board state/FEN actually updates.
- 👑 **Automatic Pawn Promotion**:
  - Instantly promotes to Queen (`q`) through DOM dialogs or in-canvas pickers.
- 🔄 **Continuous Auto-Match & Puzzle Solver**:
  - Clicks through all reward screens (XP, Victory, Streak) and automatically starts the next match against Oscar.

---

## 🚀 Quick Setup & Installation

### On PC / Desktop (Chrome, Edge, Firefox, Brave):
1. Install **[Tampermonkey](https://www.tampermonkey.net/)**.
2. Open Tampermonkey ➔ **Create a new script**.
3. Copy and paste all code from [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js).
4. Save the script (`Ctrl + S`).
5. Open [duolingo.com](https://www.duolingo.com/) and play!

### On Android / Mobile (Kiwi Browser / Firefox Android):
1. Install **Kiwi Browser** or **Firefox for Android**.
2. Install the **Tampermonkey** or **Violentmonkey** extension.
3. Create a new userscript and paste all code from [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js).
4. Save and open [duolingo.com](https://www.duolingo.com/).

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/LICENSE) for more details.
