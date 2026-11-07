# Tredye Flow Alerts — Order-Flow & Order-Block Reminder Desk

A local service and live dashboard for macOS that monitors **Tredye Order Flow** (`https://www.tredye.com/pulse/?view=orderflow`) during NSE market hours (`09:15–15:30 IST`), ranks the **strongest Bullish (BUY) and Bearish (SELL) flows**, locates the matching **Order Block (`₹bot–top`)** for each stock, and sends you **review reminder notifications** (macOS desktop + optional Telegram + live browser dashboard).

> **Manual Review Only:** This system never places orders. Every notification is a reminder prompt so you can inspect the Order Flow & Order Block yourself and decide whether the buy or sell setup is valid.

---

## Quick Start

```bash
# 1. Start the local service & dashboard (http://localhost:4600)
npm start

# 2. Run unit tests
npm test

# 3. Run a single CLI dry-run summary
npm run dry-run
```

Then open **http://localhost:4600** in your browser.

---

## Connecting Your Live Tredye Account

Tredye's `/api/orderflow` and `/api/orderflow/p{sh}` endpoints require an authenticated session cookie. You can connect in either of two ways:

1. **Via the Dashboard UI:** Click **🔑 Tredye Login** in the top bar (or **Connect Tredye Account** on the banner) and enter:
   - Your Tredye **Email & Password**, **OR**
   - Your browser's **`Cookie` header** from Chrome DevTools (`Network` → `/api/orderflow` → `Cookie`), which also works if you sign in via Google.
2. **Via `.env`:** Copy `.env.example` to `.env` and fill in `TREDYE_EMAIL` + `TREDYE_PASSWORD` (or `TREDYE_COOKIE`).

Until credentials are provided, the dashboard automatically loads a **realistic NSE Sample Replay** (`RELIANCE`, `ICICIBANK`, `BHARTIARTL`, `TATAMOTORS`, `INFY`, `TCS`, etc.) so you can explore the Order Block zones, candlestick chart, and reminder timers immediately.

---

## How Flow & Order Blocks Are Computed

1. **Tredye Confluence Score (`sI()` port):**
   Checks 5 signals for every stock:
   - `LTP > VWAP`
   - `LTP > POC` (Point of Control)
   - `Aggressive Buy % > 50%`
   - `Cumulative Volume Delta (CVD) > 0`
   - `Order-Book Depth Imbalance > 0`
2. **Composite Strength Score (0–100):**
   Weights confluence agreement (40%), aggressive buy/sell dominance (20%), normalized rupee CVD flow `cvd * ltp / 1e7` (15%), depth imbalance (10%), and VWAP extension (15%) to rank the **Top-N Bullish (BUY)** and **Top-N Bearish (SELL)** stocks.
3. **Order Block Detection (`sp()` port + Actionable Locator):**
   - **Bullish OB (Buy Zone):** Last down candle (`close < open`) before a strong upward impulse (`>= 1.8×` average candle range) that breaks the recent 7-candle high.
   - **Bearish OB (Sell Zone):** Last up candle (`close > open`) before a strong downward impulse (`>= 1.8×` average candle range) that breaks the recent 7-candle low.
   - Computes exact zone (`₹bot–₹top`), distance %, status (`IN_ZONE`, `UNTESTED`, `RETESTED_HELD`, `MITIGATED`), reference invalidation level, and `R1/R2` or `S1/S2` targets.

---

## Alert & Reminder Types

- **🎯 `IN_ZONE` (High Priority):** Strong flow (`>= 4/5`) and price is currently trading *inside* the aligned Buy or Sell Order Block.
- **⚡ `APPROACHING_OB`:** Strong flow (`>= 4/5`) and price is within `0.5%` (configurable) of an unmitigated aligned Order Block.
- **🟢/🔴 `NEW_STRONG_FLOW`:** A stock enters the Top-N with `>= 4/5` agreement for 2 consecutive polls, reported with its nearest Order Block zone.
- **⚠️ `FLOW_FLIP`:** A previously alerted stock flips from Bullish to Bearish (or vice versa), warning that the earlier setup is invalidated.
- **⏰ `REMINDER_DUE`:** Triggered when your **Remind me in 5 / 15 / 30 min** timer expires; re-evaluates fresh data and tells you whether the setup **STILL HOLDS ✅**, is **NOW IN OB ZONE 🎯**, or **FLIPPED ❌**.

