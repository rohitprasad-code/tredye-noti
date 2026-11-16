'use client';

import React from 'react';
import Script from 'next/script';

export default function SettingsView() {
  return (
    <div className="has-ob-rail settings-page">
      <link rel="stylesheet" href="/vendor/fonts.css" />
      <link rel="stylesheet" href="/theme-ob.css" />
      <link rel="stylesheet" href="/static/settings/settings.css" />
      <Script src="/market-hours.js" strategy="afterInteractive" />
      <Script src="/nav-rail.js" strategy="afterInteractive" />
      <Script src="/settings.js" strategy="afterInteractive" />

      <main className="settings-main">
        <header className="settings-header">
          <div className="settings-title-wrap">
            <h1>Settings</h1>
            <span id="settingsMarketPill" className="market-status-pill" role="status" aria-live="off" title="NSE session status (IST)">
              NSE Closed · opens —
            </span>
          </div>
          <a href="/app/orderblock" className="btn-ui">← Back to Order Block</a>
        </header>

        <section className="card-section" id="upstoxSection" aria-labelledby="upstoxHeading">
          <div className="card-head">
            <h2 id="upstoxHeading">Upstox API</h2>
            <span id="upstoxStatusBadge" className="status-pill">Checking…</span>
          </div>

          <p id="upstoxTokenMeta" className="help-text">
            Use a <strong>1-Year Analytics Token</strong> below so you never have to log in or enter keys daily.
          </p>

          <form id="upstoxTokenForm" aria-labelledby="upstoxTokenHeading" method="POST" action="/api/upstox/token" noValidate>
            <div className="field full" style={{ marginBottom: '10px' }}>
              <h3 id="upstoxTokenHeading" className="subhead">One-Time Login (1-Year Analytics Token)</h3>
              <p id="upstoxTokenHelp" className="help-text">
                This dashboard only reads market quotes, historical candles &amp; WebSocket ticks (no order placement).
                Generate an <strong>Analytics Token</strong> once a year in{' '}
                <a href="https://account.upstox.com/developer/apps" target="_blank" rel="noopener">
                  Upstox Developer Apps → Analytics
                </a>{' '}
                and paste it below (no Static IP needed).
              </p>
            </div>

            <fieldset className="rule-group">
              <legend className="visually-hidden">Upstox 1-Year Analytics Token</legend>

              <div className="field full">
                <label htmlFor="upstoxAnalyticsToken">
                  Analytics Access Token <span id="analyticsReqStar" aria-hidden="true">*</span>
                </label>
                <div className="input-wrap">
                  <input
                    type="password"
                    id="upstoxAnalyticsToken"
                    name="token"
                    className="control"
                    required
                    minLength={20}
                    placeholder="Paste 1-Year Analytics Token"
                    autoComplete="new-password"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="done"
                    aria-describedby="upstoxTokenHelp"
                    data-error="upstoxTokenError"
                  />
                  <button
                    type="button"
                    id="toggleAnalyticsBtn"
                    className="btn-ui"
                    aria-pressed="false"
                    aria-label="Show Analytics Token"
                    aria-describedby="toggleAnalyticsWarn"
                  >
                    Show
                  </button>
                  <span id="toggleAnalyticsWarn" className="visually-hidden">
                    Warning: this will display your Analytics Token on screen.
                  </span>
                </div>
                <div id="upstoxTokenError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Paste a valid Upstox Analytics Token (at least 20 characters).
                </div>
              </div>
            </fieldset>

            <div className="btn-row">
              <button type="submit" id="upstoxSaveTokenBtn" className="btn-ui">Save 1-Year Token</button>
              <button type="button" id="upstoxDisconnectBtn" className="btn-ui" hidden>Disconnect</button>
            </div>
            <div id="upstoxTokenStatusMsg" className="form-status" role="status" aria-live="polite" />
          </form>

          <details id="upstoxOAuthDetails" className="oauth-disclosure">
            <summary>
              Daily OAuth Login (API Key &amp; Secret · resets daily at 03:30 AM IST)
              <span id="oauthKeysSummaryPill" className="summary-pill" />
            </summary>
            <div className="disclosure-body">
              <p className="help-text">
                Standard OAuth tokens expire every day at 03:30 AM IST per Upstox/SEBI rules. Your saved API Key &amp; Secret stay stored on this server — leave them blank to log in again with your saved keys, or paste new ones to update.
              </p>

              <div className="field">
                <label htmlFor="upstoxRedirectCode">
                  Redirect URL (
                  <a href="https://account.upstox.com/developer/apps/createapp" target="_blank" rel="noopener" style={{ color: 'var(--s-accent)' }}>
                    Upstox App
                  </a>
                  )
                </label>
                <div className="redirect-row">
                  <code id="upstoxRedirectCode">http://localhost:4600/api/upstox/callback</code>
                  <button type="button" id="copyRedirectBtn" className="btn-ui">Copy</button>
                </div>
              </div>

              <form id="upstoxForm" aria-label="Upstox Daily OAuth Credentials" method="POST" action="/api/upstox/config" noValidate>
                <fieldset className="rule-group">
                  <legend className="visually-hidden">Upstox OAuth Credentials</legend>

                  <div className="field full">
                    <label htmlFor="upstoxApiKey">API Key</label>
                    <input
                      type="text"
                      id="upstoxApiKey"
                      name="apiKey"
                      className="control"
                      minLength={8}
                      placeholder="Paste Upstox API Key"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      enterKeyHint="next"
                      data-error="upstoxKeyError"
                    />
                    <div id="upstoxKeyError" className="error-msg">
                      <span role="img" aria-label="Error">❌</span> Enter a valid Upstox API Key (at least 8 characters).
                    </div>
                  </div>

                  <div className="field full">
                    <label htmlFor="upstoxApiSecret">API Secret</label>
                    <div className="input-wrap">
                      <input
                        type="password"
                        id="upstoxApiSecret"
                        name="apiSecret"
                        className="control"
                        minLength={6}
                        placeholder="Paste Upstox API Secret"
                        autoComplete="current-password"
                        autoCorrect="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        enterKeyHint="done"
                        data-error="upstoxSecretError"
                      />
                      <button
                        type="button"
                        id="toggleSecretBtn"
                        className="btn-ui"
                        aria-pressed="false"
                        aria-label="Show API Secret"
                        aria-describedby="toggleSecretWarn"
                      >
                        Show
                      </button>
                      <span id="toggleSecretWarn" className="visually-hidden">
                        Warning: this will display your API Secret on screen.
                      </span>
                    </div>
                    <div id="upstoxSecretError" className="error-msg">
                      <span role="img" aria-label="Error">❌</span> Enter a valid Upstox API Secret (at least 6 characters).
                    </div>
                  </div>
                </fieldset>

                <div className="btn-row">
                  <button type="submit" id="upstoxConnectBtn" className="btn-ui">Save &amp; Login with Upstox</button>
                </div>
                <div id="upstoxStatusMsg" className="form-status" role="status" aria-live="polite" />
              </form>
            </div>
          </details>
        </section>

        <section className="card-section" id="fxSection" aria-labelledby="fxHeading">
          <div className="card-head">
            <h2 id="fxHeading">Display &amp; Ambient FX</h2>
            <span id="fxStatusBadge" className="status-pill ok">FX Playing</span>
          </div>

          <p id="fxHelpText" className="help-text">
            Control continuous background particles, spine comet, sweep light, tile shimmer, and glow pulses on the Order Block terminal. Live quotes and the hover inspector always stay active.
          </p>

          <div className="btn-row">
            <button type="button" id="fxToggleBtn" className="btn-ui fx-toggle-btn is-on" role="switch" aria-checked="true" aria-label="Toggle ambient FX">
              <span className="fx-switch-track" aria-hidden="true"><span className="fx-switch-thumb" /></span>
              <span id="fxToggleLabel" className="fx-toggle-label">Play FX</span>
            </button>
          </div>
          <div id="fxStatusMsg" className="form-status" role="status" aria-live="polite" />
        </section>

        <section className="card-section" id="rulesSection" aria-labelledby="rulesHeading">
          <div className="card-head">
            <h2 id="rulesHeading">Terminal Rules</h2>
          </div>

          <form id="rulesForm" aria-labelledby="rulesHeading" method="POST" action="/api/settings" noValidate>
            <fieldset className="rule-group">
              <legend className="visually-hidden">Polling and Filter Rules</legend>

              <div className="field">
                <label htmlFor="cfgPollInterval">Poll Frequency (sec)</label>
                <input
                  type="number"
                  id="cfgPollInterval"
                  name="pollIntervalSec"
                  className="control"
                  min={15}
                  max={300}
                  step={5}
                  required
                  inputMode="numeric"
                  data-error="pollError"
                />
                <div id="pollError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Enter a value between 15 and 300.
                </div>
              </div>

              <div className="field">
                <label htmlFor="cfgTopN">Top-N per Side</label>
                <input
                  type="number"
                  id="cfgTopN"
                  name="topN"
                  className="control"
                  min={1}
                  max={15}
                  step={1}
                  required
                  inputMode="numeric"
                  data-error="topNError"
                />
                <div id="topNError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Enter a value between 1 and 15.
                </div>
              </div>

              <div className="field">
                <label htmlFor="cfgMinAgree">Min Signals (1–5)</label>
                <input
                  type="number"
                  id="cfgMinAgree"
                  name="minAgree"
                  className="control"
                  min={1}
                  max={5}
                  step={1}
                  required
                  inputMode="numeric"
                  data-error="agreeError"
                />
                <div id="agreeError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Enter a value between 1 and 5.
                </div>
              </div>

              <div className="field">
                <label htmlFor="cfgObProx">OB Proximity (%)</label>
                <input
                  type="number"
                  id="cfgObProx"
                  name="obProximityPct"
                  className="control"
                  min={0.05}
                  max={5}
                  step={0.05}
                  required
                  inputMode="decimal"
                  data-error="proxError"
                />
                <div id="proxError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Enter a value between 0.05 and 5.
                </div>
              </div>

              <div className="field">
                <label htmlFor="cfgConfirmPolls">Confirm Polls</label>
                <input
                  type="number"
                  id="cfgConfirmPolls"
                  name="confirmPolls"
                  className="control"
                  min={1}
                  max={5}
                  step={1}
                  required
                  inputMode="numeric"
                  data-error="confirmError"
                />
                <div id="confirmError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Enter a value between 1 and 5.
                </div>
              </div>

              <div className="field">
                <label htmlFor="cfgMinPrice">Min Price (₹)</label>
                <input
                  type="number"
                  id="cfgMinPrice"
                  name="minPrice"
                  className="control"
                  min={0}
                  step={10}
                  required
                  inputMode="numeric"
                  data-error="priceError"
                />
                <div id="priceError" className="error-msg">
                  <span role="img" aria-label="Error">❌</span> Enter 0 or higher.
                </div>
              </div>

              <div className="field full">
                <label htmlFor="cfgWatchlist">Watchlist (comma-separated, blank = all 218)</label>
                <input
                  type="text"
                  id="cfgWatchlist"
                  name="watchlist"
                  className="control"
                  placeholder="RELIANCE, ICICIBANK, PAYTM"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </div>

              <div className="field full">
                <label htmlFor="cfgIgnore">Ignore Symbols</label>
                <input
                  type="text"
                  id="cfgIgnore"
                  name="ignoreSymbols"
                  className="control"
                  placeholder="IDEA, YESBANK"
                  autoCorrect="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                />
              </div>
            </fieldset>

            <div className="btn-row">
              <button type="submit" id="saveRulesBtn" className="btn-ui">Save Rules</button>
            </div>
            <div id="rulesStatusMsg" className="form-status" role="status" aria-live="polite" />
          </form>
        </section>
      </main>
    </div>
  );
}
