'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
const { normalizeBearerToken, decodeJwtClaims, isJwtExpired } = require('./jwt');

const UPSTOX_API_BASE = 'https://api.upstox.com';
const INSTRUMENTS_NSE_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
const PROTO_PATH = path.join(__dirname, 'MarketDataFeedV3.proto');
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const ANALYTICS_MIN_SPAN_MS = 30 * 86400 * 1000;
const TOKEN_VERIFY_KEY = 'NSE_EQ|INE002A01018';

function istDateStr(tsOrIso) {
  const num = typeof tsOrIso === 'string' && !/^\d+$/.test(tsOrIso.trim())
    ? Date.parse(tsOrIso)
    : Number(tsOrIso);
  if (!Number.isFinite(num) || num <= 0) return '';
  return new Date(num + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Computes buy% and order-book imbalance from Upstox total buy/sell quantities.
 */
function computeOrderBookStats(tbq, tsq) {
  const total = tbq + tsq;
  if (total <= 0) return { buyPct: null, imb: null };
  const buyPct = tbq > 0 && tsq > 0 ? Number(((tbq / total) * 100).toFixed(2)) : null;
  const imb = Number((((tbq - tsq) / total) * 100).toFixed(2));
  return { buyPct, imb };
}

class UpstoxClient {
  constructor(options = {}) {
    this.apiKey = (options.apiKey !== undefined ? options.apiKey : process.env.UPSTOX_API_KEY || '').trim();
    this.apiSecret = (
      options.apiSecret !== undefined ? options.apiSecret : process.env.UPSTOX_API_SECRET || ''
    ).trim();
    this.redirectUri = (
      options.redirectUri !== undefined
        ? options.redirectUri
        : process.env.UPSTOX_REDIRECT_URI || `http://localhost:${process.env.PORT || 4600}/api/upstox/callback`
    ).trim();
    this.tokenFile = options.tokenFile || path.join(process.cwd(), 'data', 'upstox-token.json');
    this.instrumentsFile =
      options.instrumentsFile || path.join(process.cwd(), 'data', 'upstox-instruments-map.json');

    this.accessToken = normalizeBearerToken(
      options.accessToken !== undefined ? options.accessToken : process.env.UPSTOX_ACCESS_TOKEN || ''
    );
    this.extendedToken = normalizeBearerToken(
      options.extendedToken !== undefined ? options.extendedToken : process.env.UPSTOX_EXTENDED_TOKEN || ''
    );
    this.extendedTokenBlocked = false;
    this.tokenSource = options.tokenSource || '';
    this.authFailed = false;
    this.userProfile = null;
    this.issuedAt = 0;

    this.instrumentBySymbol = new Map(); // RELIANCE -> { sym, key, exchangeToken, name, isin, lotSize }
    this.symbolByInstrumentKey = new Map(); // NSE_EQ|INE002A01018 -> RELIANCE
    this.instrumentsLoadedAt = 0;

    this.ws = null;
    this.wsConnected = false;
    this.wsReconnectTimer = null;
    this.wsAttempts = 0;
    this.wsWantedKeys = [];
    this.onTickCallback = null;
    this.lastTickAt = 0;
    this.lastError = null;
    this.marketStatus = null;
    this.protoFeedResponse = null;
    this.candleCache = new Map();
    this.candleInFlight = new Map();

    this.loadSavedToken();
    this.loadCachedInstruments();
  }

  loadSavedToken() {
    try {
      if (!fs.existsSync(this.tokenFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      const rawAccess = normalizeBearerToken(raw?.accessToken || '');
      const hadToken = Boolean(this.accessToken);
      if (rawAccess && !hadToken) {
        this.accessToken = rawAccess;
      }
      if (!this.extendedToken && raw?.extendedToken) {
        this.extendedToken = normalizeBearerToken(raw.extendedToken);
      }
      const sameToken = !hadToken || (rawAccess && rawAccess === this.accessToken);
      if (sameToken) {
        if (raw?.tokenSource) this.tokenSource = String(raw.tokenSource);
        if (raw?.userProfile) this.userProfile = raw.userProfile;
        if (raw?.issuedAt) this.issuedAt = Number(raw.issuedAt);
      }
    } catch {
      // ignore corrupted cache
    }
  }

  saveToken() {
    try {
      fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
      fs.writeFileSync(
        this.tokenFile,
        JSON.stringify(
          {
            accessToken: this.accessToken,
            extendedToken: this.extendedToken || undefined,
            tokenSource: this.tokenSource || undefined,
            userProfile: this.userProfile,
            issuedAt: this.issuedAt,
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
    } catch {
      // ignore write failures
    }
  }

  clearToken() {
    this.accessToken = '';
    this.extendedToken = '';
    this.extendedTokenBlocked = false;
    this.tokenSource = '';
    this.authFailed = false;
    this.userProfile = null;
    this.issuedAt = 0;
    this.lastError = null;
    this.stopWebSocket();
    try {
      if (fs.existsSync(this.tokenFile)) fs.unlinkSync(this.tokenFile);
    } catch {
      // ignore
    }
  }

  updateConfig({ apiKey, apiSecret, redirectUri, accessToken, extendedToken, tokenSource }) {
    if (apiKey !== undefined) this.apiKey = String(apiKey).trim();
    if (apiSecret !== undefined && apiSecret !== '') this.apiSecret = String(apiSecret).trim();
    if (redirectUri !== undefined && redirectUri.trim()) {
      this.redirectUri = redirectUri.trim();
    }
    let tokenChanged = false;
    const cleanToken = accessToken !== undefined ? normalizeBearerToken(accessToken) : '';
    if (cleanToken) {
      this.accessToken = cleanToken;
      this.tokenSource = '';
      this.authFailed = false;
      this.extendedTokenBlocked = false;
      this.issuedAt = Date.now();
      const detectedType = this.getTokenInfo().tokenType;
      this.tokenSource =
        tokenSource ||
        (detectedType === 'analytics' ? 'analytics' : detectedType === 'daily_oauth' ? 'oauth' : 'manual');
      if (extendedToken === undefined) {
        this.extendedToken = '';
        this.userProfile = null;
      }
      tokenChanged = true;
    }
    if (extendedToken !== undefined) {
      this.extendedToken = normalizeBearerToken(extendedToken);
      this.extendedTokenBlocked = false;
      tokenChanged = true;
    }
    if (tokenChanged) this.saveToken();
    this.lastError = null;
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiSecret && this.redirectUri);
  }

  /**
   * Inspects the active access token without assuming JWT format for manual/test strings.
   */
  getTokenInfo() {
    const token = normalizeBearerToken(this.accessToken);
    if (!token) {
      return {
        hasToken: false,
        expired: false,
        authFailed: false,
        tokenType: 'none',
        expiresAt: null,
        expiresInHours: null,
        expiresInDays: null,
      };
    }

    const claims = decodeJwtClaims(token);
    const expMs = claims?.expMs || null;
    const iatMs = claims?.iatMs || null;
    const now = Date.now();
    const expired = expMs !== null ? now >= expMs : false;
    const remainingMs = expMs !== null ? Math.max(0, expMs - now) : null;
    const spanMs = expMs !== null && iatMs !== null ? expMs - iatMs : null;

    let tokenType = 'manual';
    if (spanMs !== null && spanMs >= ANALYTICS_MIN_SPAN_MS) {
      tokenType = 'analytics';
    } else if (this.tokenSource === 'analytics') {
      tokenType = 'analytics';
    } else if (expMs !== null) {
      tokenType = 'daily_oauth';
    }

    return {
      hasToken: true,
      expired,
      authFailed: Boolean(this.authFailed),
      tokenType,
      expiresAt: expMs,
      expiresInHours: remainingMs !== null ? Number((remainingMs / 3600000).toFixed(1)) : null,
      expiresInDays: remainingMs !== null ? Math.floor(remainingMs / 86400000) : null,
    };
  }

  isTokenExpired() {
    return this.getTokenInfo().expired;
  }

  isConnected() {
    const info = this.getTokenInfo();
    return info.hasToken && !info.expired && !info.authFailed;
  }

  getStatus() {
    const tokenInfo = this.getTokenInfo();
    return {
      configured: this.isConfigured(),
      hasApiKey: Boolean(this.apiKey),
      hasApiSecret: Boolean(this.apiSecret),
      apiKeyPreview: this.apiKey ? `${this.apiKey.slice(0, 6)}…${this.apiKey.slice(-4)}` : '',
      redirectUri: this.redirectUri,
      connected: this.isConnected(),
      hasToken: tokenInfo.hasToken,
      tokenType: tokenInfo.tokenType,
      tokenExpired: tokenInfo.expired,
      authFailed: tokenInfo.authFailed,
      expiresAt: tokenInfo.expiresAt,
      expiresInHours: tokenInfo.expiresInHours,
      expiresInDays: tokenInfo.expiresInDays,
      hasExtendedToken: Boolean(this.extendedToken && !this.extendedTokenBlocked),
      user: this.userProfile
        ? {
            userId: this.userProfile.user_id || '',
            userName: this.userProfile.user_name || '',
            email: this.userProfile.email || '',
          }
        : null,
      issuedAt: this.issuedAt || null,
      wsConnected: this.wsConnected,
      lastTickAt: this.lastTickAt || null,
      instrumentsMapped: this.instrumentBySymbol.size,
      marketStatus: this.marketStatus,
      lastError: this.lastError,
    };
  }

  getAuthUrl(state = 'tredye_upstox') {
    if (!this.apiKey || !this.redirectUri) {
      throw new Error('Upstox API Key and Redirect URI must be configured first');
    }
    const url = new URL(`${UPSTOX_API_BASE}/v2/login/authorization/dialog`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.apiKey);
    url.searchParams.set('redirect_uri', this.redirectUri);
    if (state) url.searchParams.set('state', String(state));
    return url.toString();
  }

  async exchangeCode(code) {
    if (!code) throw new Error('Authorization code is required');
    if (!this.isConfigured()) {
      throw new Error('Upstox API Key / API Secret / Redirect URI not configured');
    }

    const body = new URLSearchParams({
      code: String(code).trim(),
      client_id: this.apiKey,
      client_secret: this.apiSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });

    const res = await fetch(`${UPSTOX_API_BASE}/v2/login/authorization/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.access_token) {
      const msg =
        json?.errors?.[0]?.message || json?.message || `Upstox token exchange failed (HTTP ${res.status})`;
      this.lastError = msg;
      throw new Error(msg);
    }

    this.accessToken = normalizeBearerToken(json.access_token);
    this.extendedToken = normalizeBearerToken(json.extended_token || '');
    this.extendedTokenBlocked = false;
    this.tokenSource = 'oauth';
    this.authFailed = false;
    this.issuedAt = Date.now();
    this.userProfile = {
      user_id: json.user_id || '',
      user_name: json.user_name || '',
      email: json.email || '',
      exchanges: json.exchanges || [],
    };
    this.lastError = null;
    this.saveToken();
    return this.userProfile;
  }

  async _fetchJson(endpointPath, token) {
    const res = await fetch(`${UPSTOX_API_BASE}${endpointPath}`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const json = await res.json().catch(() => ({}));
    return { res, json };
  }

  _extractErrorMessage(json, fallback) {
    return json?.errors?.[0]?.message || json?.message || fallback;
  }

  _hasExtendedAuthRestriction(json, status) {
    const code = String(json?.errors?.[0]?.errorCode || json?.errors?.[0]?.code || '');
    return status === 401 || status === 403 || code === 'UDAPI100067';
  }

  _canUseExtendedFallback() {
    return Boolean(
      this.extendedToken &&
        !this.extendedTokenBlocked &&
        !isJwtExpired(this.extendedToken) &&
        this.extendedToken !== this.accessToken
    );
  }

  async _tryExtendedFallback(endpointPath) {
    if (!this._canUseExtendedFallback()) return null;
    const { res, json } = await this._fetchJson(endpointPath, this.extendedToken);
    if (res.ok) {
      this.accessToken = this.extendedToken;
      this.tokenSource = 'extended';
      this.authFailed = false;
      this.lastError = null;
      this.saveToken();
      return json;
    }
    if (this._hasExtendedAuthRestriction(json, res.status)) {
      this.extendedTokenBlocked = true;
    }
    return null;
  }

  /**
   * Validates a manually pasted Upstox token (e.g. 1-Year Analytics Token) against a read-only
   * market-quote endpoint, which works without requiring a Static IP whitelist.
   */
  async verifyAccessToken(rawToken) {
    const token = normalizeBearerToken(rawToken);
    if (!token) {
      const err = new Error('Upstox token is required');
      err.status = 400;
      throw err;
    }

    const claims = decodeJwtClaims(token);
    if (claims?.expMs && Date.now() >= claims.expMs) {
      const err = new Error(
        `This Upstox token expired on ${new Date(claims.expMs).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
        })} IST.`
      );
      err.status = 400;
      throw err;
    }

    const { res, json } = await this._fetchJson(
      `/v2/market-quote/quotes?instrument_key=${encodeURIComponent(TOKEN_VERIFY_KEY)}`,
      token
    );
    if (!res.ok) {
      const msg = this._extractErrorMessage(
        json,
        res.status === 401 || res.status === 403
          ? 'Invalid or expired Upstox token.'
          : `Upstox verification failed (HTTP ${res.status})`
      );
      const err = new Error(msg);
      err.status = res.status === 401 || res.status === 403 ? 401 : res.status || 502;
      throw err;
    }

    return { ok: true, token, claims };
  }

  async apiRequest(endpointPath) {
    if (!this.accessToken) {
      const err = new Error(
        'Upstox access token is missing. Paste a 1-Year Analytics Token or log in with Upstox.'
      );
      err.status = 401;
      throw err;
    }

    if (this.isTokenExpired()) {
      const promoted = await this._tryExtendedFallback(endpointPath);
      if (promoted) return promoted;

      const err = new Error(
        'Upstox daily token expired — paste a 1-Year Analytics Token in Settings or log in again today.'
      );
      err.status = 401;
      this.authFailed = true;
      this.lastError = err.message;
      this.wsConnected = false;
      throw err;
    }

    const { res, json } = await this._fetchJson(endpointPath, this.accessToken);
    if (res.status === 401) {
      const promoted = await this._tryExtendedFallback(endpointPath);
      if (promoted) return promoted;

      const err = new Error(
        this._extractErrorMessage(
          json,
          'Upstox token expired or rejected — paste a 1-Year Analytics Token or reconnect via Upstox OAuth.'
        )
      );
      err.status = 401;
      this.authFailed = true;
      this.lastError = err.message;
      this.wsConnected = false;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(this._extractErrorMessage(json, `Upstox API HTTP ${res.status}`));
      err.status = res.status;
      this.lastError = err.message;
      throw err;
    }

    this.authFailed = false;
    this.lastError = null;
    return json;
  }

  loadCachedInstruments() {
    try {
      if (!fs.existsSync(this.instrumentsFile)) return false;
      const raw = JSON.parse(fs.readFileSync(this.instrumentsFile, 'utf8'));
      if (!raw || !Array.isArray(raw.entries)) return false;
      this.instrumentBySymbol.clear();
      this.symbolByInstrumentKey.clear();
      for (const item of raw.entries) {
        this.instrumentBySymbol.set(item.sym, item);
        this.symbolByInstrumentKey.set(item.key, item.sym);
      }
      const firstEntryHasToken = !raw.entries.length || Boolean(raw.entries[0].exchangeToken);
      this.instrumentsLoadedAt = Number(raw.version || 1) >= 2 && firstEntryHasToken ? Number(raw.loadedAt || 0) : 0;
      return this.instrumentBySymbol.size > 0;
    } catch {
      return false;
    }
  }

  async ensureInstruments(force = false) {
    const ttlMs = 18 * 3600 * 1000;
    if (!force && this.instrumentBySymbol.size > 100 && Date.now() - this.instrumentsLoadedAt < ttlMs) {
      return;
    }

    const res = await fetch(INSTRUMENTS_NSE_URL, {
      headers: { 'Accept-Encoding': 'gzip, deflate' },
    });
    if (!res.ok) {
      if (this.instrumentBySymbol.size > 0) return;
      throw new Error(`Failed to fetch Upstox NSE instruments (HTTP ${res.status})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
    const records = JSON.parse(text);

    const entries = [];
    this.instrumentBySymbol.clear();
    this.symbolByInstrumentKey.clear();

    for (const r of records) {
      if (!r || !r.instrument_key) continue;
      if (r.segment === 'NSE_EQ' && r.instrument_type === 'EQ' && r.trading_symbol) {
        const sym = String(r.trading_symbol).toUpperCase().trim();
        if (!this.instrumentBySymbol.has(sym)) {
          const entry = {
            sym,
            key: r.instrument_key,
            exchangeToken: r.exchange_token ? String(r.exchange_token).trim() : '',
            name: r.name || sym,
            isin: r.isin || '',
            lotSize: Number(r.lot_size || 1),
          };
          entries.push(entry);
          this.instrumentBySymbol.set(sym, entry);
          this.symbolByInstrumentKey.set(entry.key, sym);
        }
      }
    }

    this.instrumentsLoadedAt = Date.now();
    try {
      fs.mkdirSync(path.dirname(this.instrumentsFile), { recursive: true });
      fs.writeFileSync(
        this.instrumentsFile,
        JSON.stringify({ version: 2, loadedAt: this.instrumentsLoadedAt, entries })
      );
    } catch {
      // ignore disk cache failures
    }
  }

  getInstrumentKey(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    return this.instrumentBySymbol.get(sym)?.key || null;
  }

  async fetchQuotes(symbols = []) {
    if (!this.isConnected()) throw new Error('Upstox not connected');
    await this.ensureInstruments();

    const keyToSym = new Map();
    const keys = [];
    for (const rawSym of symbols) {
      const sym = String(rawSym || '').toUpperCase().trim();
      const entry = this.instrumentBySymbol.get(sym);
      if (entry) {
        keyToSym.set(entry.key, sym);
        keys.push(entry.key);
      }
    }
    if (keys.length === 0) return {};

    const out = {};
    const chunkSize = 400; // Upstox supports up to 500 keys per request
    for (let i = 0; i < keys.length; i += chunkSize) {
      const batch = keys.slice(i, i + chunkSize);
      const q = encodeURIComponent(batch.join(','));
      const json = await this.apiRequest(`/v2/market-quote/quotes?instrument_key=${q}`);
      const data = json?.data || {};

      for (const [respKey, val] of Object.entries(data)) {
        if (!val) continue;
        const instKey = val.instrument_token || '';
        const colonSym = respKey.includes(':') ? respKey.split(':')[1].toUpperCase() : '';
        const sym = keyToSym.get(instKey) || this.symbolByInstrumentKey.get(instKey) || colonSym;
        if (!sym) continue;

        const ltp = Number(val.last_price || 0);
        const ohlc = val.ohlc || {};
        // Upstox /v2/market-quote/quotes sets ohlc.close to today's closing bar; net_change gives true delta vs previous close
        const hasNetChg =
          val.net_change !== undefined && val.net_change !== null && !Number.isNaN(Number(val.net_change));
        const prevClose = hasNetChg
          ? Number((ltp - Number(val.net_change)).toFixed(4))
          : Number(ohlc.close || ltp);
        const chgPct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
        const tbq = Number(val.total_buy_quantity || 0);
        const tsq = Number(val.total_sell_quantity || 0);
        const { buyPct, imb } = computeOrderBookStats(tbq, tsq);

        const lastTradeDate =
          istDateStr(val.last_trade_time) || istDateStr(val.timestamp) || '';

        out[sym] = {
          symbol: sym,
          instrumentKey: instKey,
          ltp,
          prev: prevClose,
          chg_pct: Number(chgPct.toFixed(2)),
          open: Number(ohlc.open || ltp),
          high: Number(ohlc.high || ltp),
          low: Number(ohlc.low || ltp),
          volume: Number(val.volume || 0),
          vwap: Number(val.average_price || 0) || null,
          oi: Number(val.oi || 0) || null,
          tbq,
          tsq,
          buy_pct: buyPct,
          imb,
          depth: val.depth || null,
          lastTradeDate,
        };
      }
    }

    this.lastTickAt = Date.now();
    this.lastError = null;
    return out;
  }

  normalizeRawCandles(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    // Upstox returns newest-first [timestamp, o, h, l, c, v, oi]; normalize oldest-first
    return raw
      .slice()
      .reverse()
      .map(c => ({
        ts: Date.parse(c[0]) || 0,
        iso: String(c[0] || ''),
        o: Number(c[1]),
        h: Number(c[2]),
        l: Number(c[3]),
        c: Number(c[4]),
        v: Number(c[5] || 0),
        oi: Number(c[6] || 0),
      }))
      .filter(b => Number.isFinite(b.o) && Number.isFinite(b.c) && b.o > 0 && b.c > 0);
  }

  async fetchIntradayCandles(symbol, unit = 'minutes', interval = 3) {
    if (!this.isConnected()) return null;
    await this.ensureInstruments();
    const key = this.getInstrumentKey(symbol);
    if (!key) return null;

    const json = await this.apiRequest(
      `/v3/historical-candle/intraday/${encodeURIComponent(key)}/${unit}/${interval}`
    );
    return this.normalizeRawCandles(json?.data?.candles);
  }

  async fetchOneDayCandles(symbol, interval = 5, { ttlMs = 45000 } = {}) {
    if (!this.isConnected()) return null;
    const normSym = String(symbol || '').trim().toUpperCase();
    if (!normSym) return null;

    const cacheKey = `${normSym}:${interval}`;
    const cached = this.candleCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < ttlMs) {
      return cached.data;
    }
    if (this.candleInFlight.has(cacheKey)) {
      return this.candleInFlight.get(cacheKey);
    }

    const work = (async () => {
      try {
        await this.ensureInstruments();
        const key = this.getInstrumentKey(normSym);
        if (!key) return null;

        let raw = null;
        try {
          const intraday = await this.apiRequest(
            `/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/${interval}`
          );
          if (Array.isArray(intraday?.data?.candles) && intraday.data.candles.length > 0) {
            raw = intraday.data.candles;
          }
        } catch (_err) {
          // Fall back to recent 1 trading day from historical candles
        }

        if (!raw || raw.length === 0) {
          const toDate = istDateStr(Date.now() + 86400 * 1000);
          for (const lookbackDays of [3, 10]) {
            const fromDate = istDateStr(Date.now() - lookbackDays * 86400 * 1000);
            const hist = await this.apiRequest(
              `/v3/historical-candle/${encodeURIComponent(key)}/minutes/${interval}/${toDate}/${fromDate}`
            );
            const allRaw = hist?.data?.candles;
            if (Array.isArray(allRaw) && allRaw.length > 0) {
              let latestDay = '';
              for (const bar of allRaw) {
                const day = String(bar[0] || '').slice(0, 10);
                if (day > latestDay) latestDay = day;
              }
              if (latestDay) {
                raw = allRaw.filter(bar => String(bar[0] || '').startsWith(latestDay));
                break;
              }
            }
          }
        }

        const candles = this.normalizeRawCandles(raw);
        if (candles && candles.length > 0) {
          this.candleCache.set(cacheKey, { data: candles, at: Date.now() });
          return candles;
        }
        return cached?.data || null;
      } catch (_err) {
        return cached?.data || null;
      } finally {
        this.candleInFlight.delete(cacheKey);
      }
    })();

    this.candleInFlight.set(cacheKey, work);
    return work;
  }

  async fetchOneDayCandlesBatch(symbols = [], interval = 5, { concurrency = 10, ttlMs = 45000 } = {}) {
    const out = new Map();
    if (!this.isConnected() || !Array.isArray(symbols) || symbols.length === 0) {
      return out;
    }
    await this.ensureInstruments();

    const unique = [];
    const seen = new Set();
    for (const s of symbols) {
      const sym = String(s || '').trim().toUpperCase();
      if (sym && !seen.has(sym)) {
        seen.add(sym);
        unique.push(sym);
      }
    }

    let cursor = 0;
    const workerCount = Math.min(Math.max(1, concurrency), unique.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < unique.length) {
        const idx = cursor++;
        const sym = unique[idx];
        const bars = await this.fetchOneDayCandles(sym, interval, { ttlMs });
        if (bars && bars.length > 0) {
          out.set(sym, bars);
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  async loadProto() {
    if (this.protoFeedResponse) return this.protoFeedResponse;
    const root = await protobuf.load(PROTO_PATH);
    this.protoFeedResponse = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
    return this.protoFeedResponse;
  }

  async startWebSocket(symbols = [], onTick) {
    if (!this.isConnected()) return false;
    this.onTickCallback = onTick;
    await this.ensureInstruments();

    const keys = [];
    for (const sym of symbols) {
      const k = this.getInstrumentKey(sym);
      if (k) keys.push(k);
    }
    this.wsWantedKeys = keys.slice(0, 500);
    if (this.wsWantedKeys.length === 0) return false;

    this.stopWebSocket(false);
    await this.connectWebSocketInternal();
    return true;
  }

  async connectWebSocketInternal() {
    if (!this.isConnected() || this.wsWantedKeys.length === 0) return;

    try {
      const FeedResponse = await this.loadProto();
      const authJson = await this.apiRequest('/v3/feed/market-data-feed/authorize');
      const wsUrl = authJson?.data?.authorized_redirect_uri;
      if (!wsUrl) throw new Error('Upstox WebSocket authorize returned no URL');

      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        followRedirects: true,
      });
      this.ws = ws;

      ws.on('open', () => {
        this.wsConnected = true;
        this.wsAttempts = 0;
        this.lastError = null;

        // Subscribe in batches of 100 in full mode
        for (let i = 0; i < this.wsWantedKeys.length; i += 100) {
          const batch = this.wsWantedKeys.slice(i, i + 100);
          const payload = JSON.stringify({
            guid: `tredye-${Date.now()}-${i}`,
            method: 'sub',
            data: {
              mode: 'full',
              instrumentKeys: batch,
            },
          });
          ws.send(Buffer.from(payload));
        }
      });

      ws.on('message', data => {
        try {
          const decoded = FeedResponse.decode(Buffer.from(data));
          const obj = FeedResponse.toObject(decoded, { longs: Number, enums: String });
          if (obj?.marketInfo?.segmentStatus?.NSE_EQ) {
            this.marketStatus = obj.marketInfo.segmentStatus.NSE_EQ;
          }
          const feeds = obj?.feeds || {};
          const ticks = {};
          let count = 0;

          for (const [key, feed] of Object.entries(feeds)) {
            const sym = this.symbolByInstrumentKey.get(key);
            if (!sym || !feed) continue;

            const mff = feed.fullFeed?.marketFF;
            const ltpc = mff?.ltpc || feed.ltpc || feed.firstLevelWithGreeks?.ltpc;
            if (!ltpc || !ltpc.ltp) continue;

            const ltp = Number(ltpc.ltp);
            const prev = Number(ltpc.cp || 0);
            const chgPct = prev > 0 ? ((ltp - prev) / prev) * 100 : null;
            const tbq = Number(mff?.tbq || 0);
            const tsq = Number(mff?.tsq || 0);
            const { buyPct, imb } = computeOrderBookStats(tbq, tsq);

            const dayOhlc = mff?.marketOHLC?.ohlc?.find(o => o.interval === '1d');
            let depth = null;
            if (Array.isArray(mff?.marketLevel?.bidAskQuote) && mff.marketLevel.bidAskQuote.length) {
              depth = {
                buy: mff.marketLevel.bidAskQuote.map(q => ({ price: q.bidP, quantity: q.bidQ })),
                sell: mff.marketLevel.bidAskQuote.map(q => ({ price: q.askP, quantity: q.askQ })),
              };
            }

            ticks[sym] = {
              symbol: sym,
              ltp,
              prev: prev || undefined,
              chg_pct: chgPct !== null ? Number(chgPct.toFixed(2)) : undefined,
              open: dayOhlc?.open || undefined,
              high: dayOhlc?.high || undefined,
              low: dayOhlc?.low || undefined,
              volume: mff?.vtt || undefined,
              vwap: mff?.atp || undefined,
              oi: mff?.oi || undefined,
              tbq,
              tsq,
              buy_pct: buyPct !== null ? buyPct : undefined,
              imb: imb !== null ? imb : undefined,
              depth,
            };
            count++;
          }

          if (count > 0) {
            this.lastTickAt = Date.now();
            if (typeof this.onTickCallback === 'function') {
              this.onTickCallback(ticks, this.marketStatus);
            }
          }
        } catch {
          // ignore malformed tick frame
        }
      });

      ws.on('error', err => {
        this.lastError = err?.message || 'Upstox WebSocket error';
      });

      ws.on('close', () => {
        this.wsConnected = false;
        if (this.ws === ws && this.isConnected() && this.wsWantedKeys.length > 0) {
          this.wsAttempts++;
          const delayMs = Math.min(30000, 2000 * Math.pow(1.6, Math.min(5, this.wsAttempts)));
          clearTimeout(this.wsReconnectTimer);
          this.wsReconnectTimer = setTimeout(() => {
            this.connectWebSocketInternal().catch(() => {});
          }, delayMs);
        }
      });
    } catch (err) {
      this.wsConnected = false;
      this.lastError = err.message;
    }
  }

  stopWebSocket(clearWanted = true) {
    clearTimeout(this.wsReconnectTimer);
    this.wsReconnectTimer = null;
    if (clearWanted) this.wsWantedKeys = [];
    this.wsConnected = false;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = { UpstoxClient, normalizeBearerToken, decodeJwtClaims };
