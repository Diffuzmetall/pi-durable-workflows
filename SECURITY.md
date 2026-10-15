# Security

This is a prototype. Do not run it against production databases or use it with sensitive inputs or credentials.

Keep the IPC secret private. Do not commit `.env` files, databases, native captures, logs or run outputs. They may contain complete workflow inputs and results. The repository ignores common generated paths, but you remain responsible for what you upload.

Do not bypass ownership, schema validation, budget, identity or unsafe-replay checks. Never open a second native owner while cleanup of the first is uncertain. Unknown effects require investigation, not automatic replay.

For public bug reports, include a minimal synthetic reproduction. Do not attach real databases, access tokens, IPC secrets or private conversation data. No security support SLA or production-hardening claim is provided.
