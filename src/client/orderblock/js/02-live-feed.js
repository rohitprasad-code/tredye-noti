/* OrderBlock 5-Stage Visual Funnel Live Feed (Unlocked, Real-Time 218 NSE F&O) */
(function () {
  "use strict";
  var feed = window.OBF_FEED = {
    data: null,
    etag: "",
    onUpdate: null,
    onStatus: null,
    status: { state: "LIVE", mode: "rest" },
    filter: { sector: "ALL", side: "ALL", sort: "MAX_GAINS" }
  };
  var LG = window.OBF_LOGOS = { v: "", m: {} };
  var PEEK = window.OB_PEEK = /[?&]peek=1(?:&|$)/.test(location.search);
  window.OB_LOCKED = 0;
  var ready;
  feed.ready = new Promise(function (r) { ready = r; });

  feed.chart = function () { return Promise.resolve(null); };

  var busy = false;
  function load(opts) {
    if (opts) {
      if (opts.sector !== undefined) feed.filter.sector = opts.sector;
      if (opts.side !== undefined) feed.filter.side = opts.side;
      if (opts.sort !== undefined) feed.filter.sort = opts.sort;
    }
    if (busy && !opts) return Promise.resolve();
    busy = true;
    var qs = "?sector=" + encodeURIComponent(feed.filter.sector) +
             "&side=" + encodeURIComponent(feed.filter.side) +
             "&sort=" + encodeURIComponent(feed.filter.sort);
    return fetch("/api/ob/live/snapshot" + qs, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("feed " + res.status);
        return res.json();
      })
      .then(function (d) {
        feed.at = Date.now();
        if (!d || !d.stocks || !d.stocks.length) return;
        if (!feed.data) {
          feed.data = d;
          ready();
        } else if (feed.onUpdate) {
          feed.data = d;
          feed.onUpdate(d);
        }
      })
      .catch(function (err) { console.warn("OBF_FEED load error:", err); })
      .then(function () { busy = false; });
  }

  feed.load = load;
  load();

  // Real-time SSE subscription to local server poll cycle & Upstox connection state
  if (!PEEK && typeof EventSource !== "undefined") {
    try {
      var es = new EventSource("/api/events");
      var lastPoll = 0;
      var lastReloadAt = 0;
      var staleWhileHidden = false;
      es.addEventListener("state", function (ev) {
        try {
          var st = JSON.parse(ev.data);
          if (st && st.upstox) {
            feed.status = {
              state: st.upstox.tokenExpired ? "EXPIRED" : st.upstox.wsConnected ? "WS LIVE" : "LIVE",
              mode: st.upstox.wsConnected ? "ws" : "rest",
              tokenExpired: Boolean(st.upstox.tokenExpired),
            };
            if (typeof feed.onStatus === "function") feed.onStatus(feed.status);
          }
          if (st && st.lastPollAt && st.lastPollAt !== lastPoll) {
            var now = Date.now();
            if (lastPoll !== 0 && now - lastReloadAt >= 2500) {
              if (typeof document !== "undefined" && document.hidden) {
                staleWhileHidden = true;
              } else {
                lastReloadAt = now;
                load();
              }
            }
            lastPoll = st.lastPollAt;
          }
        } catch (e) {}
      });
      if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("visibilitychange", function () {
          if (!document.hidden && staleWhileHidden) {
            staleWhileHidden = false;
            lastReloadAt = Date.now();
            load();
          }
        });
      }
      es.addEventListener("upstox", function (ev) {
        try {
          var u = JSON.parse(ev.data);
          if (u) {
            feed.status = {
              state: u.state === "auth_expired" ? "EXPIRED" : u.mode === "ws" && u.state === "connected" ? "WS LIVE" : "LIVE",
              mode: u.mode || "rest",
              tokenExpired: u.state === "auth_expired",
            };
            if (typeof feed.onStatus === "function") feed.onStatus(feed.status);
          }
        } catch (e) {}
      });
    } catch (e) {}
  }
  if (!PEEK) setInterval(function () {
    if (typeof document !== "undefined" && document.hidden) return;
    load();
  }, 60000);
})();
