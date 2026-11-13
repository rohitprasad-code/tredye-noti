# Tredye Flow Alerts — Order Block & Order-Flow Terminal

A local Node.js service and real-time **Order Block Terminal** (`http://localhost:4600`) that monitors **218 NSE F&O stocks** during NSE market hours (`09:15–15:30 IST`), blends **Tredye Order Flow** (`cvd`, `poc`, `buildup`, 3m profiles) with **Upstox live quotes, depth, intraday candles & WebSocket V3 ticks**, and detects actionable **Order Blocks (`₹bot–top`)**.

> **Manual Review Only:** This system never places orders. Every signal and alert is for manual inspection so you can evaluate the Order Flow & Order Block setup yourself.

---

## Quick Start

```bash
# 1. Start the local service & Order Block Terminal (http://localhost:4600)
npm start

# 2. Run unit tests (9 tests)
npm test

# 3. Run a single CLI dry-run summary
npm run dry-run

# 4. Run with sample data only (no credentials required)
npm run demo
```

Then open **http://localhost:4600** in your browser.

---

## Pages & Navigation

- **`/` or `/app/orderblock` — Order Block Terminal:** Live 218-stock flow funnel, sector & side filters (`All`, `Bullish`, `Bearish`), 3 sort modes, 15m/5m candlestick & Order Block cards, and dark/light theme toggle.
- **`/app/settings` (or `/settings`) — Settings:** Accessible from the bottom **⚙ Settings** icon in the left sidebar. Configure **Upstox API** credentials & OAuth login plus **Terminal Rules** (poll interval, Top-N, min confluence signals, OB proximity %, confirm polls, min price, watchlist, and ignore list).

---

## Connecting Live Data (Upstox + Tredye)

### 1. Upstox Real-Time Quotes, Depth & WebSocket V3
1. Open **http://localhost:4600/app/settings** (or click **⚙** at the bottom of the left sidebar).
2. In the [Upstox Developer Console](https://account.upstox.com/developer/apps/createapp), set your app's **Redirect URL** to:
   ```text
   http://localhost:4600/api/upstox/callback
   ```
3. Paste your **API Key** and **API Secret** on `/app/settings` and click **Save & Login with Upstox** (keys are saved locally in `.env`).

### 2. Tredye Session (`.env`)
Copy `.env.example` to `.env` and set `TREDYE_EMAIL` + `TREDYE_PASSWORD` (or `TREDYE_COOKIE` from Chrome DevTools `Network` → `/api/orderflow` → `Cookie`).

Without live credentials, the app falls back to a built-in **NSE Sample Replay** (`RELIANCE`, `ICICIBANK`, `BHARTIARTL`, `TATAMOTORS`, `INFY`, `TCS`, etc.).

---

## Ranking Modes, Flow Scoring & Order Blocks

For full formulas and examples, see [docs/ORDER_FLOW_RANKING.md](docs/ORDER_FLOW_RANKING.md).

1. **5-Signal Confluence Check (`src/engine/flow.js`):**
   - `LTP > VWAP`
   - `LTP > POC` (Point of Control)
   - `Buy% > 50%`
   - `CVD > 0` (Cumulative Volume Delta)
   - `Book Imbalance > 0` (live Upstox `tbq`/`tsq` or `depth` levels)
2. **Strength Score (`0–100`):**
   Weights confluence agreement (`40%`), buy/sell dominance (`20%`), P90-normalized rupee CVD (`15%`), order-book imbalance (`10%`), and VWAP extension (`15%`).
3. **Setup Score (`0–100`):**
   Combines **60% Flow Strength**, **20% Price Momentum** (`|chgPct|` up to 5%), and **20% Aligned Order Block Proximity** (`IN_ZONE` = 20, `RETESTED_HELD <= 0.5%` = 17, `UNTESTED <= 0.5%` = 15, `<= 1.5%` = 10, active = 5).
4. **Terminal Sort Modes (`/app/orderblock`):**
   - **`Max Gains (Bulls & Bears)`** *(default)* — Pure `|chgPct|` descending (ties broken by `strengthScore` and directional flow).
   - **`Setup Score (Flow + OB)`** — Ranks by `setupScore` (`0–100`).
   - **`Strongest Flow`** — Ranks by `agree` count (`5/5` first) then `strengthScore`.
5. **Order Block Detection (`src/engine/orderblocks.js`):**
   - **Bullish OB (Buy Zone):** Last down candle (`close < open`) before a 1–3 candle impulse (`>= 1.8×` average candle range) breaking the prior 7-candle high.
   - **Bearish OB (Sell Zone):** Last up candle (`close > open`) before a 1–3 candle impulse (`>= 1.8×` average candle range) breaking the prior 7-candle low.

---

## Background Alert Types

- **🎯 `IN_ZONE`:** Strong flow (`>= minAgree`) while price trades inside an aligned Order Block.
- **⚡ `APPROACHING_OB`:** Strong flow (`>= minAgree`) within `obProximityPct` (`0.5%` default) of an active aligned Order Block.
- **🟢/🔴 `NEW_STRONG_FLOW`:** Sustained Top-N flow across `confirmPolls` consecutive polls.
- **⚠️ `FLOW_FLIP`:** Previously alerted symbol flips to strong opposing flow.
- **⏰ `REMINDER_DUE`:** Re-evaluates scheduled reminder timers (`STILL HOLDS ✅`, `NOW IN OB ZONE 🎯`, or `FLIPPED ❌`).
