# Contributing

Start with a GitHub issue describing the behavior and a minimal reproduction using synthetic data. Keep changes within the sequential prototype unless a broader feature has been agreed.

Before submitting code, discuss licensing with the maintainer. This repository is currently UNLICENSED; it is not yet an open-source contribution program.

For local checks:

```sh
npm ci --ignore-scripts
npm test
npm run demo
```

The demo creates fresh private stores and retains their outputs under `.data/`. Never commit those artifacts. Do not add live or paid provider calls to tests, and do not weaken ownership, validation, budget or unsafe-replay guards.

Explain which checks you ran and which claims remain unverified. A deterministic offline result is not evidence of real-model correctness.
