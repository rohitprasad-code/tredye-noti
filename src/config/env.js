'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadDotEnv(envPath = path.join(process.cwd(), '.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function saveDotEnvKeyValues(
  updates,
  envPath = path.join(process.cwd(), '.env'),
  { updateProcessEnv = true } = {}
) {
  let content = '';
  const defaultEnvPath = path.join(process.cwd(), '.env');
  const exampleEnvPath = path.join(process.cwd(), '.env.example');
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf8');
  } else if (envPath === defaultEnvPath && fs.existsSync(exampleEnvPath)) {
    content = fs.readFileSync(exampleEnvPath, 'utf8');
  }

  for (const [key, val] of Object.entries(updates)) {
    if (val === undefined) continue;
    if (updateProcessEnv) process.env[key] = String(val);
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${val}`);
    } else {
      content += `\n${key}=${val}`;
    }
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, content.trim() + '\n', { mode: 0o600 });
}

module.exports = { loadDotEnv, saveDotEnvKeyValues };
