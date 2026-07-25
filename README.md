# Camera Trade Hub (Auckland)

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](./LICENSE)

MVP web app for camera stores to **grade gear**, pay **store credit or cash** (3rd-party seller flow), track **inventory / resale**, and manage **customer store credit**.

Built for Auckland trade-in workflows (Photogear, Auckland Camera Centre, Photo Warehouse). Client state uses **LocalStorage**; optional Express server adds stolen-serial proxy, ExifTool shutter read, and Stripe webhook stubs.

---

## Partner stores

| Store | Area | Notes |
|--------|------|--------|
| **Photogear** | Mt Eden, 6 Akepiro St | Store credit only · sales@photogear.co.nz |
| **Auckland Camera Centre** | Morningside, 646 New North Rd | Trade-ins accepted |
| **Photo Warehouse** | Ponsonby / CBD | Trade value toward new gear |

---

## Requirements

- **Node.js** 18+ (for server + tests)
- **ExifTool** on PATH (optional, for photo shutter-count extract)
  - Linux: `sudo apt install libimage-exiftool-perl`
  - macOS: `brew install exiftool`
  - Windows: https://exiftool.org

---

## Quick start

```bash
cd camera-trade-app
npm install
npm start
```

Open **http://localhost:8787**

| Command | Description |
|---------|-------------|
| `npm start` | Serve app + API on port **8787** |
| `npm run dev` | Same with `--watch` |
| `npm test` | Unit tests |

You can open `index.html` alone in a browser; EXIF upload and the stolen-check proxy need the server.

---

## Features

| Feature | Detail |
|---------|--------|
| Grade → offer | Condition multipliers + **model-aware shutter depreciation** (ease-out curve) |
| Payout | Store credit (full) or **cash** via simulated Stripe Connect |
| Platform fee | **5% + $0.50** on cash; net transfer to store |
| Inventory | Cost basis, list price (~1.35×), list / sold |
| Customer credit | Per store + customer balance (LocalStorage) |
| Stolen serial | Local mock + proxy `POST /api/stolen-check` |
| Shutter / EXIF | Manual count or **ExifTool** via `POST /api/exif-shutter` |
| Stripe Connect | Onboard Express accounts, transfers, webhook simulator |
| Idempotency keys | Duplicate cash payouts replay the same transfer |
| Cloudflare Worker | CORS proxy + **sliding-window** rate limit (10 / 60s / IP) |
| NZ resources tab | Police, SNAP (offline), SeriSafe, Ecotechnologies, dealer law |

### Shutter life tiers (from model name)

| Tier | Typical rating | Examples |
|------|----------------|----------|
| Entry | 100k | R50, Z50, A6xxx |
| Enthusiast | 200k | R6, Z6, A7 IV |
| Pro | 400k | R5, Z8, A7R V |
| Flagship | 500k–800k | A1, R1 |
| Electronic | ∞ (no penalty) | Z9, A9 III |

Depreciation uses a continuous ease-out from **1.0 → floor 0.45** over ~1.8× rated life.

### Stolen serial mock list (demo)

Try these for the red **do not accept** warning:

- `STOLEN999`
- `SN12345678`
- `HOTCAM001`

Matching is case-insensitive. **Not a Police clearance.**

---

## NZ stolen-goods resources

Police **do not** provide a public API to check camera serial numbers. Public “stolen” lookups cover **vehicles** (and boats) only.

### SNAP — offline

| | |
|--|--|
| **Name** | Serial Number Action Partnership (`snap.org.nz`) |
| **Status** | **Decommissioned 15 December 2021** |
| **Notice** | https://www.police.govt.nz/about-site-and-nz-police-app/other-sites/snap-decommissioning |

Do not build production checks against SNAP.

### Other links

