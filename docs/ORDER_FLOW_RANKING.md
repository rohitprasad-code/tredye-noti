# Order Flow & Setup Score — Concepts, Ranking Logic, and Formulas

This document explains **what each indicator means**, **why traders care**, **how stocks are ranked** across the Order Block Terminal (`/app/orderblock`) and Alert Desk (`/`), and the **exact formulas** implemented in the codebase.

---

## 1. Core Order-Flow Concepts (What It Is & Why Traders Care)

### VWAP — Volume Weighted Average Price
- **What it is:** The average price a stock has traded at during the session, weighted by traded volume at each price.
- **Why traders care:** Institutional desks benchmark fills against VWAP.
  - **`LTP > VWAP` (Bullish):** Average intraday buyers are in profit; buyers control the tape.
  - **`LTP < VWAP` (Bearish):** Average intraday buyers are underwater; sellers control the tape.

### POC — Point of Control
- **What it is:** The single price level where the highest volume traded today (the peak of the Volume Profile).
- **Why traders care:** Represents the main institutional battleground / fair-value magnet.
  - **`LTP > POC` (Bullish):** Buyers won the highest-volume zone and pushed price above it (POC often acts as support on retests).
  - **`LTP < POC` (Bearish):** Sellers won the highest-volume zone and pushed price below it (POC often acts as resistance on bounces).

### CVD — Cumulative Volume Delta
- **What it is:** Running intraday total of aggressive buying volume minus aggressive selling volume.
  - Aggressive market buys (lifting the ask) add to CVD (`+`).
  - Aggressive market sells (hitting the bid) subtract from CVD (`-`).
- **Why traders care:** Shows whether real money is actively chasing price up or dumping down rather than price drifting on thin volume.
  - **`CVD > 0`:** Net aggressive buyers are ahead.
  - **`CVD < 0`:** Net aggressive sellers are ahead.
- **Rupee Flow (₹ Cr):** Converts share CVD into institutional rupee turnover:
  ```text
  rupeeFlowCr = (cvd * ltp) / 1e7
  ```

### Buy% & Order-Book Imbalance (`imb`)
- **What it is:**
  - **`Buy%`:** Share of **traded** volume where the buyer was the aggressor (`> 50%` favors buyers; `< 50%` favors sellers). Comes from Tredye, or — in `UPSTOX_LIVE` mode, once at least 20 tick updates have been classified — from `src/engine/aggressor.js`, which classifies each WebSocket volume increment by the prevailing quote (at/above prior ask = buy, at/below prior bid = sell, else vs mid) with a tick-rule fallback. It is **never** derived from resting book totals: `tbq / (tbq + tsq)` is the same information as `imb` and would count the order book twice. That ratio is still exposed as `bookBuyPct` for display only; `buyPctSource` says where `buyPct` came from.
  - **Order-Book Imbalance (`imb`):** Net percentage skew between total buy quantity (`tbq`) and total sell quantity (`tsq`) in the order book:
    ```text
    imb = ((tbq - tsq) / (tbq + tsq)) * 100
    ```
- **Why traders care:** Shows whether resting liquidity on the book supports continuation in the flow direction (`imb > 0` for bulls, `imb < 0` for bears).

### Order Blocks (OB)
- **What it is:** Institutional supply/demand origin zones detected from intraday candles (`src/engine/orderblocks.js`):
  - **Bullish OB (Buy Zone):** Last down candle (`close < open`) before a 1–3 candle impulse move whose max close breaks above the prior 7-candle high by at least `1.8 * avgCandleRange` from the OB candle's low. `avgCandleRange` is the **trailing** average of the 14 candles before the OB candle (no lookahead — later candles can't change an already-detected block).
  - **Bearish OB (Sell Zone):** Last up candle (`close > open`) before a 1–3 candle impulse move whose min close breaks below the prior 7-candle low by at least `1.8 * avgCandleRange` from the OB candle's high.
- **Why traders care:** Provides concrete pullback entry zones (`bot–top`) and invalidation levels instead of chasing extended breakouts.
  - **`IN_ZONE`:** Price is currently trading inside the aligned OB (`distPct === 0`).
  - **`UNTESTED`:** Price broke away and has not revisited the OB yet.
  - **`RETESTED_HELD`:** Price touched the OB and held without closing past the invalidation edge.
  - **`MITIGATED`:** Price closed beyond the OB invalidation edge (no longer valid).

---

## 2. How It Ranks: Logic

### Step 1: 5-Signal Confluence Check (`src/engine/flow.js`)
Every stock is evaluated on up to 5 directional checks (`evaluateConfluence`):

