# Security Policy

## Supported Versions

| Version | Supported | Security Maintenance |
| :--- | :--- | :--- |
| 1.1.x | Yes | Active vulnerability patches |
| < 1.1.0 | No | Deprecated |

---

## Vulnerability Disclosure Protocol

If you identify a security defect, local execution vulnerability, or input sanitization flaw in this repository, please disclose it privately:

* **Security Contact**: goharrehmanfsd260@gmail.com
* **Repository Maintainer**: Gohar Rehman (@itsgoharrehman)
* **Response SLA**: Acknowledgment within 48 hours; resolution plan provided within 5 business days.

---

## Security Invariants

### 1. Loopback Interface Binding
* The local Stockfish bridge server (`stockfish-server.js`) must bind strictly to the loopback interface (`127.0.0.1`).
* Under no circumstances should the server bind to `0.0.0.0` or accept unauthenticated traffic from external networks. Doing so would expose arbitrary process execution capabilities via UCI commands.

### 2. Input Sanitization on UCI Commands
* FEN strings received by the server must be strictly validated against standard chess FEN syntax before being formatted into UCI commands.
* Arbitrary strings or newline characters are disallowed to prevent command injection into the underlying Stockfish process.

### 3. Userscript Isolation
* The client userscript (`duolingo-chess-pc.user.js`) must not dynamically evaluate unverified remote scripts.
* All DOM queries must be scoped to the Duolingo chessboard container without accessing session tokens, cookies, or account credentials.
