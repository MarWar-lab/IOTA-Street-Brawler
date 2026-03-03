# IOTA Street Brawler

Production-ready React + IOTA dApp Kit frontend for an on-chain Tamagotchi fighter game, plus the Move package.

## Repo layout

- `frontend/` — Vite + React + TypeScript dApp
- `move/` — Move package (publish to IOTA)

## Frontend quickstart

```bash
cd frontend
npm install
npm run dev
```

Then in the app, set:
- Package ID
- Shared object IDs (Clock, Random, ArenaState, MarketState) as needed
