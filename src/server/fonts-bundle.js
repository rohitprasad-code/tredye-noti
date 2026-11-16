const fs = require('fs');
const path = require('path');

const NODE_MODULES_DIR = path.resolve(__dirname, '../../node_modules');

const FONT_SPECS = [
  ['space-grotesk', 'latin-600.css'],
  ['space-grotesk', 'latin-700.css'],
  ['inter-tight', 'latin-400.css'],
  ['inter-tight', 'latin-500.css'],
  ['inter-tight', 'latin-600.css'],
  ['inter-tight', 'latin-700.css'],
  ['jetbrains-mono', 'latin-400.css'],
  ['jetbrains-mono', 'latin-500.css'],
  ['jetbrains-mono', 'latin-600.css'],
  ['jetbrains-mono', 'latin-700.css'],
];

let cachedFontsCss = null;

function getFontsBundleCss() {
  if (cachedFontsCss) return cachedFontsCss;
  const chunks = [];
  for (const [pkg, file] of FONT_SPECS) {
    const fullPath = path.join(NODE_MODULES_DIR, '@fontsource', pkg, file);
    if (!fs.existsSync(fullPath)) continue;
    let css = fs.readFileSync(fullPath, 'utf8');
    css = css
      .replace(/url\(\.\/files\//g, `url(/vendor/fonts/${pkg}/files/`)
      .replace(/font-display:\s*swap;/g, 'font-display: swap;');
    chunks.push(`/* @fontsource/${pkg}/${file} */\n${css}`);
  }
  cachedFontsCss = chunks.join('\n');
  return cachedFontsCss;
}

module.exports = {
  getFontsBundleCss,
};
