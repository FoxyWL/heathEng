#!/usr/bin/env node
'use strict';
// Имитация SteamCMD: пишет прогресс и раскладывает "серверные" файлы.
const fs = require('fs');
const path = require('path');
const a = process.argv.slice(2);
const dir = a[a.indexOf('+force_install_dir') + 1];
const id = +a[a.indexOf('+app_update') + 1];
const root = path.join(__dirname);
if (id === 999) {
  console.log("ERROR! Failed to install app '999' (No subscription)");
  process.exit(8);
}
for (const p of [10, 45, 80, 100]) process.stdout.write(`Update state (0x61) downloading, progress: ${p}.00 (${p} / 100)\r`);
console.log('');
fs.mkdirSync(dir, { recursive: true });
const files = { 896660: ['valheim_server.x86_64'], 2394010: ['PalServer.sh'], 12345: ['run.sh'] }[id] || ['server.bin'];
for (const f of files) {
  fs.writeFileSync(path.join(dir, f), `#!/bin/sh\nexec node ${root}/fake-udp.js "$@"\n`, { mode: 0o755 });
}
fs.writeFileSync(path.join(dir, 'steam-args.txt'), a.join(' '));
console.log(`Success! App '${id}' fully installed.`);
