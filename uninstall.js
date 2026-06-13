#!/usr/bin/env node
/* Claude Arena — remove the capture hooks from ~/.claude/settings.json.
 * Leaves all other hooks (e.g. Claudio Symphony) untouched. Backs up first. */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function main() {
  if (!fs.existsSync(SETTINGS)) { console.log('Nothing to do — no settings.json.'); return; }
  let settings;
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) { console.error(`✗ Cannot parse settings.json: ${e.message}`); process.exit(1); }

  fs.copyFileSync(SETTINGS, `${SETTINGS}.arena-backup-${Date.now()}`);

  let removed = 0;
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    const before = hooks[ev].length;
    hooks[ev] = hooks[ev].filter((block) => {
      if (!Array.isArray(block.hooks)) return true;
      block.hooks = block.hooks.filter((h) => !(typeof h.command === 'string' && h.command.includes('arena-hook.sh')));
      return block.hooks.length > 0;
    });
    removed += before - hooks[ev].length;
    if (hooks[ev].length === 0) delete hooks[ev];
  }

  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`✓ Removed ${removed} arena hook block(s). Other hooks left intact.`);
}

main();
