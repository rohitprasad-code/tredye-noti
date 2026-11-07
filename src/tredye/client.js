'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = 'https://www.tredye.com';
const DATA_BASE_URL = 'https://data.tredye.com/data';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

class TredyeClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_URL;
    this.dataBaseUrl = options.dataBaseUrl || DATA_BASE_URL;
    this.email = (options.email || process.env.TREDYE_EMAIL || '').trim();
    this.password = options.password || process.env.TREDYE_PASSWORD || '';
    this.manualCookie = (options.cookie || process.env.TREDYE_COOKIE || '').trim();
    this.cookieFile = options.cookieFile || path.join(process.cwd(), '.session-cookie');
    this.cookieJar = new Map(); // name -> value
    this.backoffUntilMs = 0;
    this.authenticatedUser = null;
    this.lastError = null;

    this.loadCookieJar();
  }

  hasCredentials() {
    return true;
  }

  updateCredentials({ email, password, cookie }) {
    if (email !== undefined) this.email = String(email).trim();
    if (password !== undefined && password !== '') this.password = String(password);
    if (cookie !== undefined) {
      this.manualCookie = String(cookie).trim();
      if (this.manualCookie) {
        this.ingestCookieString(this.manualCookie);
        this.saveCookieJar();
      }
    }
    this.lastError = null;
  }

  loadCookieJar() {
    if (this.manualCookie) {
      this.ingestCookieString(this.manualCookie);
    }
    try {
      if (fs.existsSync(this.cookieFile)) {
        const raw = fs.readFileSync(this.cookieFile, 'utf8').trim();
        if (raw) this.ingestCookieString(raw);
      }
    } catch {
      // ignore
    }
  }

  saveCookieJar() {
    try {
      const serialized = this.getCookieHeader();
      if (serialized) {
        fs.writeFileSync(this.cookieFile, serialized, { mode: 0o600 });
      }
    } catch {
      // ignore
    }
  }

  ingestCookieString(str) {
    for (const part of str.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim();
      if (k && !['path', 'domain', 'expires', 'max-age', 'samesite', 'httponly', 'secure'].includes(k.toLowerCase())) {
        this.cookieJar.set(k, v);
      }
    }
  }

  ingestSetCookieHeaders(headers) {
    const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const firstPair = sc.split(';')[0];
      if (!firstPair) continue;
      const eq = firstPair.indexOf('=');
      if (eq <= 0) continue;
      const k = firstPair.slice(0, eq).trim();
      const v = firstPair.slice(eq + 1).trim();
      if (k) {
        if (v === '' || sc.toLowerCase().includes('max-age=0')) {
          this.cookieJar.delete(k);
        } else {
          this.cookieJar.set(k, v);
        }
      }
    }
    if (setCookies.length > 0) {
      this.saveCookieJar();
    }
  }

  getCookieHeader() {
    if (this.cookieJar.size === 0) return this.manualCookie || '';
    return [...this.cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async login() {
    if (!this.email || !this.password) {
      if (this.getCookieHeader()) {
        return { ok: true, mode: 'cookie' };
      }
      throw new Error('Missing Tredye email/password or session cookie');
    }

    if (Date.now() < this.backoffUntilMs) {
      const waitSec = Math.ceil((this.backoffUntilMs - Date.now()) / 1000);
      throw new Error(`Rate limited by Tredye; waiting ${waitSec}s before retry`);
    }

    const normalized = this.email.trim().toLowerCase();
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/login/`,
      },
      body: JSON.stringify({
        email: normalized,
        username: normalized,
        password: this.password,
      }),
    });

    this.ingestSetCookieHeaders(res.headers);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 30;
      this.backoffUntilMs = Date.now() + retryAfter * 1000;
      throw new Error(`Tredye login rate-limited (429). Retry after ${retryAfter}s.`);
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error || body?.message || `Login failed with HTTP ${res.status}`;
      this.lastError = msg;
      throw new Error(msg);
    }

    this.authenticatedUser = body?.user || { email: normalized };
    this.lastError = null;
    return { ok: true, user: this.authenticatedUser };
  }

  async requestJson(endpointPath, { retryOn401 = true } = {}) {
    if (Date.now() < this.backoffUntilMs) {
      const waitSec = Math.ceil((this.backoffUntilMs - Date.now()) / 1000);
      throw new Error(`Backing off for ${waitSec}s due to 429 rate limit`);
    }

    if (!this.getCookieHeader() && this.email && this.password) {
      await this.login();
    }

    const cookieHeader = this.getCookieHeader();
    const headers = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      Referer: `${this.baseUrl}/pulse/?view=orderflow`,
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    const res = await fetch(`${this.baseUrl}${endpointPath}`, {
      method: 'GET',
      headers,
    });

    this.ingestSetCookieHeaders(res.headers);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      this.backoffUntilMs = Date.now() + retryAfter * 1000;
      const err = new Error(`HTTP 429 rate limit on ${endpointPath} (retry after ${retryAfter}s)`);
      err.status = 429;
      this.lastError = err.message;
      throw err;
    }

    if (res.status === 401) {
      if (retryOn401 && this.email && this.password) {
        await this.login();
        return this.requestJson(endpointPath, { retryOn401: false });
      }
      const err = new Error('Not signed in to Tredye (HTTP 401). Add your Tredye credentials in Settings or .env.');
      err.status = 401;
      this.lastError = err.message;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} on ${endpointPath}: ${text.slice(0, 140)}`);
      err.status = res.status;
      this.lastError = err.message;
      throw err;
    }

    this.lastError = null;
    return res.json();
  }

  async fetchDataFeed(fileName) {
    const res = await fetch(`${this.dataBaseUrl}/${fileName}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
        Origin: this.baseUrl,
        Referer: `${this.baseUrl}/pulse/?view=orderflow`,
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${fileName}`);
    }
    return res.json();
  }

  async fetchOrderFlow() {
    if (!this.getCookieHeader() && this.email && this.password) {
      try {
        await this.login();
      } catch {
        // Proceed with data feed even if login endpoint had a transient issue
      }
    }

    try {
      const [ofData, flowData] = await Promise.all([
        this.fetchDataFeed('orderflow.json'),
        this.fetchDataFeed('flow.json').catch(() => null),
      ]);

      // Enrich stocks with sector group & flow metadata from flow.json (matching orderflow-v2.js)
      if (flowData?.stocks && Array.isArray(ofData?.stocks)) {
        const fm = new Map(flowData.stocks.filter(s => s.fo).map(s => [s.s, s]));
        ofData.stocks = ofData.stocks.map(s => {
          const f = fm.get(s.symbol);
          return {
            ...s,
            sector: f?.g || s.sector || 'Other',
            flowScore: f?.f ?? (s.buy_pct - 50) * (s.tv || 1),
            buildup: f?.bu || null,
            doi: f?.doi ?? null,
            rv: f?.rv ?? null,
          };
        });
      }

      this.lastError = null;
      return ofData;
    } catch (v2Err) {
      // Fallback to legacy v1 endpoint
      return this.requestJson('/api/orderflow');
    }
  }

  async fetchOrderFlowShard(shardId) {
    if (shardId === null || shardId === undefined) return null;
    try {
      return await this.fetchDataFeed(`orderflow_p${shardId}.json`);
    } catch {
      return this.requestJson(`/api/orderflow/p${shardId}`);
    }
  }
}

module.exports = { TredyeClient };

