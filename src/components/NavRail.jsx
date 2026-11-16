import React from 'react';

export default function NavRail({ active = 'orderblock' }) {
  return (
    <aside className="ob-side-rail" id="obSideRail" aria-label="Primary Navigation">
      <div className="rail-top">
        <a href="/app/orderblock" className="rail-logo" title="Order Block">
          <span className="logo-bars" aria-hidden="true">
            <i className="b1" />
            <i className="b2" />
            <i className="b3" />
          </span>
          <span className="rail-lbl rail-brand-lbl">Terminal</span>
        </a>
        <button
          type="button"
          className="rail-collapse"
          id="obRailToggle"
          title="Expand / Collapse sidebar"
          aria-label="Toggle sidebar"
        >
          »
        </button>
        <div className="rail-divider" />
        <a
          href="/app/orderblock"
          className={`rail-item${active === 'orderblock' ? ' active' : ''}`}
          title="Order Block Terminal (/app/orderblock)"
          data-tip="Order Block"
        >
          <span className="rail-ic">⟁</span>
          <span className="rail-lbl">Order Block</span>
        </a>
      </div>
      <div className="rail-bottom">
        <div className="rail-live" title="Live 218 NSE F&O Feed" data-tip="Live 218 F&O">
          <span className="rail-live-dot" />
          <span className="rail-lbl">218 Live</span>
        </div>
        <div className="rail-theme-pill" role="group" aria-label="Theme toggle">
          <button type="button" className="rt-btn" data-theme-set="light" title="Light theme" aria-label="Light theme" aria-pressed="false">
            ☀
          </button>
          <button type="button" className="rt-btn" data-theme-set="dark" title="Dark theme" aria-label="Dark theme" aria-pressed="false">
            ☾
          </button>
        </div>
        <a
          href="/app/settings"
          className={`rail-item${active === 'settings' ? ' active' : ''}`}
          id="obSettingsBtn"
          title="Settings · Upstox API & Flow Rules (/app/settings)"
          data-tip="Settings"
        >
          <span className="rail-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </span>
          <span className="rail-lbl">Settings</span>
        </a>
      </div>
    </aside>
  );
}
