const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, 'css');
const JS_DIR = path.join(__dirname, 'js');

const DARK_CSS_FILES = [
  '01-core-stage.css',
  '02-mobile-stack.css',
  '03-shell-ui.css',
];

const LIGHT_CSS_FILE = '04-light-theme.css';

const STAGE_JS_MODULES = [
  '03-math-and-model.js',
  '04-stage-funnel.js',
  '05-tiles-tickets.js',
  '06-fx-inspector.js',
  '07-mobile-stack.js',
  '08-controls-boot.js',
];

let cachedCssBundle = null;
let cachedCssMtime = 0;
let cachedLightCss = null;
let cachedLightMtime = 0;
let cachedJsBundle = null;
let cachedJsMtime = 0;

function readModule(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function maxMtime(dir, names) {
  let max = 0;
  for (const name of names) {
    try {
      const m = fs.statSync(path.join(dir, name)).mtimeMs;
      if (m > max) max = m;
    } catch {}
  }
  return max;
}

function getOrderBlockCssBundle() {
  const mtime = maxMtime(CSS_DIR, DARK_CSS_FILES);
  if (!cachedCssBundle || mtime !== cachedCssMtime) {
    cachedCssBundle = DARK_CSS_FILES.map((name) => `/* === ${name} === */\n${readModule(CSS_DIR, name)}`).join('\n');
    cachedCssMtime = mtime;
  }
  return cachedCssBundle;
}

function getOrderBlockLightCss() {
  const mtime = maxMtime(CSS_DIR, [LIGHT_CSS_FILE]);
  if (!cachedLightCss || mtime !== cachedLightMtime) {
    cachedLightCss = `/* === ${LIGHT_CSS_FILE} === */\n${readModule(CSS_DIR, LIGHT_CSS_FILE)}`;
    cachedLightMtime = mtime;
  }
  return cachedLightCss;
}

function getOrderBlockTestScripts() {
  const s1 = readModule(JS_DIR, '01-theme-canvas.js');
  const s2 = readModule(JS_DIR, '02-live-feed.js');
  const stageBody = STAGE_JS_MODULES.map((name) => `/* === ${name} === */\n${readModule(JS_DIR, name)}`).join('\n');
  const s3 = `(function(){\n"use strict";\n${stageBody}\n})();\n`;
  return [s1, s2, s3];
}

function getOrderBlockJsBundle() {
  const mtime = maxMtime(JS_DIR, ['01-theme-canvas.js', '02-live-feed.js', ...STAGE_JS_MODULES]);
  if (!cachedJsBundle || mtime !== cachedJsMtime) {
    const [s1, s2, s3] = getOrderBlockTestScripts();
    cachedJsBundle = `/* === 01-theme-canvas.js === */\n${s1}\n/* === 02-live-feed.js === */\n${s2}\n/* === 03..08 OrderBlock Stage Engine === */\n${s3}`;
    cachedJsMtime = mtime;
  }
  return cachedJsBundle;
}

module.exports = {
  DARK_CSS_FILES,
  LIGHT_CSS_FILE,
  STAGE_JS_MODULES,
  getOrderBlockCssBundle,
  getOrderBlockLightCss,
  getOrderBlockJsBundle,
  getOrderBlockTestScripts,
};
