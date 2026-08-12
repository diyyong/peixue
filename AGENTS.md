# Repository guidance for coding agents

## Project

Peixue is a self-hosted family learning journal. The React/Vite frontend talks to an Express backend that stores multi-family data in MySQL and calls configurable Chat Completions-compatible AI endpoints.

## Safety and privacy

- Never add real child names, photos, school information, learning records, family exports, passwords, API keys, or `.env` contents to code, fixtures, logs, docs, commits, issues, or examples.
- Use synthetic fixtures only.
- Treat family isolation, authentication, import/export, image data, and database migrations as security-sensitive.
- Change frontend behavior under `peixue-frontend/src/`, then run lint and build. Do not commit `peixue-frontend/dist/` or hand-edit generated bundles.
- Preserve existing user data across schema migrations. Require a documented backup for destructive migration work.

## Useful commands

```bash
node scripts/check-repository.mjs
npm --prefix peixue-frontend ci
npm --prefix peixue-frontend run check
npm --prefix peixue-server ci
npm --prefix peixue-server test
npm --prefix peixue-server audit --omit=dev
```

For an end-to-end environment, copy `.env.example` to `.env` with non-production credentials and run `docker compose up -d --build`.

## Change expectations

- Keep configuration documented in `.env.example` and `docs/DEPLOYMENT.md`.
- Add or update tests for behavior changes, especially family scoping and data migration.
- Update both `README.md` and `README.en.md` when changing user-facing setup or core capabilities.
- Keep pull requests focused and avoid unrelated generated-file churn.
