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
  app.get(['/api/ob/live/snapshot', '/api/ob/sample/snapshot'], (req, res) => {
    const sector = String(req.query.sector || 'ALL');
    const side = String(req.query.side || 'ALL');
    const sort = String(req.query.sort || 'MAX_GAINS');
    const snap = appController.getOrderBlockFunnelSnapshot({ sector, side, sort });
    res.set('Cache-Control', 'no-store');
    res.json(snap);
  });

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

  // Investment & Trade Journal Booklet CRUD endpoints (/api/journal)
  app.get('/api/journal', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const jState = appController.getJournalState();
    res.json({ ok: true, ...jState });
  });

  app.post(
    '/api/journal',
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.symbol) {
        return res.status(400).json({ error: 'symbol is required' });
      }
      const resJ = await appController.createJournalItem(body);
      res.json({ ok: true, ...resJ });
    })
  );

  app.all(
    '/api/journal/:id',
    asyncHandler(async (req, res, next) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return next();
      if (req.method === 'PUT' || req.method === 'POST') {
        const resJ = await appController.updateJournalItem(id, req.body || {});
        return res.json({ ok: true, ...resJ });
      }
      if (req.method === 'DELETE') {
        const resJ = appController.deleteJournalItem(id);
        return res.json({ ok: true, ...resJ });
      }
      return next();
    })
  );

  // Local npm-installed vendor assets (immutable aggressive caching)
  const vendorCacheOpts = { maxAge: '365d', immutable: true };
  app.use('/vendor/fonts', express.static(path.join(NODE_MODULES_DIR, '@fontsource'), vendorCacheOpts));
  app.get('/vendor/gsap.min.js', (_req, res) => {
    res.sendFile(path.join(NODE_MODULES_DIR, 'gsap/dist/gsap.min.js'), vendorCacheOpts);
  });
  app.get('/vendor/lucide.min.js', (_req, res) => {
    res.sendFile(path.join(NODE_MODULES_DIR, 'lucide/dist/umd/lucide.min.js'), vendorCacheOpts);
  });

  // Clean SPA routes (/app/orderblock, /app/journal, /journal) — note /orderblock intentionally excluded
  app.get(['/', '/app'], (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.get('/app/orderblock', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'orderblock.html'));
  });
  app.get(['/journal', '/app/journal'], (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'journal.html'));
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
