## Description

Please provide a clear summary of the changes in this pull request and their intended behavior.

---

## Type of Change

- [ ] Bug fix (non-breaking fix for board detection or UCI communication)
- [ ] New feature (e.g. additional engine evaluation heuristics)
- [ ] Performance improvement (reducing move latency)
- [ ] Documentation update

---

## Security and Verification Checklist

- [ ] Bridge server remains strictly bound to loopback interface (`127.0.0.1`).
- [ ] FEN inputs are validated to prevent command injection into the UCI subprocess.
- [ ] Userscript does not make unauthorized outbound requests to third-party domains.
- [ ] Tested locally against the target chess interface.
