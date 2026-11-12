'use strict';

const http = require('node:http');
const path = require('node:path');
const express = require('express');
const compression = require('compression');

const PUBLIC_DIR = path.join(__dirname, 'public');
const NODE_MODULES_DIR = path.join(process.cwd(), 'node_modules');

function createDashboardServer(appController) {
  const sseClients = new Set();

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(msg);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', 'strong');

  // Gzip / Deflate compression for all HTML, CSS, JS, fonts, and API JSON (skip SSE stream)
  app.use(
    compression({
      threshold: 512,
      filter: (req, res) => {
        if (req.path === '/api/events') return false;
        return compression.filter(req, res);
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));

  // Handle malformed JSON payloads cleanly
  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    return next(err);
  });

  // Helper to wrap async handlers cleanly
  const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // SSE endpoint (real-time push)
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(`event: state\ndata: ${JSON.stringify(appController.getPublicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // Full dashboard state
  app.get('/api/state', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(appController.getPublicState());
  });

  // 5-Stage Visual Funnel Live Snapshot (/api/ob/live/snapshot)
  app.get(
    ['/api/ob/live/snapshot', '/api/ob/sample/snapshot'],
    asyncHandler(async (req, res) => {
      const sector = String(req.query.sector || 'ALL');
      const side = String(req.query.side || 'ALL');
      const sort = String(req.query.sort || 'MAX_GAINS');
      const snap = await appController.getOrderBlockFunnelSnapshot({ sector, side, sort });
      res.set('Cache-Control', 'no-store');
      res.json(snap);
    })
  );

  // Stock detail (candles + OBs + depth + profile)
  app.get(
    '/api/stock/:symbol',
    asyncHandler(async (req, res) => {
      const symbol = decodeURIComponent(req.params.symbol).toUpperCase();
      const detail = await appController.getStockDetail(symbol);
      if (!detail) {
        return res.status(404).json({ error: `Stock ${symbol} not found in current snapshot` });
      }
      res.set('Cache-Control', 'no-store');
      res.json(detail);
    })
  );

  // Trigger immediate poll or demo replay
  app.post(
    '/api/poll',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const result = await appController.runPollCycle({
        forceDemo: Boolean(body.demo),
        manual: true,
      });
      res.json({ ok: true, ...result, state: appController.getPublicState() });
    })
  );

  // Schedule a reminder
  app.post('/api/reminders', (req, res) => {
    const body = req.body || {};
    if (!body.symbol) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    const rem = appController.scheduleReminder({
      symbol: body.symbol,
      minutes: Number(body.minutes || 15),
      expectedSide: body.expectedSide,
      obBot: body.obBot,
      obTop: body.obTop,
      note: body.note,
    });
    res.json({ ok: true, reminder: rem });
  });

  // Cancel a reminder
  app.delete('/api/reminders/:id', (req, res) => {
    const id = Number(req.params.id);
    appController.cancelReminder(id);
    res.json({ ok: true });
  });

  // Snooze / unsnooze symbol
  app.post('/api/snooze', (req, res) => {
    const body = req.body || {};
    if (!body.symbol) return res.status(400).json({ error: 'symbol is required' });
    if (body.clear) {
      appController.unsnoozeSymbol(body.symbol);
    } else {
      appController.snoozeSymbol(body.symbol, Number(body.minutes || 30));
    }
    res.json({ ok: true, snoozes: appController.store.listActiveSnoozes() });
  });

  // Mark single alert reviewed
  app.post('/api/alerts/:id/review', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid alert id' });
    const body = req.body || {};
    appController.markAlertReviewed(id, body.reviewed ?? true);
    res.json({ ok: true });
  });

  // Mark all alerts reviewed
  app.post('/api/alerts/review-all', (_req, res) => {
    appController.markAllAlertsReviewed();
    res.json({ ok: true });
  });

  // Fire a test notification (macOS + Telegram)
  app.post(
    '/api/notify/test',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const result = await appController.sendTestNotification(body.symbol);
      res.json({ ok: true, result });
    })
  );

  // Update settings
  app.post('/api/settings', (req, res) => {
    const updated = appController.updateConfig(req.body || {});
    res.json({ ok: true, config: updated });
  });

  // Update Tredye credentials (.env + live client)
  app.post(
    '/api/credentials',
    asyncHandler(async (req, res) => {
      const resCred = await appController.updateCredentials(req.body || {});
      res.json(resCred);
    })
  );

  // Upstox OAuth2 & Real-time Feed Endpoints
  app.get('/api/upstox/status', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, status: appController.getUpstoxStatus() });
  });

  app.post('/api/upstox/config', (req, res) => {
    const body = req.body || {};
    const out = appController.updateUpstoxConfig(body);
    res.json(out);
  });

  app.get('/api/upstox/login', (_req, res) => {
    try {
      const url = appController.upstox.getAuthUrl();
      res.redirect(302, url);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get(
    '/api/upstox/callback',
    asyncHandler(async (req, res) => {
      const { code, error, error_description: errorDesc } = req.query;
      if (error) {
        return res
          .status(400)
          .send(
            `<!doctype html><body style="background:#04060A;color:#EEF3FA;font-family:sans-serif;padding:40px">` +
              `<h2 style="color:#FF3B5C">Upstox Authorization Failed</h2>` +
              `<p>${String(errorDesc || error)}</p>` +
              `<a href="/" style="color:#19E58C">Return to Terminal</a></body>`
          );
      }
      if (!code) {
        return res.status(400).send('Missing Upstox authorization code.');
      }
      const { profile } = await appController.completeUpstoxOAuth(String(code));
      res.send(
        `<!doctype html><body style="background:#04060A;color:#EEF3FA;font-family:-apple-system,sans-serif;padding:40px">` +
          `<h2 style="color:#19E58C">Upstox Real-Time Feed Connected</h2>` +
          `<p>Signed in as <strong>${profile.user_name || profile.user_id || 'Upstox User'}</strong>.</p>` +
          `<p>Live quotes &amp; WebSocket V3 feed are now active on your local terminal.</p>` +
          `<div style="margin-top:20px;display:flex;gap:12px">` +
            `<a href="/app/orderblock" style="padding:10px 16px;background:#19E58C;color:#04060A;font-weight:700;border-radius:8px;text-decoration:none">Open Order Block Terminal</a>` +
          `</div>` +
          `<script>setTimeout(function(){ window.location.href = '/app/orderblock'; }, 1600);</script>` +
        `</body>`
      );
    })
  );

  app.post('/api/upstox/disconnect', (_req, res) => {
    const status = appController.disconnectUpstox();
    res.json({ ok: true, status });
  });

  // My Tracker CRUD endpoints (Sell / Step-Back & Buy at Right Time)
  app.get('/api/tracker', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, tracker: appController.state.tracker });
  });

  app.post(
    '/api/tracker',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.symbol) {
        return res.status(400).json({ error: 'symbol is required' });
      }
      const item = await appController.upsertTrackerPosition(body);
      res.json({ ok: true, item, tracker: appController.state.tracker });
    })
  );

  app.post(
    '/api/tracker/mode',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.symbol || !body.mode) {
        return res.status(400).json({ error: 'symbol and mode are required' });
      }
      const item = await appController.switchTrackerMode(body.symbol, body.mode, body);
      res.json({ ok: true, item, tracker: appController.state.tracker });
    })
  );

  app.delete('/api/tracker/:symbol', (req, res) => {
    const symbol = decodeURIComponent(req.params.symbol).toUpperCase();
    appController.removeTrackerPosition(symbol);
    res.json({ ok: true, tracker: appController.state.tracker });
  });

  // Local npm-installed vendor assets (immutable aggressive caching)
  const vendorCacheOpts = { maxAge: '365d', immutable: true };
  app.use('/vendor/fonts', express.static(path.join(NODE_MODULES_DIR, '@fontsource'), vendorCacheOpts));
  app.get('/vendor/gsap.min.js', (_req, res) => {
    res.sendFile(path.join(NODE_MODULES_DIR, 'gsap/dist/gsap.min.js'), vendorCacheOpts);
  });

  // Order Block Terminal & dedicated Settings page
  app.get(['/', '/app', '/app/orderblock'], (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'orderblock.html'));
  });
  app.get(['/settings', '/app/settings'], (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'settings.html'));
  });

  // Static assets from src/server/public
  app.use(
    express.static(PUBLIC_DIR, {
      etag: true,
      maxAge: 0,
    })
  );

  // 404 fallback
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Central error handler
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
  });

  const server = http.createServer(app);
  return { server, broadcast };
}

module.exports = { createDashboardServer };
