/* OrderBlock · light theme. The terminal follows the app's sun / moon toggle: the parent page posts
   {t:'ob-theme'} on every change. Dark until the member picks a theme; "System" follows the device. The dark
   design draws on canvases with dark-theme colours; in light mode those colours are remapped as they
   are set (fill / stroke / shadow / gradient stops), and additive glow blending becomes multiply. */
(function () {
  'use strict';
  var root = document.documentElement, TH = { light: false };
  var C2D = window.CanvasRenderingContext2D, GRAD = window.CanvasGradient;
  var hooked = false, origDesc = {}, origMethods = {}, origAddStop = null;
  var mqDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var mqLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function systemTheme() {
    if (mqLight && mqLight.matches) return 'light';
    if (mqDark && mqDark.matches) return 'dark';
    return 'dark';
  }
  function explicitCookie() {
    var m = /(?:^|;\s*)ob_theme=(light|dark)(?:;|$)/.exec(document.cookie);
    return m ? m[1] : null;
  }
  function chosen() {
    try { if (window.parent !== window) { var p = window.parent.document.documentElement.getAttribute('data-theme'); return p === 'light' || p === 'dark' ? p : 'system'; } } catch (e) { }
    return explicitCookie() || 'system';
  }
  function resolve() { var c = chosen(); return c !== 'system' ? c : systemTheme(); }
  function syncMetaAndBtns(theme) {
    var meta = document.querySelector && document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = explicitCookie() || 'light dark';
    if (document.querySelectorAll) {
      var btns = document.querySelectorAll('#obSideRail .rt-btn');
      for (var i = 0; i < btns.length; i++) {
        var isOn = btns[i].getAttribute('data-theme-set') === theme;
        btns[i].classList.toggle('on', isOn);
        btns[i].setAttribute('aria-pressed', isOn ? 'true' : 'false');
      }
    }
  }
  function set(t, redraw) {
    var light = t === 'light';
    var themeName = light ? 'light' : 'dark';
    root.setAttribute('data-theme', themeName);
    if (root.style) root.style.colorScheme = themeName;
    syncMetaAndBtns(themeName);
    syncCanvasHooks(light);
    if (light === TH.light) return;
    TH.light = light;
    // the terminal repaints on resize (its own debounced handler): the new colours apply on that pass
    if (redraw) window.dispatchEvent(new Event('resize'));
  }
  set(resolve(), false);
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data && e.data.t === 'ob-theme' && (e.data.theme === 'light' || e.data.theme === 'dark')) set(e.data.theme, true);
  });
  var sys = function () { if (chosen() === 'system') set(resolve(), true); };
  [mqDark, mqLight].forEach(function (mq) {
    if (!mq) return;
    if (mq.addEventListener) mq.addEventListener('change', sys);
    else if (mq.addListener) mq.addListener(sys);
  });

  /* ---- dark design colour -> light colour. [r, g, b, alpha factor] ---- */
  var LT = {
    '0,0,0': [0, 0, 0],                                                   // alpha masks stay masks
    // light "ink" of the dark design -> navy ink
    '255,255,255': [15, 23, 42], '232,241,255': [28, 38, 64], '244,247,251': [15, 23, 42], '244,247,255': [15, 23, 42],
    '236,242,250': [15, 23, 42], '238,243,250': [11, 18, 32], '210,222,245': [15, 23, 42], '201,212,229': [11, 18, 32],
    '220,228,240': [40, 52, 78],
    // violet / blue glows -> brand indigo
    '169,184,255': [88, 86, 242], '91,108,255': [88, 86, 242], '120,150,255': [88, 86, 242],
    // greys
    '154,168,189': [70, 84, 106], '94,108,130': [95, 107, 128], '122,138,160': [95, 107, 128], '118,130,154': [150, 160, 176],
    '86,98,122': [163, 173, 189], '74,84,104': [163, 173, 189], '63,75,94': [154, 164, 180], '58,70,88': [195, 203, 215],
    '26,36,51': [220, 226, 235],
    // dark surfaces (label backs, order seams, the wedge) -> light surfaces
    '10,15,23': [255, 255, 255], '4,6,10': [255, 255, 255], '4,7,11': [255, 255, 255, 1.4], '5,7,11': [255, 255, 255],
    '2,3,5': [233, 237, 243],
    // bull
    '25,229,140': [14, 159, 99], '124,255,196': [8, 122, 74], '201,255,233': [5, 96, 58], '14,122,73': [143, 212, 179],
    '30,158,110': [61, 170, 124], '38,190,128': [20, 160, 100],
    // bear
    '255,59,92': [226, 61, 79], '255,154,168': [194, 29, 60], '255,211,220': [151, 17, 44], '163,23,46': [240, 160, 176],
    '194,58,82': [217, 84, 109], '214,64,92': [214, 58, 86],
    // amber / crash / structure blue
    '255,176,32': [194, 120, 0], '255,196,120': [214, 140, 40], '255,227,176': [160, 90, 0], '255,106,77': [210, 70, 31],
    '47,107,255': [43, 100, 240], '111,163,255': [37, 99, 235], '156,192,255': [37, 99, 235]
  };
  // the ladder's herd bars are the mute colours desaturated by 30% (computed exactly as the page does)
  function desatKey(h, f) { var c = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)], g = (c[0] + c[1] + c[2]) / 3; return c.map(function (v) { return (v + (g - v) * f) | 0; }).join(','); }
  LT[desatKey('#1E9E6E', .3)] = [88, 168, 132]; LT[desatKey('#C23A52', .3)] = [214, 110, 128];
  // heat ramps (plume, tile book): an interpolated dark colour maps to the same point on the light ramp
  var RAMPS = [
    [[0, 5, 16, 12], [.30, 10, 43, 31], [.55, 15, 94, 64], [.80, 30, 158, 110], [1, 111, 224, 180]],
    [[0, 238, 246, 242], [.30, 200, 233, 216], [.55, 126, 205, 166], [.80, 61, 170, 124], [1, 10, 122, 75]],
    [[0, 18, 6, 10], [.30, 58, 13, 23], [.55, 126, 26, 44], [.80, 194, 58, 82], [1, 240, 138, 156]],
    [[0, 252, 240, 242], [.30, 245, 205, 213], [.55, 236, 140, 159], [.80, 217, 84, 109], [1, 179, 24, 58]],
    [[0, 11, 58, 45], [.5, 25, 229, 140], [1, 201, 255, 233]],
    [[0, 190, 230, 210], [.5, 14, 159, 99], [1, 5, 96, 58]],
    [[0, 62, 12, 23], [.5, 255, 59, 92], [1, 255, 211, 220]],
    [[0, 247, 205, 213], [.5, 226, 61, 79], [1, 151, 17, 44]]
  ];
  function onRamp(r, g, b, tol) {
    var best = null, bd = tol || 1.8;
    for (var q = 0; q < RAMPS.length; q += 2) {
      var D = RAMPS[q];
      for (var i = 0; i < D.length - 1; i++) {
        var a = D[i], z = D[i + 1], dx = z[1] - a[1], dy = z[2] - a[2], dz = z[3] - a[3], ll = dx * dx + dy * dy + dz * dz;
        var f = ll ? ((r - a[1]) * dx + (g - a[2]) * dy + (b - a[3]) * dz) / ll : 0; f = f < 0 ? 0 : f > 1 ? 1 : f;
        var ex = r - a[1] - f * dx, ey = g - a[2] - f * dy, ez = b - a[3] - f * dz, d = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (d < bd) { bd = d; best = [q + 1, a[0] + f * (z[0] - a[0])]; }
      }
    }
    if (!best) return null;
    var Lr = RAMPS[best[0]], t = best[1], k = 0;
    while (k < Lr.length - 2 && t > Lr[k + 1][0]) k++;
    var s = Lr[k], e = Lr[k + 1], u = (t - s[0]) / (e[0] - s[0] || 1);
    return [Math.round(s[1] + (e[1] - s[1]) * u), Math.round(s[2] + (e[2] - s[2]) * u), Math.round(s[3] + (e[3] - s[3]) * u)];
  }
  // ramp colours the page blends further: the plume's bull/bear split lanes (60% toward the neutral lane
  // #3A4658) and the event tile's book (75% toward its own grey). Undo the blend, map, blend again.
  function onBlend(r, g, b) {
    var s = onRamp((r - 34.8) / 0.4, (g - 42) / 0.4, (b - 52.8) / 0.4, 4.5);
    if (s) return [Math.round(0.4 * s[0] + 117), Math.round(0.4 * s[1] + 121.8), Math.round(0.4 * s[2] + 129)];
    var m = (r + g + b) / 3; s = onRamp((r - 0.75 * m) / 0.25, (g - 0.75 * m) / 0.25, (b - 0.75 * m) / 0.25, 7.5);
    if (s) { var n = (s[0] + s[1] + s[2]) / 3; return [Math.round(0.25 * s[0] + 0.75 * n), Math.round(0.25 * s[1] + 0.75 * n), Math.round(0.25 * s[2] + 0.75 * n)]; }
    return null;
  }
  // anything else (a few blended colours): hue-preserving lightness inversion in OKLab
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function gam(c) { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.round(Math.max(0, Math.min(1, c)) * 255); }
  function toLab(r, g, b) {
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function fromLab(L, a, b) {
    var l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3), m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3), s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  function inGamut(x) { return x[0] > -1e-4 && x[0] < 1.0001 && x[1] > -1e-4 && x[1] < 1.0001 && x[2] > -1e-4 && x[2] < 1.0001; }
  function invert(r, g, b) {
    var o = toLab(lin(r), lin(g), lin(b)), L = o[0], C = Math.sqrt(o[1] * o[1] + o[2] * o[2]), h = Math.atan2(o[2], o[1]);
    var w = Math.max(0, Math.min(1, (C - 0.02) / 0.05)); w = w * w * (3 - 2 * w);
    var L2 = Math.max(0.2, Math.min(0.975, (0.985 - 0.86 * L) * (1 - w) + (1.04 - 0.56 * L) * w)), lo = 0, hi = C, x = fromLab(L2, C * Math.cos(h), C * Math.sin(h));
    if (!inGamut(x)) { for (var i = 0; i < 16; i++) { var mid = (lo + hi) / 2; if (inGamut(fromLab(L2, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid; else hi = mid; } x = fromLab(L2, lo * Math.cos(h), lo * Math.sin(h)); }
    return [gam(x[0]), gam(x[1]), gam(x[2])];
  }
  var TRIP = new Map();
  function lightOf(r, g, b) {
    var k = r + ',' + g + ',' + b, v = TRIP.get(k);
    if (!v) { v = LT[k] || onRamp(r, g, b) || onBlend(r, g, b) || invert(r, g, b); if (TRIP.size > 8192) TRIP.clear(); TRIP.set(k, v); }
    return v;
  }
  var RX = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.eE+-]+)\s*)?\)$/;
  function parse(v) {
    if (v.charCodeAt(0) === 35) {
      var h = v.slice(1); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return h.length === 6 ? [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1] : null;
    }
    var m = RX.exec(v); return m ? [+m[1] | 0, +m[2] | 0, +m[3] | 0, m[4] === undefined ? 1 : +m[4]] : null;
  }
  function out(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000 + ')'; }
  /* light the dark design emits (white drawn with additive blending, radial glows) stays light here:
     it becomes the brand indigo, or the glow's own side colour, instead of navy ink */
  var GLOW = [88, 86, 242];
  function whiteish(p) { return p[0] >= 225 && p[1] >= 225 && p[2] >= 225; }
  var PAINT = new Map(), PAINT_ADD = new Map(), SHADE = new Map();
  function paint(v, add) {
    if (typeof v !== 'string') return v;
    var cache = add ? PAINT_ADD : PAINT, r = cache.get(v); if (r !== undefined) return r;
    var p = parse(v.trim()); r = v;
    if (p) { var c = add && whiteish(p) ? GLOW : lightOf(p[0], p[1], p[2]); r = out(c, p[3] * (c[3] || 1)); }
    if (cache.size > 8192) cache.clear(); cache.set(v, r); return r;
  }
  // gradient stops are mapped when the gradient is first used, once it is known whether it is a glow
  function settle(g, add) {
    var st = g.__stops, hue = null, i, p; g.__stops = null;
    if (g.__radial) for (i = 0; i < st.length && !hue; i++) { p = typeof st[i][1] === 'string' && parse(st[i][1].trim()); if (p && !whiteish(p)) hue = lightOf(p[0], p[1], p[2]); }
    for (i = 0; i < st.length; i++) {
      p = typeof st[i][1] === 'string' && parse(st[i][1].trim());
      origAddStop.call(g, st[i][0], p && whiteish(p) && (g.__radial || add) ? out(hue || GLOW, p[3]) : paint(st[i][1], false));
    }
  }
  // glows become soft coloured shadows; black drop shadows stay dark, only lighter
  function shade(v) {
    if (typeof v !== 'string') return v;
    var r = SHADE.get(v); if (r !== undefined) return r;
    var p = parse(v.trim()); r = v;
    if (p) r = out(p[0] + p[1] + p[2] === 0 ? [15, 23, 42] : lightOf(p[0], p[1], p[2]), p[3] * 0.4);
    if (SHADE.size > 2048) SHADE.clear(); SHADE.set(v, r); return r;
  }
  function syncCanvasHooks(light) {
    if (!C2D || !GRAD) return;
    var P = C2D.prototype;
    if (!origAddStop) {
      origAddStop = GRAD.prototype.addColorStop;
      ['fillStyle', 'strokeStyle', 'shadowColor', 'globalCompositeOperation'].forEach(function (name) {
        origDesc[name] = Object.getOwnPropertyDescriptor(P, name);
      });
      ['createLinearGradient', 'createRadialGradient'].forEach(function (name) {
        origMethods[name] = P[name];
      });
    }
    if (light && !hooked) {
      hooked = true;
      var GCO = origDesc.globalCompositeOperation, addStop = origAddStop;
      var additive = function (ctx) { return !!(GCO && GCO.get) && GCO.get.call(ctx) === 'multiply'; };
      var style = function (v, ctx) { if (typeof v === 'string') return paint(v, additive(ctx)); if (v && v.__stops) settle(v, additive(ctx)); return v; };
      var hook = function (name, fn) {
        var d = origDesc[name]; if (!d || !d.set) return;
        Object.defineProperty(P, name, { configurable: true, enumerable: d.enumerable, get: d.get, set: function (v) { d.set.call(this, TH.light ? fn(v, this) : v); } });
      };
      hook('fillStyle', style); hook('strokeStyle', style); hook('shadowColor', shade);
      hook('globalCompositeOperation', function (v) { return v === 'lighter' ? 'multiply' : v; });
      ['createLinearGradient', 'createRadialGradient'].forEach(function (name) {
        var make = origMethods[name]; if (!make) return;
        P[name] = function () {
          var g = make.apply(this, arguments);
          if (TH.light) { g.__stops = []; g.__radial = name === 'createRadialGradient'; }
          return g;
        };
      });
      GRAD.prototype.addColorStop = function (o, c) {
        if (this.__stops) { this.__stops.push([o, c]); return; }
        return addStop.call(this, o, TH.light ? paint(c, false) : c);
      };
    } else if (!light && hooked) {
      hooked = false;
      Object.keys(origDesc).forEach(function (name) {
        if (origDesc[name]) Object.defineProperty(P, name, origDesc[name]);
      });
      Object.keys(origMethods).forEach(function (name) {
        if (origMethods[name]) P[name] = origMethods[name];
      });
      if (origAddStop) GRAD.prototype.addColorStop = origAddStop;
    }
  }
  syncCanvasHooks(TH.light);
})();
