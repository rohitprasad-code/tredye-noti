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
let cachedLightCss = null;
let cachedJsBundle = null;

function readModule(dir, name) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

function getOrderBlockCssBundle() {
  if (!cachedCssBundle) {
    cachedCssBundle = DARK_CSS_FILES.map((name) => `/* === ${name} === */\n${readModule(CSS_DIR, name)}`).join('\n');
  }
  return cachedCssBundle;
}

function getOrderBlockLightCss() {
  if (!cachedLightCss) {
    cachedLightCss = `/* === ${LIGHT_CSS_FILE} === */\n${readModule(CSS_DIR, LIGHT_CSS_FILE)}`;
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
  if (!cachedJsBundle) {
    const [s1, s2, s3] = getOrderBlockTestScripts();
    cachedJsBundle = `/* === 01-theme-canvas.js === */\n${s1}\n/* === 02-live-feed.js === */\n${s2}\n/* === 03..08 OrderBlock Stage Engine === */\n${s3}`;
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
