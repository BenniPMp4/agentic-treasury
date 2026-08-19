# secrets/

Local-only folder for API keys, tokens, and other sensitive data.

- Everything in this folder (except this README and `.gitkeep`) is excluded from
  git via the root `.gitignore` (`secrets/*`), so nothing placed here is ever
  committed or pushed to GitHub.
- Do not reference paths in this folder from committed code with hardcoded
  contents — load secrets at runtime via environment variables instead
  (e.g. `dotenv` reading a `.env` file, which is also gitignored).
- If a secret is ever committed by accident, treat it as compromised: rotate
  it immediately, then scrub it from git history.

Nothing in this repository should ever ask you to read from or write to this
folder as part of a task unless the user explicitly requests it.
