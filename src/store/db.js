'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class FlowStore {
  constructor(dbPath) {
    const resolved = dbPath || path.join(process.cwd(), 'data', 'tredye-alerts.db');
    if (resolved !== ':memory:') {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
    }
    this.db = new DatabaseSync(resolved);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        type TEXT NOT NULL,
        priority TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        ltp REAL,
        chg_pct REAL,
        agree INTEGER,
        total_checks INTEGER,
        strength_score REAL,
        ob_bot REAL,
        ob_top REAL,
        ob_dist_pct REAL,
        ob_str REAL,
        ob_status TEXT,
        invalidation REAL,
        target1 REAL,
        target2 REAL,
        reviewed INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_symbol_type ON alerts(symbol, type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);

      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        expected_side TEXT,
        ob_bot REAL,
        ob_top REAL,
        note TEXT,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        created_at INTEGER NOT NULL,
        fired_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_status_due ON reminders(status, due_at ASC);

      CREATE TABLE IF NOT EXISTS snoozes (
        symbol TEXT PRIMARY KEY,
        until_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracker_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL DEFAULT 'SELL_WATCH',
        entry_price REAL,
        target_price REAL,
        stop_price REAL,
        qty REAL,
        notes TEXT,
        last_verdict TEXT,
        last_alert_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tracker_mode ON tracker_positions(mode, updated_at DESC);

      CREATE TABLE IF NOT EXISTS journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL DEFAULT 'LONG',
        status TEXT NOT NULL DEFAULT 'OPEN',
        qty REAL NOT NULL DEFAULT 1,
        entry_price REAL NOT NULL,
        exit_price REAL,
        stop_price REAL,
        target_price REAL,
        ob_zone TEXT,
        setup_type TEXT,
        thesis TEXT,
        lessons TEXT,
        rating INTEGER DEFAULT 5,
        entry_at INTEGER NOT NULL,
        closed_at INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_journal_status ON journal_entries(status, entry_at DESC);
    `);
  }

  insertAlert(alert) {
    const stmt = this.db.prepare(`
      INSERT INTO alerts (
        symbol, type, priority, side, action, title, message,
        ltp, chg_pct, agree, total_checks, strength_score,
        ob_bot, ob_top, ob_dist_pct, ob_str, ob_status,
        invalidation, target1, target2, reviewed, created_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, 0, ?
      )
    `);
    const res = stmt.run(
      alert.symbol,
      alert.type,
      alert.priority || 'NORMAL',
      alert.side || 'FLAT',
      alert.action || null,
      alert.title,
      alert.message,
      alert.ltp ?? null,
      alert.chgPct ?? null,
      alert.agree ?? null,
      alert.totalChecks ?? null,
      alert.strengthScore ?? null,
      alert.obBot ?? null,
      alert.obTop ?? null,
      alert.obDistPct ?? null,
      alert.obStr ?? null,
      alert.obStatus ?? null,
      alert.invalidation ?? null,
      alert.target1 ?? null,
      alert.target2 ?? null,
      alert.createdAt || Date.now()
    );
    return Number(res.lastInsertRowid);
  }

  getLastAlertTime(symbol, type) {
    const stmt = this.db.prepare(`
      SELECT created_at FROM alerts
      WHERE symbol = ? AND type = ?
      ORDER BY created_at DESC LIMIT 1
    `);
    const row = stmt.get(symbol, type);
    return row ? Number(row.created_at) : null;
  }

  listAlerts(limit = 60, includeReviewed = true) {
    const sql = includeReviewed
      ? `SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM alerts WHERE reviewed = 0 ORDER BY created_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(limit);
    return rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      type: r.type,
      priority: r.priority,
      side: r.side,
      action: r.action,
      title: r.title,
      message: r.message,
      ltp: r.ltp,
      chgPct: r.chg_pct,
      agree: r.agree,
      totalChecks: r.total_checks,
      strengthScore: r.strength_score,
      obBot: r.ob_bot,
      obTop: r.ob_top,
      obDistPct: r.ob_dist_pct,
      obStr: r.ob_str,
      obStatus: r.ob_status,
      invalidation: r.invalidation,
      target1: r.target1,
      target2: r.target2,
      reviewed: Boolean(r.reviewed),
      createdAt: r.created_at,
    }));
  }

  markAlertReviewed(id, reviewed = true) {
    this.db.prepare(`UPDATE alerts SET reviewed = ? WHERE id = ?`).run(reviewed ? 1 : 0, id);
  }

  markAllAlertsReviewed() {
    this.db.prepare(`UPDATE alerts SET reviewed = 1 WHERE reviewed = 0`).run();
  }

  addReminder({ symbol, expectedSide, obBot, obTop, note, minutes = 15, nowMs = Date.now() }) {
    const dueAt = nowMs + Math.max(1, Number(minutes)) * 60 * 1000;
    const stmt = this.db.prepare(`
      INSERT INTO reminders (symbol, expected_side, ob_bot, ob_top, note, due_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?)
    `);
    const res = stmt.run(
      symbol.toUpperCase(),
      expectedSide || null,
      obBot ?? null,
      obTop ?? null,
      note || null,
      dueAt,
      nowMs
    );
    return {
      id: Number(res.lastInsertRowid),
      symbol: symbol.toUpperCase(),
      expectedSide: expectedSide || null,
      obBot: obBot ?? null,
      obTop: obTop ?? null,
      note: note || null,
      dueAt,
      status: 'PENDING',
      createdAt: nowMs,
    };
  }

  getDueReminders(nowMs = Date.now()) {
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE status = 'PENDING' AND due_at <= ?
      ORDER BY due_at ASC
    `).all(nowMs);
    return rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      expectedSide: r.expected_side,
      obBot: r.ob_bot,
      obTop: r.ob_top,
      note: r.note,
      dueAt: r.due_at,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  listPendingReminders() {
    const rows = this.db.prepare(`
      SELECT * FROM reminders
      WHERE status = 'PENDING'
      ORDER BY due_at ASC
    `).all();
    return rows.map(r => ({
      id: r.id,
      symbol: r.symbol,
      expectedSide: r.expected_side,
      obBot: r.ob_bot,
      obTop: r.ob_top,
      note: r.note,
      dueAt: r.due_at,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  markReminderFired(id, nowMs = Date.now()) {
    this.db.prepare(`UPDATE reminders SET status = 'FIRED', fired_at = ? WHERE id = ?`).run(nowMs, id);
  }

  cancelReminder(id) {
    this.db.prepare(`UPDATE reminders SET status = 'CANCELLED' WHERE id = ?`).run(id);
  }

  snoozeSymbol(symbol, minutes = 30, nowMs = Date.now()) {
    const untilAt = nowMs + Math.max(1, Number(minutes)) * 60 * 1000;
    this.db.prepare(`
      INSERT INTO snoozes (symbol, until_at, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET until_at = excluded.until_at, created_at = excluded.created_at
    `).run(symbol.toUpperCase(), untilAt, nowMs);
    return { symbol: symbol.toUpperCase(), untilAt };
  }

  unsnoozeSymbol(symbol) {
    this.db.prepare(`DELETE FROM snoozes WHERE symbol = ?`).run(symbol.toUpperCase());
  }

  isSymbolSnoozed(symbol, nowMs = Date.now()) {
    const row = this.db.prepare(`SELECT until_at FROM snoozes WHERE symbol = ?`).get(symbol.toUpperCase());
    if (!row) return false;
    if (Number(row.until_at) <= nowMs) {
      this.unsnoozeSymbol(symbol);
      return false;
    }
    return true;
  }

  listActiveSnoozes(nowMs = Date.now()) {
    this.db.prepare(`DELETE FROM snoozes WHERE until_at <= ?`).run(nowMs);
    return this.db.prepare(`SELECT symbol, until_at AS untilAt, created_at AS createdAt FROM snoozes ORDER BY until_at ASC`).all();
  }

  getSavedSettings() {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'config'`).get();
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  saveSettings(configObj) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES ('config', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify(configObj));
  }

  upsertTrackerItem({
    symbol,
    mode = 'SELL_WATCH',
    entryPrice = null,
    targetPrice = null,
    stopPrice = null,
    qty = null,
    notes = null,
    nowMs = Date.now(),
  }) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) throw new Error('symbol is required');
    const cleanMode = mode === 'BUY_WATCH' ? 'BUY_WATCH' : 'SELL_WATCH';
    const numOrNull = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

    this.db.prepare(`
      INSERT INTO tracker_positions (
        symbol, mode, entry_price, target_price, stop_price, qty, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET
        mode = excluded.mode,
        entry_price = COALESCE(excluded.entry_price, tracker_positions.entry_price),
        target_price = excluded.target_price,
        stop_price = excluded.stop_price,
        qty = COALESCE(excluded.qty, tracker_positions.qty),
        notes = COALESCE(excluded.notes, tracker_positions.notes),
        updated_at = excluded.updated_at
    `).run(
      sym,
      cleanMode,
      numOrNull(entryPrice),
      numOrNull(targetPrice),
      numOrNull(stopPrice),
      numOrNull(qty),
      notes ? String(notes).trim() : null,
      nowMs,
      nowMs
    );

    return this.getTrackerItem(sym);
  }

  updateTrackerMode(symbol, mode, extra = {}, nowMs = Date.now()) {
    const sym = String(symbol || '').trim().toUpperCase();
    const cleanMode = mode === 'BUY_WATCH' ? 'BUY_WATCH' : 'SELL_WATCH';
    const existing = this.getTrackerItem(sym);
    if (!existing) {
      return this.upsertTrackerItem({ symbol: sym, mode: cleanMode, ...extra, nowMs });
    }
    const numOrNull = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
    const entryPrice = extra.entryPrice !== undefined ? numOrNull(extra.entryPrice) : existing.entryPrice;
    const targetPrice = extra.targetPrice !== undefined ? numOrNull(extra.targetPrice) : existing.targetPrice;
    const stopPrice = extra.stopPrice !== undefined ? numOrNull(extra.stopPrice) : existing.stopPrice;
    const notes = extra.notes !== undefined ? (extra.notes ? String(extra.notes).trim() : null) : existing.notes;

    this.db.prepare(`
      UPDATE tracker_positions
      SET mode = ?, entry_price = ?, target_price = ?, stop_price = ?, notes = ?, updated_at = ?
      WHERE symbol = ?
    `).run(cleanMode, entryPrice, targetPrice, stopPrice, notes, nowMs, sym);

    return this.getTrackerItem(sym);
  }

  updateTrackerVerdict(symbol, verdict, alertFiredAt = null) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (alertFiredAt) {
      this.db.prepare(`UPDATE tracker_positions SET last_verdict = ?, last_alert_at = ? WHERE symbol = ?`).run(
        verdict,
        alertFiredAt,
        sym
      );
    } else {
      this.db.prepare(`UPDATE tracker_positions SET last_verdict = ? WHERE symbol = ?`).run(verdict, sym);
    }
  }

  removeTrackerItem(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    this.db.prepare(`DELETE FROM tracker_positions WHERE symbol = ?`).run(sym);
  }

  getTrackerItem(symbol) {
    const sym = String(symbol || '').trim().toUpperCase();
    const r = this.db.prepare(`SELECT * FROM tracker_positions WHERE symbol = ?`).get(sym);
    if (!r) return null;
    return this._mapTrackerRow(r);
  }

  listTrackerItems() {
    const rows = this.db.prepare(`SELECT * FROM tracker_positions ORDER BY updated_at DESC`).all();
    return rows.map(r => this._mapTrackerRow(r));
  }

  _mapTrackerRow(r) {
    return {
      id: r.id,
      symbol: r.symbol,
      mode: r.mode,
      entryPrice: r.entry_price,
      targetPrice: r.target_price,
      stopPrice: r.stop_price,
      qty: r.qty,
      notes: r.notes,
      lastVerdict: r.last_verdict,
      lastAlertAt: r.last_alert_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  createJournalEntry({
    symbol,
    side = 'LONG',
    status = 'OPEN',
    qty = 1,
    entryPrice,
    exitPrice = null,
    stopPrice = null,
    targetPrice = null,
    obZone = null,
    setupType = 'Order Block Pullback',
    thesis = null,
    lessons = null,
    rating = 5,
    entryAt = Date.now(),
    closedAt = null,
    nowMs = Date.now(),
  }) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) throw new Error('symbol is required');
    const cleanSide = String(side || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG';
    const cleanStatus = ['OPEN', 'CLOSED', 'WATCHLIST'].includes(String(status || '').toUpperCase())
      ? String(status).toUpperCase()
      : 'OPEN';
    const numOrNull = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
    const q = Math.max(0.01, Number(qty) || 1);
    const ep = Number(entryPrice) || 0;

    const res = this.db
      .prepare(`
        INSERT INTO journal_entries (
          symbol, side, status, qty, entry_price, exit_price, stop_price, target_price,
          ob_zone, setup_type, thesis, lessons, rating, entry_at, closed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sym,
        cleanSide,
        cleanStatus,
        q,
        ep,
        numOrNull(exitPrice),
        numOrNull(stopPrice),
        numOrNull(targetPrice),
        obZone ? String(obZone).trim() : null,
        setupType ? String(setupType).trim() : 'Order Block Pullback',
        thesis ? String(thesis).trim() : null,
        lessons ? String(lessons).trim() : null,
        Math.max(1, Math.min(5, Number(rating) || 5)),
        Number(entryAt) || nowMs,
        cleanStatus === 'CLOSED' ? Number(closedAt) || nowMs : numOrNull(closedAt),
        nowMs
      );

    return this.getJournalEntry(Number(res.lastInsertRowid));
  }

  updateJournalEntry(id, patch = {}, nowMs = Date.now()) {
    const existing = this.getJournalEntry(id);
    if (!existing) throw new Error(`Journal entry #${id} not found`);
    const numOrNull = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

    const status = patch.status ? String(patch.status).toUpperCase() : existing.status;
    const exitPrice = patch.exitPrice !== undefined ? numOrNull(patch.exitPrice) : existing.exitPrice;
    const stopPrice = patch.stopPrice !== undefined ? numOrNull(patch.stopPrice) : existing.stopPrice;
    const targetPrice = patch.targetPrice !== undefined ? numOrNull(patch.targetPrice) : existing.targetPrice;
    const qty = patch.qty !== undefined ? Math.max(0.01, Number(patch.qty) || existing.qty) : existing.qty;
    const entryPrice = patch.entryPrice !== undefined ? Number(patch.entryPrice) || existing.entryPrice : existing.entryPrice;
    const thesis = patch.thesis !== undefined ? (patch.thesis ? String(patch.thesis).trim() : null) : existing.thesis;
    const lessons = patch.lessons !== undefined ? (patch.lessons ? String(patch.lessons).trim() : null) : existing.lessons;
    const setupType = patch.setupType !== undefined ? String(patch.setupType).trim() : existing.setupType;
    const rating = patch.rating !== undefined ? Math.max(1, Math.min(5, Number(patch.rating) || 5)) : existing.rating;
    const closedAt = status === 'CLOSED' ? existing.closedAt || nowMs : null;

    this.db
      .prepare(`
        UPDATE journal_entries
        SET status = ?, qty = ?, entry_price = ?, exit_price = ?, stop_price = ?, target_price = ?,
            setup_type = ?, thesis = ?, lessons = ?, rating = ?, closed_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        status,
        qty,
        entryPrice,
        exitPrice,
        stopPrice,
        targetPrice,
        setupType,
        thesis,
        lessons,
        rating,
        closedAt,
        nowMs,
        Number(id)
      );

    return this.getJournalEntry(id);
  }

  deleteJournalEntry(id) {
    this.db.prepare(`DELETE FROM journal_entries WHERE id = ?`).run(Number(id));
  }

  getJournalEntry(id) {
    const r = this.db.prepare(`SELECT * FROM journal_entries WHERE id = ?`).get(Number(id));
    return r ? this._mapJournalRow(r) : null;
  }

  listJournalEntries() {
    const rows = this.db.prepare(`SELECT * FROM journal_entries ORDER BY CASE WHEN status = 'OPEN' THEN 0 ELSE 1 END, entry_at DESC`).all();
    return rows.map(r => this._mapJournalRow(r));
  }

  _mapJournalRow(r) {
    return {
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      status: r.status,
      qty: r.qty,
      entryPrice: r.entry_price,
      exitPrice: r.exit_price,
      stopPrice: r.stop_price,
      targetPrice: r.target_price,
      obZone: r.ob_zone,
      setupType: r.setup_type,
      thesis: r.thesis,
      lessons: r.lessons,
      rating: r.rating,
      entryAt: r.entry_at,
      closedAt: r.closed_at,
      updatedAt: r.updated_at,
    };
  }

  close() {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}

module.exports = { FlowStore };

