import React from 'react';

export default function OrderBlockTopBar() {
  return (
    <header className="ob-top-bar" id="obTopBar">
      <div className="ob-bar-left">
        <div id="obFindHost" />
      </div>
      <div className="ob-bar-center">
        <div className="obc-pills" role="group" aria-label="Market side mode">
          <button type="button" className="obc-pill on" data-side="ALL" title="View all 218 F&O stocks">
            All <span className="obc-cnt" id="obCntAll">218</span>
          </button>
          <button type="button" className="obc-pill" data-side="BULL" title="Full screen Bullish order blocks">
            <span className="obc-dot bull">●</span> Bullish <span className="obc-cnt" id="obCntBull">0</span>
          </button>
          <button type="button" className="obc-pill" data-side="BEAR" title="Full screen Bearish order blocks">
            <span className="obc-dot bear">●</span> Bearish <span className="obc-cnt" id="obCntBear">0</span>
          </button>
        </div>
      </div>
      <div className="ob-bar-right">
        <div className="obc-group">
          <span className="obc-lbl">SECTOR</span>
          <select id="obSecSel" aria-label="Sector filter" defaultValue="ALL">
            <option value="ALL">All Sectors (218)</option>
          </select>
        </div>
        <div className="obc-group">
          <span className="obc-lbl">SORT</span>
          <select id="obSortSel" aria-label="Sort order" defaultValue="MAX_GAINS">
            <option value="MAX_GAINS">Max Gains (Bulls &amp; Bears)</option>
            <option value="SETUP_SCORE">Setup Score (Flow + OB)</option>
            <option value="FLOW_SCORE">Strongest Flow</option>
          </select>
        </div>
        <div className="ob-market-pill is-closed" id="obMarketStatus" role="status" aria-live="off" title="NSE session status (IST)">
          <span className="ob-mkt-state" id="obMarketState">Closed</span>
          <span className="ob-mkt-sep" aria-hidden="true">·</span>
          <span className="ob-mkt-count" id="obMarketCount">opens —</span>
        </div>
        <div className="ob-live-status">
          <span className="ob-live-dot">●</span>
          <span className="ob-live-txt" id="obLiveClock">LIVE</span>
        </div>
        <button type="button" id="obSyncBtn" className="ob-sync-btn" title="Refresh Live Data">
          ↻
        </button>
      </div>
    </header>
  );
}
