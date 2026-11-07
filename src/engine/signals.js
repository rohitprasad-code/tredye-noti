'use strict';

function fmtPrice(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Stateful signal & reminder evaluator.
 *
 * Tracks across polls:
 *   - consecutive polls a symbol has stayed in Top-N with >= minAgree (`streakBySymbol`)
 *   - last known strong side for watched/alerted symbols (`watchedSideBySymbol`)
 *   - per-(symbol, type) cooldown timestamps (`cooldowns` Map or DB lookup)
 */
class SignalEngine {
  constructor(options = {}) {
    this.streakBySymbol = new Map();       // symbol -> { side, count, firstSeenAt }
    this.watchedSideBySymbol = new Map();  // symbol -> { side, agree, obZone, updatedAt }
    this.cooldowns = new Map();            // `${symbol}:${type}` -> timestamp ms
    this.openSummarySentForDate = null;
    this.db = options.db || null;
  }

  isCoolingDown(symbol, type, cooldownMinutes, nowMs = Date.now()) {
    const key = `${symbol}:${type}`;
    const lastMemory = this.cooldowns.get(key) || 0;
    const cooldownMs = (cooldownMinutes ?? 20) * 60 * 1000;
    if (nowMs - lastMemory < cooldownMs) return true;
    if (this.db && typeof this.db.getLastAlertTime === 'function') {
      const lastDb = this.db.getLastAlertTime(symbol, type);
      if (lastDb && nowMs - lastDb < cooldownMs) {
        this.cooldowns.set(key, lastDb);
        return true;
      }
    }
    return false;
  }

  markFired(symbol, type, nowMs = Date.now()) {
    this.cooldowns.set(`${symbol}:${type}`, nowMs);
  }

  isSnoozed(symbol, nowMs = Date.now()) {
    if (!this.db || typeof this.db.isSymbolSnoozed !== 'function') return false;
    return this.db.isSymbolSnoozed(symbol, nowMs);
  }

  /**
   * Evaluates a full poll cycle and returns new alerts to fire.
   *
   * @param {Object} cycleData
   * @param {Array}  cycleData.candidates - Enriched top candidates `[{ stock, flow, obInfo }]`
   * @param {Object} cycleData.bySymbol   - Map of `symbol -> flow` for all stocks
   * @param {Map}    cycleData.stocksBySymbol - Map of `symbol -> stock`
   * @param {Map}    cycleData.obBySymbol - Map of `symbol -> obInfo`
   * @param {Object} config
   * @param {number} nowMs
   */
  evaluatePoll(cycleData, config = {}, nowMs = Date.now()) {
    const {
      candidates = [],
      bySymbol = {},
      stocksBySymbol = new Map(),
      obBySymbol = new Map(),
    } = cycleData;

    const minAgree = config.minAgree ?? 4;
    const confirmPolls = config.confirmPolls ?? 2;
    const obProximityPct = config.obProximityPct ?? 0.5;
    const cooldownMinutes = config.cooldownMinutes ?? 20;

    const alerts = [];
    const currentTopSymbols = new Set();

    for (const item of candidates) {
      const { stock, flow, obInfo } = item;
      const sym = stock.symbol;
      currentTopSymbols.add(sym);

      if (this.isSnoozed(sym, nowMs)) continue;

      // Update consecutive strong-flow streak
      const prevStreak = this.streakBySymbol.get(sym);
      let streakCount = 1;
      if (prevStreak && prevStreak.side === flow.side && flow.agree >= minAgree) {
        streakCount = prevStreak.count + 1;
      } else if (flow.agree < minAgree) {
        streakCount = 0;
      }
      this.streakBySymbol.set(sym, {
        side: flow.side,
        count: streakCount,
        firstSeenAt: prevStreak?.firstSeenAt || nowMs,
      });

      const primaryOB = obInfo?.primaryOB;
      const plan = obInfo?.referencePlan;
      const actionVerb = flow.side === 'BULL' ? 'BUY' : 'SELL';
      const obTypeLabel = flow.side === 'BULL' ? 'Bullish OB' : 'Bearish OB';

      // 1. IN_ZONE alert (highest priority: price is currently inside aligned OB with strong flow)
      if (
        flow.agree >= minAgree &&
        primaryOB &&
        primaryOB.status === 'IN_ZONE' &&
        !this.isCoolingDown(sym, 'IN_ZONE', cooldownMinutes, nowMs)
      ) {
        const title = `🎯 ${sym} — IN ${actionVerb} ORDER BLOCK (${flow.agree}/${flow.n} ${flow.side})`;
        const message =
          `${sym} (${fmtPrice(stock.ltp)}, ${stock.chg_pct >= 0 ? '+' : ''}${Number(stock.chg_pct || 0).toFixed(2)}%) is trading INSIDE the ${obTypeLabel} ${plan.zoneText} ` +
          `(${primaryOB.str}× impulse, ${primaryOB.timeIST}). Flow: ${flow.agree}/${flow.n} ${flow.side} · Buy ${Math.round(stock.buy_pct)}% · CVD ${flow.rupeeFlowCr >= 0 ? '+' : ''}${flow.rupeeFlowCr.toFixed(2)} Cr. ` +
          `Ref invalidation: ${fmtPrice(plan.invalidation)}${plan.target1 ? ` · Ref T1: ${fmtPrice(plan.target1)}` : ''}. Review setup manually.`;

        alerts.push({
          symbol: sym,
          type: 'IN_ZONE',
          priority: 'HIGH',
          side: flow.side,
          action: actionVerb,
          title,
          message,
          ltp: stock.ltp,
          chgPct: stock.chg_pct,
          agree: flow.agree,
          totalChecks: flow.n,
          strengthScore: flow.strengthScore,
          obBot: primaryOB.bot,
          obTop: primaryOB.top,
          obDistPct: 0,
          obStr: primaryOB.str,
          obStatus: primaryOB.status,
          invalidation: plan?.invalidation ?? null,
          target1: plan?.target1 ?? null,
          target2: plan?.target2 ?? null,
          createdAt: nowMs,
        });
        this.markFired(sym, 'IN_ZONE', nowMs);
        this.watchedSideBySymbol.set(sym, { side: flow.side, agree: flow.agree, obZone: plan?.zoneText, updatedAt: nowMs });
        continue;
      }

      // 2. APPROACHING_OB alert (aligned strong flow + within obProximityPct of aligned OB)
      if (
        flow.agree >= minAgree &&
        primaryOB &&
        (primaryOB.status === 'UNTESTED' || primaryOB.status === 'RETESTED_HELD') &&
        primaryOB.distPct !== null &&
        primaryOB.distPct > 0 &&
        primaryOB.distPct <= obProximityPct &&
        !this.isCoolingDown(sym, 'APPROACHING_OB', cooldownMinutes, nowMs)
      ) {
        const dirWord = flow.side === 'BULL' ? 'above' : 'below';
        const title = `⚡ ${sym} — ${primaryOB.distPct.toFixed(2)}% from ${actionVerb} OB (${flow.agree}/${flow.n} ${flow.side})`;
        const message =
          `${sym} (${fmtPrice(stock.ltp)}) is ${primaryOB.distPct.toFixed(2)}% ${dirWord} ${primaryOB.status === 'UNTESTED' ? 'untested' : 'active'} ${obTypeLabel} ${plan.zoneText} (${primaryOB.str}×). ` +
          `Strong ${flow.side} flow (${flow.agree}/${flow.n}, score ${flow.strengthScore}/100, Buy ${Math.round(stock.buy_pct)}%). ` +
          `Ref invalidation: ${fmtPrice(plan.invalidation)}${plan.target1 ? ` · Ref T1: ${fmtPrice(plan.target1)}` : ''}. Review for potential ${actionVerb.toLowerCase()} entry.`;

        alerts.push({
          symbol: sym,
          type: 'APPROACHING_OB',
          priority: 'MEDIUM',
          side: flow.side,
          action: actionVerb,
          title,
          message,
          ltp: stock.ltp,
          chgPct: stock.chg_pct,
          agree: flow.agree,
          totalChecks: flow.n,
          strengthScore: flow.strengthScore,
          obBot: primaryOB.bot,
          obTop: primaryOB.top,
          obDistPct: primaryOB.distPct,
          obStr: primaryOB.str,
          obStatus: primaryOB.status,
          invalidation: plan?.invalidation ?? null,
          target1: plan?.target1 ?? null,
          target2: plan?.target2 ?? null,
          createdAt: nowMs,
        });
        this.markFired(sym, 'APPROACHING_OB', nowMs);
        this.watchedSideBySymbol.set(sym, { side: flow.side, agree: flow.agree, obZone: plan?.zoneText, updatedAt: nowMs });
      }

      // 3. NEW_STRONG_FLOW alert (confirmed across `confirmPolls` consecutive polls in Top-N)
      if (
        flow.agree >= minAgree &&
        streakCount >= confirmPolls &&
        !this.isCoolingDown(sym, 'NEW_STRONG_FLOW', cooldownMinutes, nowMs)
      ) {
        const obSnippet = primaryOB
          ? `${obTypeLabel}: ${plan.zoneText} (${primaryOB.distPct === 0 ? 'IN ZONE' : `${primaryOB.distPct.toFixed(2)}% away`}, ${primaryOB.str}×)`
          : plan?.zoneText
          ? `${obTypeLabel}: ${plan.zoneText}`
          : 'No unmitigated OB in current session yet';

        const title = `${flow.side === 'BULL' ? '🟢' : '🔴'} ${sym} — Top ${flow.side} Flow #${flow.rank} (${flow.agree}/${flow.n})`;
        const message =
          `${sym} (${fmtPrice(stock.ltp)}, ${stock.chg_pct >= 0 ? '+' : ''}${Number(stock.chg_pct || 0).toFixed(2)}%) has held strong ${flow.side} flow (${flow.agree}/${flow.n} signals, strength ${flow.strengthScore}/100, Buy ${Math.round(stock.buy_pct)}%, CVD ${flow.rupeeFlowCr >= 0 ? '+' : ''}${flow.rupeeFlowCr.toFixed(2)} Cr). ` +
          `${obSnippet}. Review on Tredye.`;

        alerts.push({
          symbol: sym,
          type: 'NEW_STRONG_FLOW',
          priority: 'NORMAL',
          side: flow.side,
          action: actionVerb,
          title,
          message,
          ltp: stock.ltp,
          chgPct: stock.chg_pct,
          agree: flow.agree,
          totalChecks: flow.n,
          strengthScore: flow.strengthScore,
          obBot: primaryOB?.bot ?? null,
          obTop: primaryOB?.top ?? null,
          obDistPct: primaryOB?.distPct ?? stock.ob?.near ?? null,
          obStr: primaryOB?.str ?? stock.ob?.str ?? null,
          obStatus: primaryOB?.status ?? null,
          invalidation: plan?.invalidation ?? null,
          target1: plan?.target1 ?? null,
          target2: plan?.target2 ?? null,
          createdAt: nowMs,
        });
        this.markFired(sym, 'NEW_STRONG_FLOW', nowMs);
        this.watchedSideBySymbol.set(sym, { side: flow.side, agree: flow.agree, obZone: plan?.zoneText, updatedAt: nowMs });
      }
    }

    // Decay streaks for symbols no longer in candidates
    for (const [sym, st] of this.streakBySymbol.entries()) {
      if (!currentTopSymbols.has(sym)) {
        const curFlow = bySymbol[sym];
        if (!curFlow || curFlow.side !== st.side || curFlow.agree < minAgree) {
          this.streakBySymbol.delete(sym);
        }
      }
    }

    // 4. FLOW_FLIP check for previously watched/alerted symbols
    for (const [sym, watched] of this.watchedSideBySymbol.entries()) {
      if (this.isSnoozed(sym, nowMs)) continue;
      const curFlow = bySymbol[sym];
      const stock = stocksBySymbol.get(sym);
      if (!curFlow || !stock) continue;

      const flipped =
        (watched.side === 'BULL' && curFlow.side === 'BEAR' && curFlow.agree >= minAgree) ||
        (watched.side === 'BEAR' && curFlow.side === 'BULL' && curFlow.agree >= minAgree);

      if (flipped && !this.isCoolingDown(sym, 'FLOW_FLIP', cooldownMinutes, nowMs)) {
        const title = `⚠️ ${sym} — Flow Flipped ${watched.side} → ${curFlow.side} (${curFlow.agree}/${curFlow.n})`;
        const message =
          `${sym} (${fmtPrice(stock.ltp)}) flipped from ${watched.side} to ${curFlow.side} (${curFlow.agree}/${curFlow.n} signals, Buy ${Math.round(stock.buy_pct)}%). ` +
          `Earlier ${watched.side === 'BULL' ? 'BUY' : 'SELL'} setup${watched.obZone ? ` at ${watched.obZone}` : ''} is invalidated.`;

        alerts.push({
          symbol: sym,
          type: 'FLOW_FLIP',
          priority: 'HIGH',
          side: curFlow.side,
          action: 'REVIEW / INVALIDATED',
          title,
          message,
          ltp: stock.ltp,
          chgPct: stock.chg_pct,
          agree: curFlow.agree,
          totalChecks: curFlow.n,
          strengthScore: curFlow.strengthScore,
          obBot: null,
          obTop: null,
          obDistPct: null,
          obStr: null,
          obStatus: 'FLIPPED',
          invalidation: null,
          target1: null,
          target2: null,
          createdAt: nowMs,
        });
        this.markFired(sym, 'FLOW_FLIP', nowMs);
        this.watchedSideBySymbol.set(sym, { side: curFlow.side, agree: curFlow.agree, obZone: null, updatedAt: nowMs });
      }
    }

    return alerts;
  }

  /**
   * Evaluates due user-scheduled reminders against fresh live flow + OB data.
   */
  evaluateDueReminders(dueReminders = [], cycleData, nowMs = Date.now()) {
    const { bySymbol = {}, stocksBySymbol = new Map(), obBySymbol = new Map() } = cycleData;
    const reminderAlerts = [];

    for (const rem of dueReminders) {
      const sym = rem.symbol;
      const stock = stocksBySymbol.get(sym);
      const flow = bySymbol[sym];
      const obInfo = obBySymbol.get(sym);

      if (!stock || !flow) {
        reminderAlerts.push({
          reminderId: rem.id,
          symbol: sym,
          type: 'REMINDER_DUE',
          priority: 'HIGH',
          side: rem.expectedSide || 'FLAT',
          action: 'REMINDER',
          title: `⏰ Reminder: ${sym} — Check Tredye Order Flow`,
          message: `Scheduled reminder for ${sym}${rem.note ? ` (${rem.note})` : ''}. Open dashboard to inspect latest candles.`,
          ltp: null,
          chgPct: null,
          agree: null,
          totalChecks: null,
          strengthScore: null,
          createdAt: nowMs,
        });
        continue;
      }

      const primaryOB = obInfo?.primaryOB;
      const plan = obInfo?.referencePlan;
      const expectedSide = rem.expectedSide || flow.side;
      const sameSide = flow.side === expectedSide && flow.agree >= 3;
      const actionVerb = flow.side === 'BULL' ? 'BUY' : flow.side === 'BEAR' ? 'SELL' : 'WAIT';

      let verdict = 'STILL HOLDS ✅';
      if (flow.side !== expectedSide) {
        verdict = `FLOW FLIPPED TO ${flow.side} ❌`;
      } else if (primaryOB?.status === 'IN_ZONE') {
        verdict = `NOW IN ${actionVerb} OB ZONE 🎯`;
      } else if (flow.agree < 4) {
        verdict = `FLOW WEAKENED (${flow.agree}/${flow.n}) ⚠️`;
      }

      const obPart = primaryOB
        ? `OB ${plan.zoneText} (${primaryOB.distPct === 0 ? 'IN ZONE' : `${primaryOB.distPct.toFixed(2)}% away`}, ${primaryOB.status.toLowerCase()})`
        : 'No active aligned OB';

      const title = `⏰ Reminder: ${sym} — ${verdict}`;
      const message =
        `Re-check for ${sym} at ${fmtPrice(stock.ltp)} (${stock.chg_pct >= 0 ? '+' : ''}${Number(stock.chg_pct || 0).toFixed(2)}%): ` +
        `Flow is ${flow.side} (${flow.agree}/${flow.n}, score ${flow.strengthScore}/100, Buy ${Math.round(stock.buy_pct)}%). ` +
        `${obPart}.${rem.note ? ` Note: ${rem.note}` : ''}`;

      reminderAlerts.push({
        reminderId: rem.id,
        symbol: sym,
        type: 'REMINDER_DUE',
        priority: 'HIGH',
        side: flow.side,
        action: sameSide ? actionVerb : 'INVALIDATED',
        title,
        message,
        ltp: stock.ltp,
        chgPct: stock.chg_pct,
        agree: flow.agree,
        totalChecks: flow.n,
        strengthScore: flow.strengthScore,
        obBot: primaryOB?.bot ?? null,
        obTop: primaryOB?.top ?? null,
        obDistPct: primaryOB?.distPct ?? null,
        obStr: primaryOB?.str ?? null,
        obStatus: primaryOB?.status ?? null,
        invalidation: plan?.invalidation ?? null,
        target1: plan?.target1 ?? null,
        target2: plan?.target2 ?? null,
        createdAt: nowMs,
      });
    }

    return reminderAlerts;
  }

  /**
   * Evaluates user's "My Tracker" positions for:
   *  1) SELL_WATCH ("Take a Step Back / Sell Reminder"):
   *     Alerts when a held/tracked stock hits a Bearish Order Block (Supply Zone),
   *     or flow flips/weakens to BEAR, or user's target/stop price is reached.
   *  2) BUY_WATCH ("Tredye Buy at Right Time Reminder"):
   *     After stepping back (or watching a stock to buy), alerts when price pulls back
   *     into/near a Bullish Order Block (Demand Zone) with Tredye BULL flow confirmation.
   */
  evaluateTrackerPositions(trackerItems = [], cycleData, config = {}, nowMs = Date.now()) {
    const { bySymbol = {}, stocksBySymbol = new Map(), obBySymbol = new Map() } = cycleData;
    const obProx = config.obProximityPct ?? 0.5;
    const cooldownMinutes = config.cooldownMinutes ?? 20;

    const enrichedTracker = [];
    const trackerAlerts = [];

    for (const item of trackerItems) {
      const sym = item.symbol;
      const stock = stocksBySymbol.get(sym);
      const flow = bySymbol[sym];
      const obInfo = obBySymbol.get(sym);

      if (!stock || !flow) {
        enrichedTracker.push({
          ...item,
          found: false,
          verdictCode: 'NO_DATA',
          verdictTone: 'neutral',
          verdictTitle: 'Waiting for symbol feed…',
          verdictReason: `${sym} not found in current snapshot. Check symbol spelling or sync Tredye.`,
        });
        continue;
      }

      const ltp = stock.ltp;
      const bullOB = obInfo?.bestBullOB || null;
      const bearOB = obInfo?.bestBearOB || null;
      const kl = obInfo?.keyLevels || {};
      const pnlPct =
        item.entryPrice && item.entryPrice > 0
          ? Number((((ltp - item.entryPrice) / item.entryPrice) * 100).toFixed(2))
          : null;

      const bullZoneStr = bullOB ? `${fmtPrice(bullOB.bot)}–${fmtPrice(bullOB.top)}` : kl.s1 ? `S1 ${fmtPrice(kl.s1)}` : '—';
      const bearZoneStr = bearOB ? `${fmtPrice(bearOB.bot)}–${fmtPrice(bearOB.top)}` : kl.r1 ? `R1 ${fmtPrice(kl.r1)}` : '—';

      let verdictCode = 'NEUTRAL';
      let verdictTone = 'neutral';
      let verdictTitle = '';
      let verdictReason = '';
      let shouldAlert = false;
      let alertType = null;
      let alertPriority = 'HIGH';
      let alertTitle = '';
      let alertMsg = '';
      let refOb = null;

      if (item.mode === 'SELL_WATCH') {
        // Phase 1: User holds/tracks this stock and wants a SELL / STEP-BACK reminder
        const inBearOB = bearOB && bearOB.status === 'IN_ZONE' && (flow.side === 'BEAR' || stock.buy_pct < 55);
        const nearBearOB =
          bearOB &&
          bearOB.status === 'UNTESTED' &&
          bearOB.distPct !== null &&
          bearOB.distPct <= obProx &&
          bearOB.onValidSide &&
          (flow.side === 'BEAR' || flow.agree < 5);
        const flowTurnedBear = flow.side === 'BEAR' && flow.agree >= 4;
        const flowWeakeningBear = flow.side === 'BEAR' && flow.agree === 3;
        const belowVwapSelling = ltp < stock.vwap && stock.buy_pct < 46;
        const hitUserTarget = item.targetPrice && ltp >= item.targetPrice;
        const hitUserStop = item.stopPrice && ltp <= item.stopPrice;

        if (inBearOB || flowTurnedBear || hitUserTarget || hitUserStop) {
          verdictCode = 'STEP_BACK_NOW';
          verdictTone = 'down';
          shouldAlert = true;
          alertType = 'TRACKER_SELL';
          alertPriority = 'HIGH';
          refOb = bearOB || bullOB;

          const reasons = [];
          if (hitUserTarget) reasons.push(`Target ${fmtPrice(item.targetPrice)} reached`);
          if (hitUserStop) reasons.push(`Stop floor ${fmtPrice(item.stopPrice)} breached`);
          if (inBearOB) reasons.push(`Trading INSIDE Bearish Supply OB ${bearZoneStr} (${bearOB.str}×)`);
          if (flowTurnedBear) reasons.push(`Tredye Flow is ${flow.agree}/${flow.n} BEAR (Sell ${Math.round(100 - stock.buy_pct)}%, CVD ${flow.rupeeFlowCr >= 0 ? '+' : ''}${flow.rupeeFlowCr.toFixed(1)} Cr)`);

          verdictTitle = '🛑 STEP BACK / SELL REMINDER';
          verdictReason = reasons.join(' · ') + `. Take a step back, review exit, then switch to "Buy at Right Time" to wait for Bullish OB ${bullZoneStr}.`;

          alertTitle = `🛑 My Tracker SELL Reminder: ${sym} — Step Back (${fmtPrice(ltp)})`;
          alertMsg = `${sym} (${fmtPrice(ltp)}${pnlPct !== null ? `, P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct}%` : ''}): ${verdictReason}`;
        } else if (nearBearOB || flowWeakeningBear || belowVwapSelling) {
          verdictCode = 'CAUTION_STEP_BACK';
          verdictTone = 'warn';
          shouldAlert = true;
          alertType = 'TRACKER_SELL';
          alertPriority = 'MEDIUM';
          refOb = bearOB || bullOB;

          const reasons = [];
          if (nearBearOB) reasons.push(`${bearOB.distPct.toFixed(2)}% from Bearish Supply OB ${bearZoneStr}`);
          if (flowWeakeningBear) reasons.push(`Flow weakening (${flow.agree}/${flow.n} BEAR)`);
          if (belowVwapSelling) reasons.push(`LTP slipped below VWAP (${fmtPrice(stock.vwap)}) with ${Math.round(100 - stock.buy_pct)}% selling`);

          verdictTitle = '⚠️ CAUTION — PREPARE TO STEP BACK';
          verdictReason = reasons.join(' · ') + `. Watch closely for rejection near ${bearZoneStr}.`;

          alertTitle = `⚠️ My Tracker Caution: ${sym} — Near Sell Zone / Flow Softening`;
          alertMsg = `${sym} (${fmtPrice(ltp)}): ${verdictReason}`;
        } else {
          verdictCode = 'HOLD_BULL_INTACT';
          verdictTone = 'up';
          verdictTitle = '✅ HOLD — BUYERS IN CONTROL';
          verdictReason =
            `Flow is ${flow.side} (${flow.agree}/${flow.n}, Buy ${Math.round(stock.buy_pct)}%, above VWAP ${fmtPrice(stock.vwap)}). ` +
            `Next Sell / Step-Back wall: ${bearZoneStr}${bullOB ? ` · Trailing Bullish OB floor: ${bullZoneStr}` : ''}.`;
        }
      } else {
        // Phase 2: BUY_WATCH ("Buy at Right Time" after stepping back or watching a stock to enter)
        const inBullOB = bullOB && bullOB.status === 'IN_ZONE';
        const nearBullOB = bullOB && bullOB.distPct !== null && bullOB.distPct <= obProx && bullOB.onValidSide;
        const bullFlowConfirmed = flow.side === 'BULL' && flow.agree >= (config.minAgree ?? 4);
        const buyersSteppingIn = flow.side === 'BULL' || stock.buy_pct >= 52;
        const hitUserBuyPrice = item.targetPrice && ltp <= item.targetPrice && buyersSteppingIn;

        if ((inBullOB && buyersSteppingIn) || (nearBullOB && bullFlowConfirmed) || hitUserBuyPrice) {
          verdictCode = 'BUY_RIGHT_TIME';
          verdictTone = 'up';
          shouldAlert = true;
          alertType = 'TRACKER_BUY';
          alertPriority = 'HIGH';
          refOb = bullOB;

          const zoneDetail = bullOB
            ? `${bullOB.status === 'IN_ZONE' ? 'INSIDE' : `${bullOB.distPct.toFixed(2)}% above`} Bullish OB ${bullZoneStr} (${bullOB.str}×)`
            : `at target buy level ${fmtPrice(item.targetPrice)}`;

          verdictTitle = '🎯 BUY AT RIGHT TIME — TREDYE OB + FLOW ALIGNED';
          verdictReason =
            `${sym} is ${zoneDetail} with ${flow.agree}/${flow.n} ${flow.side} flow (Buy ${Math.round(stock.buy_pct)}%, CVD ${flow.rupeeFlowCr >= 0 ? '+' : ''}${flow.rupeeFlowCr.toFixed(1)} Cr). ` +
            `Ref Invalidation: ${bullOB ? fmtPrice(bullOB.bot * 0.998) : fmtPrice(kl.s1)} · Target: ${bearZoneStr}.`;

          alertTitle = `🎯 My Tracker BUY NOW: ${sym} — Right Time at Bullish OB (${fmtPrice(ltp)})`;
          alertMsg = `${sym} (${fmtPrice(ltp)}): ${verdictReason}`;
        } else if (nearBullOB || bullFlowConfirmed) {
          verdictCode = 'GET_READY_BUY';
          verdictTone = 'warn';
          shouldAlert = true;
          alertType = 'TRACKER_BUY';
          alertPriority = 'MEDIUM';
          refOb = bullOB;

          verdictTitle = '⚡ GET READY — APPROACHING BUY WINDOW';
          verdictReason = nearBullOB
            ? `Price is ${bullOB.distPct.toFixed(2)}% from Bullish OB ${bullZoneStr}, waiting for stronger buyer aggression (currently ${flow.agree}/${flow.n} ${flow.side}, Buy ${Math.round(stock.buy_pct)}%).`
            : `Strong ${flow.agree}/${flow.n} BULL flow active (Buy ${Math.round(stock.buy_pct)}%). Best pullback entry zone: Bullish OB ${bullZoneStr}.`;

          alertTitle = `⚡ My Tracker Buy Watch: ${sym} — Setup Forming (${fmtPrice(ltp)})`;
          alertMsg = `${sym} (${fmtPrice(ltp)}): ${verdictReason}`;
        } else {
          verdictCode = 'WAIT_FOR_OB';
          verdictTone = 'neutral';
          verdictTitle = '⏳ STEPPED BACK — WAIT FOR RIGHT BUY ZONE';
          verdictReason =
            `Current flow is ${flow.side} (${flow.agree}/${flow.n}, Buy ${Math.round(stock.buy_pct)}%). ` +
            `Wait patiently for pullback into Bullish OB ${bullZoneStr} with BULL flow before buying.`;
        }
      }

      if (
        shouldAlert &&
        alertType &&
        !this.isSnoozed(sym, nowMs) &&
        !this.isCoolingDown(sym, alertType, cooldownMinutes, nowMs)
      ) {
        trackerAlerts.push({
          symbol: sym,
          type: alertType,
          priority: alertPriority,
          side: item.mode === 'SELL_WATCH' ? 'BEAR' : 'BULL',
          action: item.mode === 'SELL_WATCH' ? 'STEP BACK / SELL' : 'BUY AT RIGHT TIME',
          title: alertTitle,
          message: alertMsg,
          ltp,
          chgPct: stock.chg_pct,
          agree: flow.agree,
          totalChecks: flow.n,
          strengthScore: flow.strengthScore,
          obBot: refOb?.bot ?? null,
          obTop: refOb?.top ?? null,
          obDistPct: refOb?.distPct ?? null,
          obStr: refOb?.str ?? null,
          obStatus: refOb?.status ?? verdictCode,
          invalidation: bullOB?.bot ?? kl.s1 ?? null,
          target1: bearOB?.bot ?? kl.r1 ?? null,
          target2: kl.r2 ?? null,
          createdAt: nowMs,
        });
        this.markFired(sym, alertType, nowMs);
      }

      enrichedTracker.push({
        ...item,
        found: true,
        name: stock.name,
        sector: stock.sector || 'Other',
        ltp,
        chgPct: stock.chg_pct,
        pnlPct,
        vwap: stock.vwap,
        poc: stock.poc,
        buyPct: stock.buy_pct,
        rupeeFlowCr: Number(flow.rupeeFlowCr.toFixed(2)),
        side: flow.side,
        agree: flow.agree,
        totalChecks: flow.n,
        strengthScore: flow.strengthScore,
        bullOB,
        bearOB,
        bullZoneStr,
        bearZoneStr,
        keyLevels: kl,
        verdictCode,
        verdictTone,
        verdictTitle,
        verdictReason,
      });
    }

    return { enrichedTracker, trackerAlerts };
  }
}

module.exports = {
  SignalEngine,
  fmtPrice,
};

