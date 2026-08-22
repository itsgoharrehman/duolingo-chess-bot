<div align="center">

# 🦉♟️ Duolingo Chess Auto-Match Bot (Fast GM Mate Edition)

**An ultra-fast, automated Tampermonkey Userscript that blitzes Duolingo Chess matches in under 15 moves, solves puzzle lessons, handles pawn promotions flawlessly, auto-clicks all reward screens, and plays endlessly!**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-2.4.0-brightgreen.svg)]()
[![Engine](https://img.shields.io/badge/Engine-Stockfish%2016%2B%20%26%20Lichess%20GM-blue.svg)]()
[![Target](https://img.shields.io/badge/Platform-Duolingo%20Chess-58cc02.svg)]()

</div>

---

## 🌟 Highlights & Key Features

- ⚡ **Sub-15 Move Quick Wins**:
  - **Lethal Opening Book**: Uses aggressive Wayward Queen / Scholar attacks that exploit bot weaknesses for 4 to 7 move checkmates.
  - **0ms Instant Mate Detector**: Instantly scans for *Checkmate in 1* and *Forced Mate in 2* on every turn.
  - **Stockfish 16+ GM Depth 15 & Lichess Cloud Table**: Computes the shortest, most decisive checkmate paths instead of slow endgame grinding.
- 👑 **Universal Pawn Promotion**:
  - Automatically identifies pawn promotions and promotes to Queen (`e7e8q`).
  - Dispatches clicks across both DOM modals and Duolingo's HTML5 canvas piece picker without getting stuck.
- 🔄 **Continuous Auto-Match Loop**:
  - Automatically clicks through all post-match reward screens (Victory, XP Earned, Streak, Chests).
  - Automatically clicks **"Play Against Oscar"** / **"Start Match"** to start subsequent games in an infinite loop.
- 🧩 **Lesson & Puzzle Solver**:
  - Automatically loads and solves all puzzle challenges from session data.
- 🎮 **Cyberpunk Draggable HUD**:
  - Live **Matches Won** and per-match **Moves (Current)** tracker.
  - One-click **AUTO-MATCH: ON/OFF** toggle.
  - Real-time activity console displaying live move notations (`e2e4`, `d1h5`, `h5f7#`).
  - Draggable & collapsible header for a zero-distraction view.

---

## 🚀 Quick Setup & Installation

### Step 1: Install Tampermonkey
If you don't already have it, install the **Tampermonkey** browser extension:
- [Chrome Web Store](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

### Step 2: Install the Userscript
1. Open the Tampermonkey Dashboard in your browser (click the extension icon ➔ **Dashboard**).
2. Click the **+** (Create a new script) tab.
3. Copy all code from [`duolingo-chess-ai.user.js`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/duolingo-chess-ai.user.js) and paste it into the editor.
4. Press `Ctrl + S` (or `File -> Save`).

---

## 🎮 How to Use on Duolingo

1. Navigate to **[duolingo.com](https://www.duolingo.com/)** and open the **Chess** section or a match/lesson against Oscar.
2. The **♟️ DUO CHESS BOT** HUD will appear at the bottom-right of your screen.
3. Click **⚡ AUTO-MATCH: ON** to start the continuous loop.
4. The bot will automatically play winning moves, crush Oscar in under 15 moves, click all Continue buttons, and start the next game automatically!

---

## ⚙️ Configuration & Speed Settings

You can customize timings inside `BOT_CFG` in the script:

| Parameter | Default | Description |
|---|---|---|
| `stockfishDepth` | `15` | Calculation depth for lethal checkmating lines |
| `clickDelay` | `100ms` | Gap between piece selection and target square |
| `moveDelay` | `600ms` | Settle delay after moving for smooth animation |
| `thinkDelay` | `180ms` | Fast response after Oscar finishes moving |
| `autoPlay` | `true` | Enables hands-free infinite match loop |

---

## 📄 License

Distributed under the **MIT License**. See [`LICENSE`](file:///c:/Users/Gohar%20Rehman/Desktop/DUOLINGO-CHESS/LICENSE) for more details.

---

<div align="center">
<i>Disclaimer: This script is created for educational and testing purposes.</i>
</div>
