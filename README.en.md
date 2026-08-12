<p align="center">
  <img src="peixue-frontend/public/seed.png" width="112" alt="Peixue icon" />
</p>

<h1 align="center">Peixue · 陪学笔记</h1>

<p align="center">
  A self-hosted AI-assisted learning journal for families—turn mistakes, questions, and parent observations into growth records, spaced reviews, and teach-back cards.
</p>

<p align="center">
  <a href="README.md">中文</a> · English
</p>

> [!NOTE]
> Peixue is open source and remains at an early release stage. Read [Privacy and security](#privacy-and-security) and the [deployment guide](docs/DEPLOYMENT.md). Back up your data before every upgrade.

## Why Peixue exists

The hardest part of learning together is rarely finding one more worksheet. It is remembering where a child got stuck, knowing when to revisit the idea, and explaining it in a way the child can teach back.

Peixue follows that real family workflow. A parent records a mistake, question, or observation. AI helps organize a possible misconception and a way to guide the conversation. The app then schedules review, creates variations, and offers a teach-back card when a child repeatedly struggles. Peixue supports parents; it does not replace teachers, clinicians, or professional educational assessment.

## Features

- Capture math and Chinese-language mistakes, questions, and parent observations in a child growth record
- Analyze text and image-based questions with AI while keeping the parent's judgment editable
- Schedule spaced reviews and generate similar, varied, and follow-up questions
- Create parent-friendly explanations, teach-back prompts, and verification questions after repeated mistakes
- Isolate multiple families with bcrypt passwords, daily AI quotas, and prompt-free call auditing
- Export and restore JSON backups, install as a PWA, and self-host the complete service
- Connect to a configurable OpenAI-compatible Chat Completions endpoint instead of one fixed provider

AI output can be wrong, particularly for open-ended questions, image recognition, and answer evaluation. A parent should review generated material before using it with a child.

## Quick start with Docker

You need Docker Engine, Docker Compose, and an AI provider with a compatible `/chat/completions` endpoint.

```bash
cp .env.example .env
```

Edit `.env` and replace at least:

- `DB_PASSWORD` and `MYSQL_ROOT_PASSWORD`
- `AI_ENDPOINT`, `AI_API_KEY`, and `AI_MODEL`
- `AI_VISION_MODEL` if you want image-question support

Start the stack:

```bash
docker compose up -d --build
```

Create the first family account:

```bash
read -r -s -p "Family password (at least 12 characters): " PEIXUE_FAMILY_PASSWORD
echo
docker compose exec -e PEIXUE_FAMILY_PASSWORD="$PEIXUE_FAMILY_PASSWORD" \
  backend npm run admin -- create \
  --name="My family" \
  --password-env \
  --days=3650 \
  --quota=100 \
  --url="http://localhost:8080"
unset PEIXUE_FAMILY_PASSWORD
```

Open <http://localhost:8080> and enter that password under “Backup & Settings.”

To preview a populated timeline, use “Backup & Settings → Import” in a new family and select [`examples/demo-backup.json`](examples/demo-backup.json). It contains synthetic data only; importing replaces the current family's records.

Check the services:

```bash
docker compose ps
docker compose logs -f backend
curl http://localhost:8080/api/health
```

See the [deployment guide](docs/DEPLOYMENT.md) for production deployment, backups, and upgrades, and the [AI provider guide](docs/AI_PROVIDER_GUIDE.md) for compatibility, cost, failure modes, and privacy boundaries.

## Architecture

```text
Browser / PWA
     │  same-origin HTTP(S)
     ▼
Nginx static site ── /api/* ──► Express backend ──► MySQL
                                         │
                                         └────────► AI provider
```

Current repository layout:

```text
peixue-frontend/   React/Vite/Tailwind Web/PWA source and Nginx image
peixue-server/     Express backend, MySQL schema, and family admin CLI
docs/              Deployment, publishing, and Codex for OSS application notes
.github/           CI, issue forms, and pull request template
```

## Local development and checks

The frontend requires Node.js 20.19+. Install, verify, and start its development server with:

```bash
npm --prefix peixue-frontend ci
npm --prefix peixue-frontend run check
npm --prefix peixue-frontend run dev
```

The development server proxies `/api` to `http://127.0.0.1:3001` by default.

The backend requires Node.js 20+ and MySQL 8:

```bash
cp .env.example peixue-server/.env
cd peixue-server
npm ci
npm test
npm start
```

Run repository-level privacy, structure, and link checks with:

```bash
node scripts/check-repository.mjs
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before contributing. Examples, issues, logs, and fixtures must never contain a real child's name, photo, question image, family password, API key, or database export.

## Privacy and security

This project handles children's learning records, so operators must take extra care:

- Use HTTPS in production; do not expose port `3001` or MySQL directly to the internet
- Question text and selected images are sent to the configured AI provider during analysis; review that provider's data policy first
- `.env`, database volumes, and exported JSON can all be sensitive; encrypt backups and restrict access
- The family password is stored in browser local storage; avoid persistent sign-in on shared devices
- The project does not claim compliance with any particular child-privacy or education regulation; operators must perform their own assessment

Do not open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md) and use GitHub Private Vulnerability Reporting.

## Roadmap and contributing

The immediate priorities are end-to-end regression coverage, privacy-safe interface demos, compatibility checks for more model providers, and stronger family-data boundaries. Contributions are welcome; issues labeled `good first issue` or `help wanted` are intended as starting points.

- [Contributing guide](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Changelog](CHANGELOG.md)
- [Known limitations](docs/KNOWN_LIMITATIONS.md)
- [AI provider compatibility, cost, and privacy guide](docs/AI_PROVIDER_GUIDE.md)
- [Open-source checklist](docs/OPEN_SOURCE_CHECKLIST.md)
- [GitHub publishing guide](docs/GITHUB_PUBLISHING.md)
- [Codex for OSS application guidance and draft](docs/CODEX_FOR_OSS_APPLICATION.md)
- [Post-launch starter issue drafts](docs/STARTER_ISSUES.md)

## License

Peixue is licensed under the [MIT License](LICENSE). Frontend production-dependency licenses ship with the build in [`THIRD_PARTY_NOTICES.txt`](peixue-frontend/public/THIRD_PARTY_NOTICES.txt). Publishers must still confirm that they have the right to release every code and media asset in the repository.
