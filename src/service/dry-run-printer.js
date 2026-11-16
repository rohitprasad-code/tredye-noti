'use strict';

function printDryRunSummary(state, store) {
  console.log('=== TREDYE FLOW ALERTS — DRY RUN SUMMARY ===');
  console.log(`Source Mode: ${state.sourceMode}`);
  console.log(`\nTop ${state.topBull.length} BULLISH (BUY OB Setups):`);
  for (const c of state.topBull) {
    console.log(
      `  🟢 #${c.rank} ${c.symbol.padEnd(11)} ₹${String(c.ltp).padEnd(8)} | ${c.agree}/${c.totalChecks} BULL (Strength ${c.strengthScore}/100) | Buy ${Math.round(c.buyPct)}% | ${c.referencePlan?.shortAction || 'OB'}: ${c.referencePlan?.zoneText || '—'} (${c.primaryOB?.distPct === 0 ? 'IN ZONE' : `${c.primaryOB?.distPct ?? '—'}% away`})`
    );
  }
  console.log(`\nTop ${state.topBear.length} BEARISH (SELL OB Setups):`);
  for (const c of state.topBear) {
    console.log(
      `  🔴 #${c.rank} ${c.symbol.padEnd(11)} ₹${String(c.ltp).padEnd(8)} | ${c.agree}/${c.totalChecks} BEAR (Strength ${c.strengthScore}/100) | Sell ${Math.round(100 - c.buyPct)}% | ${c.referencePlan?.shortAction || 'OB'}: ${c.referencePlan?.zoneText || '—'} (${c.primaryOB?.distPct === 0 ? 'IN ZONE' : `${c.primaryOB?.distPct ?? '—'}% away`})`
    );
  }
  const alerts = store.listAlerts(20);
  console.log(`\nGenerated Alerts (${alerts.length}):`);
  for (const a of alerts) {
    console.log(`  [${a.type}] ${a.title}\n    -> ${a.message}`);
  }
}

module.exports = { printDryRunSummary };