| # | Check | Bullish | Bearish | Neutral band (`NEUTRAL_BANDS`) |
| :-: | :--- | :--- | :--- | :--- |
| 1 | **VWAP** | `ltp > vwap` | `ltp < vwap` | within ±0.03% of VWAP |
| 2 | **POC** | `ltp > poc` | `ltp < poc` | within ±0.03% of POC |
| 3 | **Buy%** (trade-side) | `buy_pct > 50` | `buy_pct < 50` | 49–51 |
| 4 | **CVD** | `cvd > 0` | `cvd < 0` | `|cvd|` ≤ 0.1% of session volume (exactly 0 if volume unknown) |
| 5 | **Book Imbalance** *(or Net Flow fallback)* | `imb > 0` | `imb < 0` | within ±2% |

- A check inside its neutral band counts for **neither** side (it still counts in `n`, so it lowers `agree / n`).
- A check whose input is missing is **dropped** (previously it silently counted as bearish).
- `score = bullCount - bearCount`
- `side = score > 0 ? 'BULL' : score < 0 ? 'BEAR' : 'FLAT'`
- `agree` = number of checks agreeing with `side` (displayed as pips beside the ring on `/app/orderblock` cards; the pip count follows `n`).

> **Imbalance source priority (`getDepthImbalance`):**
> 1. `stock.imb` (populated live by Upstox quotes/WebSocket ticks when `tbq + tsq > 0`)
> 2. `stock.depth.imb` or `(depth.tbq - depth.tsq) / (depth.tbq + depth.tsq) * 100`
> 3. Sum of `depth.buy` vs `depth.sell` level quantities if `tbq`/`tsq` are absent
> 4. Fallback to `stock.flowScore` or `stock.chg_pct` only when no depth data is available.

---

### Step 2: Three Sort Modes in `/app/orderblock` (`src/index.js`)

- **Max Gains (default)** — *"Which stocks moved the most in `%` today?"*
  - **How it ranks:** Purely by `|chgPct|` descending (uses `strengthScore` and directional flow only for exact ties).
