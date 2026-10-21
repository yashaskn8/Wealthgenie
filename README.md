# Wealthgenie

AI-powered financial advisory application with React frontend, Node.js/Express backend, and an ML service.

## CI/CD status — `main`

[![CI — main](https://github.com/yashaskn8/Wealthgenie/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/yashaskn8/Wealthgenie/actions/workflows/ci.yml)
[![CD / Kind verification — main](https://github.com/yashaskn8/Wealthgenie/actions/workflows/cd.yml/badge.svg?branch=main)](https://github.com/yashaskn8/Wealthgenie/actions/workflows/cd.yml)

**Open GitHub Actions:**
[All runs](https://github.com/yashaskn8/Wealthgenie/actions) ·
[CI runs](https://github.com/yashaskn8/Wealthgenie/actions/workflows/ci.yml) ·
[CD / cluster verification runs](https://github.com/yashaskn8/Wealthgenie/actions/workflows/cd.yml)

The badges reflect GitHub Actions results and may show **failing**, **pending**, or **skipped**. A skipped CD run is not evidence of deployment. The CD workflow admits automatic cluster verification only after an eligible successful CI run on `main`.

## Source layout

- `reactapp/` — frontend
- `server/` — API and financial engines
- `ml-service/` — ML service
- `.github/workflows/ci.yml` — CI pipeline
- `.github/workflows/cd.yml` — conditional cluster verification pipeline

See the `docs/` directory for implementation and deployment documentation.
