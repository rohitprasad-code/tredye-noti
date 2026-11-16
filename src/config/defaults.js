'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadDefaultConfig(cfgPath = path.join(process.cwd(), 'config.json')) {
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {
    return {
      pollIntervalSec: 60,
      topN: 5,
      minAgree: 4,
      confirmPolls: 2,
      obProximityPct: 0.5,
      cooldownMinutes: 20,
      minPrice: 0,
      sectors: [],
      watchlist: [],
      ignoreSymbols: [],
      soundOnInZone: true,
      soundOnApproach: true,
      openSummaryAlert: true,
    };
  }
}

module.exports = { loadDefaultConfig };
