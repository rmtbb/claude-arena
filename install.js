#!/usr/bin/env node
/*
 * Claude Arena — hook installer.
 *
 * Appends a fast, async, fire-and-forget capture hook to each relevant Claude
 * Code event in ~/.claude/settings.json. It runs ALONGSIDE any existing hooks
 * (e.g. "Claudio Symphony") — it never replaces them.
 *
 * Safe to run repeatedly (idempotent): it detects its own already-installed
 * entries by command path and skips them. Backs up settings.json first.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.join(__dirname, 'hooks', 'arena-hook.sh');

// The events we react to. These are exactly the events confirmed to fire on this
// machine (present in the existing settings.json). The hook is schema-agnostic,
// so adding/removing events here is the only knob you need.
const EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop',
  'PreToolUse', 'PostToolUse', 'SubagentStop', 'Notification', 'PreCompact',
];

function quoteIfNeeded(p) {
  return /\s/.test(p) ? `'${p}'` : p;
}

function main() {
  if (!fs.existsSync(HOOK)) {
    console.error(`✗ Hook script not found at ${HOOK}`);
    process.exit(1);
  }
  // Make the hook executable.
  try { fs.chmodSync(HOOK, 0o755); } catch (_) {}

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
    } catch (e) {
      console.error(`✗ Could not parse ${SETTINGS}: ${e.message}`);
      console.error('  Refusing to modify a file I cannot parse. Fix the JSON and re-run.');
      process.exit(1);
    }
    // Backup.
    const backup = `${SETTINGS}.arena-backup-${Date.now()}`;
    fs.copyFileSync(SETTINGS, backup);
    console.log(`• Backed up settings → ${backup}`);
  } else {
    console.log(`• No settings.json found; creating a fresh one at ${SETTINGS}`);
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  }

  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

  const command = quoteIfNeeded(HOOK);
  const entry = {
    matcher: '*',
    hooks: [{ type: 'command', command, timeout: 5, async: true }],
  };

  let added = 0, skipped = 0;
  for (const ev of EVENTS) {
    if (!Array.isArray(settings.hooks[ev])) settings.hooks[ev] = [];
    const already = settings.hooks[ev].some((block) =>
      Array.isArray(block.hooks) &&
      block.hooks.some((h) => typeof h.command === 'string' && h.command.includes('arena-hook.sh'))
    );
    if (already) { skipped++; continue; }
    settings.hooks[ev].push(JSON.parse(JSON.stringify(entry)));
    added++;
  }

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');

  console.log(`\n✓ Claude Arena hooks installed.`);
  console.log(`  added: ${added} event(s), already present: ${skipped}`);
  console.log(`  hook : ${HOOK}`);
  console.log(`\nNext:`);
  console.log(`  node server.js          # start the arena (then open http://localhost:4787)`);
  console.log(`  node server.js --demo   # preview with synthetic life`);
  console.log(`\nNew Claude Code sessions will start populating the world automatically.`);
  console.log(`To remove: node uninstall.js\n`);
}

main();