| Resource | URL | Notes |
|----------|-----|--------|
| Ecotechnologies knowledge base | https://ecotechnologies.nz/resources/knowledge-base/stolen-goods/ | NZ overview + tools |
| **SeriSafe** | https://serisafe.com/ | Commercial serial registry (ask for API) |
| Stole Me | http://www.stoleme.co.nz/ | May be inactive — verify |
| TCF stolen phones (IMEI) | https://www.tcf.org.nz/consumers/mobile/lost-stolen-phones/check-your-handsets-status/ | Phones only |
| Lost / stolen / found FAQs | https://www.police.govt.nz/faq/questions-by-category/lost-stolen-found-property | Police |
| Why keep serial numbers | https://www.police.govt.nz/faq/it-worth-keeping-serial-numbers-case-property-lost-or-stolen | Police |
| Report stolen (105 Online) | https://www.police.govt.nz/use-105/stolen-property | Include serial |
| Stolen property form | https://webforms.police.govt.nz/en/form/stolen-property | |
| Found property | https://www.police.govt.nz/use-105/found-property | |
| 105 hub | https://www.police.govt.nz/use-105 | Call **105** / emergency **111** |
| Public stolen **vehicles** | https://www.police.govt.nz/can-you-help-us/stolen-vehicles | Not cameras |
| Secondhand dealers (Police) | https://www.police.govt.nz/advice-services/businesses-and-organisations/secondhand-dealers-and-pawnbrokers/secondhand-dealers | Dealer records |

Licensed dealers (Secondhand Dealers and Pawnbrokers Act 2004) must keep records including serials and report goods known or suspected stolen.

**Production path:** wire `STOLEN_API_URL` to a commercial provider (e.g. SeriSafe after contract), keep mock fallback, always support human **105** reporting.

---

## Project layout

```
camera-trade-app/
├── index.html
├── styles.css
├── app.js                      # UI + business logic
├── server-webhooks.example.js  # Express: static, webhooks, proxy, EXIF
├── cloudflare-worker-proxy.js  # CF Worker stolen-check + rate limit
├── tests.js
├── package.json
├── LICENSE                     # MIT
├── .gitignore
└── README.md
```

---

## API (local server)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health + feature flags |
| `POST` | `/api/stolen-check` | `{ "serial": "…" }` → `{ stolen, source, police }` |
| `POST` | `/api/exif-shutter` | `multipart` field `photo` → shutter / model / serial |
| `POST` | `/api/connect/transfer` | Cash transfer; requires header `Idempotency-Key` |
| `POST` | `/webhooks/stripe` | Stripe webhooks (raw body + signature) |

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default `8787`) |
| `STRIPE_SECRET_KEY` | Real Stripe API (optional; sim without it) |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verify |
| `STOLEN_API_URL` | Upstream stolen-gear API |
| `STOLEN_API_KEY` | Bearer token for upstream |

```bash
PORT=8787 \
STOLEN_API_URL=https://example.com/check \
STOLEN_API_KEY=secret \
node server-webhooks.example.js
```

### Cloudflare Worker

```bash
npx wrangler secret put STOLEN_API_URL
npx wrangler secret put STOLEN_API_KEY
npx wrangler deploy cloudflare-worker-proxy.js
```

Then set `STOLEN_CHECK_API.proxyUrl` in `app.js` to your worker URL + `/stolen-check`.

---

## Production checklist

1. **Stripe Connect** — real Express accounts, Connect transfers, live webhooks  
2. **Stolen gear** — commercial DB (e.g. SeriSafe); never rely on SNAP  
3. **ExifTool** — install on the host that serves `/api/exif-shutter`  
4. **HTTPS** — required for production browser APIs and Stripe  
5. **Persist state** — replace LocalStorage with a real database for multi-device stores  

---

## License

This project is licensed under the [MIT License](./LICENSE).

```
Copyright (c) 2026 David Logan
```

## Disclaimer

Demo software only. **Not affiliated with** Photogear, Auckland Camera Centre, Photo Warehouse, NZ Police, SeriSafe, Ecotechnologies, or Stripe. Trade values and stolen checks are simulated unless you wire real APIs and keys. SNAP (`snap.org.nz`) is **decommissioned** and must not be used as a live serial service.
# Camera-Trader
