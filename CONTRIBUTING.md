# Contributing Guidelines

Thank you for your interest in contributing to duolingo-chess-bot. We welcome contributions that optimize engine evaluation latency, improve DOM mutation tracking, or enhance documentation.

---

## Code of Conduct

All contributors and participants must adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Architectural Principles

1. **Strict Localhost Safety**: Never modify the bridge server to bind to public IP interfaces. Keep the server strictly on `127.0.0.1`.
2. **Robust DOM Parsing**: Duolingo may update class names or SVG structures. Ensure DOM selectors have fallback detection mechanisms.
3. **No External Telemetry**: The script and server must not transmit user data, game logs, or credentials to third-party endpoints.
4. **Lightweight Dependencies**: Keep the Node.js bridge server minimal without bloated framework dependencies.

---

## Development Workflow

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/duolingo-chess-bot.git
   cd duolingo-chess-bot
   ```

2. Create a feature branch:
   ```bash
   git checkout -b feature/board-detector-fallback
   ```

3. Test changes locally with `npm start` and manual verification on Duolingo Chess.

4. Submit a Pull Request targeting `main` and complete the pull request template.
