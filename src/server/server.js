'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

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

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      // SSE endpoint
      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: state\ndata: ${JSON.stringify(appController.getPublicState())}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // Full dashboard state
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, appController.getPublicState());
      }

      // 5-Stage Visual Funnel Live Snapshot (/api/ob/live/snapshot)
      if (req.method === 'GET' && (pathname === '/api/ob/live/snapshot' || pathname === '/api/ob/sample/snapshot')) {
        const sector = parsedUrl.searchParams.get('sector') || 'ALL';
        const side = parsedUrl.searchParams.get('side') || 'ALL';
        const sort = parsedUrl.searchParams.get('sort') || 'MAX_GAINS';
        const snap = appController.getOrderBlockFunnelSnapshot({ sector, side, sort });
        return sendJson(res, 200, snap);
      }

      // Stock detail (candles + OBs + depth + profile)
      if (req.method === 'GET' && pathname.startsWith('/api/stock/')) {
        const symbol = decodeURIComponent(pathname.slice('/api/stock/'.length)).toUpperCase();
        const detail = await appController.getStockDetail(symbol);
        if (!detail) {
          return sendJson(res, 404, { error: `Stock ${symbol} not found in current snapshot` });
        }
        return sendJson(res, 200, detail);
      }

      // Trigger immediate poll or demo replay
      if (req.method === 'POST' && pathname === '/api/poll') {
        const body = await readBody(req);
        const result = await appController.runPollCycle({
          forceDemo: Boolean(body.demo),
          manual: true,
        });
        return sendJson(res, 200, { ok: true, ...result, state: appController.getPublicState() });
      }

      // Schedule a reminder
      if (req.method === 'POST' && pathname === '/api/reminders') {
        const body = await readBody(req);
        if (!body.symbol) {
          return sendJson(res, 400, { error: 'symbol is required' });
        }
        const rem = appController.scheduleReminder({
          symbol: body.symbol,
          minutes: Number(body.minutes || 15),
          expectedSide: body.expectedSide,
          obBot: body.obBot,
          obTop: body.obTop,
          note: body.note,
        });
        return sendJson(res, 200, { ok: true, reminder: rem });
      }

      // Cancel a reminder
      if (req.method === 'DELETE' && pathname.startsWith('/api/reminders/')) {
        const id = Number(pathname.slice('/api/reminders/'.length));
        appController.cancelReminder(id);
        return sendJson(res, 200, { ok: true });
      }

      // Snooze / unsnooze symbol
      if (req.method === 'POST' && pathname === '/api/snooze') {
        const body = await readBody(req);
        if (!body.symbol) return sendJson(res, 400, { error: 'symbol is required' });
        if (body.clear) {
          appController.unsnoozeSymbol(body.symbol);
        } else {
          appController.snoozeSymbol(body.symbol, Number(body.minutes || 30));
        }
        return sendJson(res, 200, { ok: true, snoozes: appController.store.listActiveSnoozes() });
      }

      // Mark single alert reviewed
      if (req.method === 'POST' && /^\/api\/alerts\/\d+\/review$/.test(pathname)) {
        const id = Number(pathname.split('/')[3]);
        const body = await readBody(req);
        appController.markAlertReviewed(id, body.reviewed ?? true);
        return sendJson(res, 200, { ok: true });
      }

      // Mark all alerts reviewed
      if (req.method === 'POST' && pathname === '/api/alerts/review-all') {
        appController.markAllAlertsReviewed();
        return sendJson(res, 200, { ok: true });
      }

      // Fire a test notification (macOS + Telegram)
      if (req.method === 'POST' && pathname === '/api/notify/test') {
        const body = await readBody(req);
        const result = await appController.sendTestNotification(body.symbol);
        return sendJson(res, 200, { ok: true, result });
      }

      // Update settings
      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readBody(req);
        const updated = appController.updateConfig(body);
        return sendJson(res, 200, { ok: true, config: updated });
      }

      // Update Tredye credentials (.env + live client)
      if (req.method === 'POST' && pathname === '/api/credentials') {
        const body = await readBody(req);
        const resCred = await appController.updateCredentials(body);
        return sendJson(res, 200, resCred);
      }

      // My Tracker CRUD endpoints (Sell / Step-Back & Buy at Right Time)
      if (req.method === 'GET' && pathname === '/api/tracker') {
        return sendJson(res, 200, { ok: true, tracker: appController.state.tracker });
      }

      if (req.method === 'POST' && pathname === '/api/tracker') {
        const body = await readBody(req);
        if (!body.symbol) {
          return sendJson(res, 400, { error: 'symbol is required' });
        }
        const item = await appController.upsertTrackerPosition(body);
        return sendJson(res, 200, { ok: true, item, tracker: appController.state.tracker });
      }

      if (req.method === 'POST' && pathname === '/api/tracker/mode') {
        const body = await readBody(req);
        if (!body.symbol || !body.mode) {
          return sendJson(res, 400, { error: 'symbol and mode are required' });
        }
        const item = await appController.switchTrackerMode(body.symbol, body.mode, body);
        return sendJson(res, 200, { ok: true, item, tracker: appController.state.tracker });
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/tracker/')) {
        const symbol = decodeURIComponent(pathname.slice('/api/tracker/'.length)).toUpperCase();
        appController.removeTrackerPosition(symbol);
        return sendJson(res, 200, { ok: true, tracker: appController.state.tracker });
      }

      // Investment & Trade Journal Booklet CRUD endpoints (/api/journal)
      if (req.method === 'GET' && pathname === '/api/journal') {
        const jState = appController.getJournalState();
        return sendJson(res, 200, { ok: true, ...jState });
      }

      if (req.method === 'POST' && pathname === '/api/journal') {
        const body = await readBody(req);
        if (!body.symbol) {
          return sendJson(res, 400, { error: 'symbol is required' });
        }
        const resJ = await appController.createJournalItem(body);
        return sendJson(res, 200, { ok: true, ...resJ });
      }

      if ((req.method === 'PUT' || req.method === 'POST') && /^\/api\/journal\/\d+$/.test(pathname)) {
        const id = Number(pathname.slice('/api/journal/'.length));
        const body = await readBody(req);
        const resJ = await appController.updateJournalItem(id, body);
        return sendJson(res, 200, { ok: true, ...resJ });
      }

      if (req.method === 'DELETE' && /^\/api\/journal\/\d+$/.test(pathname)) {
        const id = Number(pathname.slice('/api/journal/'.length));
        const resJ = appController.deleteJournalItem(id);
        return sendJson(res, 200, { ok: true, ...resJ });
      }

      // Static files & clean SPA routes (/app/orderblock, /orderblock, /app/journal, /journal)
      if (req.method === 'GET' || req.method === 'HEAD') {
        const cleanPathname = pathname.replace(/\/+$/, '') || '/';
        const relPath =
          cleanPathname === '/' || cleanPathname === '/app'
            ? 'index.html'
            : cleanPathname === '/orderblock' || cleanPathname === '/app/orderblock'
            ? 'orderblock.html'
            : cleanPathname === '/journal' || cleanPathname === '/app/journal'
            ? 'journal.html'
            : pathname.replace(/^\/+/, '');
        const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
        if (!safePath.startsWith(PUBLIC_DIR)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const ext = path.extname(safePath);
          res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
          });
          return fs.createReadStream(safePath).pipe(res);
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Internal Server Error' });
    }
  });

  return {
    server,
    broadcast,
  };
}

module.exports = { createDashboardServer };