- **Setup Score** — *"Which stocks are the best overall setups right now?"*
  - **How it ranks:** Combines all three things you look at before taking a trade:
    1. **Order flow quality** (most weight — 60%)
    2. **Price momentum** (how strong today's move is — 20%)
    3. **Order Block proximity** (bonus points if price is inside or close to a valid Buy/Sell Order Block zone — 20%)
- **Strongest Flow** — *"Which stocks have the cleanest institutional order flow?"*
  - **How it ranks:** Puts `5/5` confluence stocks first, then ranks by `strengthScore`, even if the `%` move is still small.

| Sort Mode | Question It Answers | Ranking Order & Tie-Breakers | Ring Badge Value |
| :--- | :--- | :--- | :--- |
| **`Max Gains`** *(default, `MAX_GAINS`)* | *"Which stocks moved the most in `%` today?"* | 1. `|chgPct|` (desc)<br>2. `strengthScore` (desc)<br>3. Directional `rupeeFlowCr` (desc) | `strengthScore` (`0–100`) |
| **`Setup Score`** (`SETUP_SCORE`) | *"Which stocks have the best complete trade setups right now?"* | 1. `setupScore` (desc)<br>2. `agree` count (desc)<br>3. `strengthScore` (desc)<br>4. Directional `rupeeFlowCr` (desc)<br>5. `|chgPct|` (desc) | `setupScore` (`0–100`) |
| **`Strongest Flow`** (`FLOW_SCORE`) | *"Which stocks have the cleanest institutional order flow?"* | 1. `agree` count (desc)<br>2. `strengthScore` (desc)<br>3. Directional `rupeeFlowCr` (desc)<br>4. `|chgPct|` (desc) | `strengthScore` (`0–100`) |

> **Alert Desk (`/`):** The main Alert Desk ranks `topBull` and `topBear` using the same rule as **`Strongest Flow`**: `agree` desc -> `strengthScore` desc -> directional `%` change desc.

### Card Placement in `/app/orderblock` (`src/server/public/orderblock.html`)
- **Top 3 Hero Cards (Right column):** Top 3 ranked stocks per side, capped at **max 2 stocks per sector** (`pickSide()`).
- **Mosaic Columns (Middle grid):** Ranks #4+ fill the columns next to the hero cards.

---

## 3. Exact Scoring Formulas

### A. Flow Strength Score (`0–100`, `scoreAndRankUniverse` in `src/engine/flow.js`)

For a stock with direction `dir` (`+1` for `BULL`, `-1` for `BEAR`, `0` for `FLAT`).
Every component is scaled by the **90th percentile across the universe right now** (`P90`), with a floor so a dead tape can't award full points to tiny edges. Scores are therefore relative: 100 means "as strong as the strongest ~10% of F&O stocks this poll".

```text
strengthScore = confluencePts + buyDominancePts + cvdPts + depthPts + vwapPts
```
*(If `dir === 0`, `strengthScore = round(confluencePts)`.)*

1. **Confluence (`0–40` pts):**
   ```text
   confluencePts = (agree / n) * 40
   ```
2. **Buy/Sell Dominance (`0–20` pts):**
   ```text
   signedBuyEdge   = (buy_pct - 50) * dir
   buyDominancePts = clamp(signedBuyEdge / max(5, P90(|buy_pct - 50|)), 0, 1) * 20
   ```
3. **Normalized Rupee CVD (`0–15` pts):**
   Let `p90FlowCr` be the 90th percentile of `|rupeeFlowCr|` across all stocks in the universe:
   ```text
   signedFlowCr = rupeeFlowCr * dir
   cvdPts       = clamp(signedFlowCr / p90FlowCr, 0, 1) * 15
   ```
4. **Order-Book Depth Imbalance (`0–10` pts):**
   Normalize `imb` to `-100..100` (`normImb = |imb| <= 1 ? imb * 100 : imb`):
   ```text
   depthPts = (imb !== null ? clamp((normImb * dir) / max(10, P90(|normImb|)), 0, 1) : 0.5) * 10
   ```
5. **VWAP Impulse (`0–15` pts):**
   ```text
   vwapPct  = ((ltp - vwap) / vwap) * 100
   atrPct   = avg (high - low) / close * 100 of the stock's last 14 intraday candles
   vwapAtr  = vwapPct / atrPct                         # distance in the stock's own volatility units
   vwapPts  = clamp(vwapAtr * dir / max(0.5, P90(|vwapAtr|)), 0, 1) * 15
   # stocks without candles yet: clamp(vwapPct * dir / max(0.25, P90(|vwapPct|)), 0, 1) * 15
   ```

---

### B. Setup Score (`0–100`, `computeSetupScore` in `src/index.js`)

Combines **60% Flow Strength**, **20% Price Momentum**, and **20% Aligned Order Block Proximity**:

```text
setupScore = round1(flowPts + momPts + obPts)
```

1. **Flow Points (`0–60` pts):**
   ```text
   flowPts = clamp(strengthScore, 0, 100) * 0.6
   ```
2. **Momentum Points (`0–20` pts):**
   ```text
   momPts = min(1, |chgPct| / 5) * 20
   ```
   *(Scales linearly from `0%` -> `0` pts up to `5%+` -> `20` pts.)*
3. **Aligned Order Block Proximity Points (`0–20` pts):**
   Evaluates the best **unmitigated, non-invalidated** OB matching the stock's side (Bullish OB for bulls, Bearish OB for bears):
   - **`20` pts:** `status === 'IN_ZONE'` or `distPct === 0`
   - **`17` pts:** `status === 'RETESTED_HELD'` and `distPct <= 0.5%`
   - **`15` pts:** active OB with `distPct <= 0.5%`
   - **`10` pts:** active OB with `distPct <= 1.5%`
   - **`5` pts:** active OB with `distPct > 1.5%`
   - **`0` pts:** no active aligned OB (none found or already mitigated/invalidated)

---

## 4. Measuring Whether It Works — Edge Report (`/app/edge`)

Every alert fired on **live** data (Tredye or Upstox; demo replays are excluded) gets an outcome row in `alert_outcomes`, advanced on each poll by `src/engine/outcomes.js`:

| Field | Meaning (all % are directional: positive = moved the way the alert pointed) |
| :--- | :--- |
| `ret_5m` / `ret_15m` / `ret_30m` / `ret_60m` | Move N minutes after the alert (live LTP if the poll was on time, else the candle that had closed by then; left empty rather than guessed) |
| `ret_close` | Move to the 15:30 close |
| `mfe_pct` / `mae_pct` | Best / worst excursion before the close (only candles that started after the alert) |
| `t1_hit_at` / `t2_hit_at` / `stop_hit_at`, `first_hit` | Which reference level traded first. Same candle → counted as `STOP`. Levels already on the wrong side of entry are ignored. |

`GET /api/edge-report?days=30` groups these by agree count, OB status, strength bucket, time of day, alert type, side and sector. Groups with fewer than 20 alerts are faded in the UI — treat them as anecdotes. Use this to tune `minAgree`, `obProximityPct` and the score weights instead of guessing.

---

## 5. Source Files
- Flow confluence & Strength Score: `src/engine/flow.js`
- Order Block detection & proximity: `src/engine/orderblocks.js`
- Setup Score, sort comparators & snapshot API: `src/index.js`
- Snapshot route (`/api/ob/live/snapshot`): `src/server/server.js`
- Order Block Terminal UI: `src/server/public/orderblock.html`
- Trade-side Buy% classifier: `src/engine/aggressor.js`
- Alert outcomes & edge report: `src/engine/outcomes.js`, `src/server/public/edge.html`
- Unit tests: `test/engine.test.js`, `test/fixes.test.js`
