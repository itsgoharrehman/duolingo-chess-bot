# duolingo-chess-bot

An automated Duolingo Chess engine extension powered by Stockfish 16+ Grandmaster chess engine. Features real-time board state extraction from the DOM, sub-15 move fast checkmate pathfinding, automated pawn promotion handling, and continuous match looping.

## Architecture and Stack

* **Runtime**: JavaScript (Userscript / Browser Extension Context)
* **Chess Engine**: Stockfish 16+ WebAssembly (WASM) / Web Worker
* **DOM Inspector**: MutationObserver for real-time board state synchronization

## Key Features

* **DOM Board State Parsing**: Automatically decodes SVG and CSS piece coordinates into FEN (Forsyth-Edwards Notation) strings.
* **Stockfish 16 Integration**: Multi-threaded WASM evaluation calculating optimal tactical moves in milliseconds.
* **Fast Checkmate Pathfinding**: Aggressive opening and midgame heuristics designed to terminate matches rapidly.
* **Resilient Promotion Handler**: Intercepts and auto-resolves pawn promotion modal dialogues.

## Getting Started

### Prerequisites
* Violentmonkey, Tampermonkey, or standard Chromium browser extension loader

### Installation
```bash
git clone https://github.com/itsgoharrehman/duolingo-chess-bot.git
cd duolingo-chess-bot
```
Load `duolingo-chess-bot.user.js` into your userscript manager.

## Security and Disclaimer

This project is developed for educational and software automation research purposes. Respect platform terms of service.

## Maintainer

* **Gohar Rehman**
* GitHub: [@itsgoharrehman](https://github.com/itsgoharrehman)
* Email: `goharrehmanfsd260@gmail.com`
* Website: [itsgoharrehman.netlify.app](https://itsgoharrehman.netlify.app/)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
