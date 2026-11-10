'use strict';
const players = new Set();
const log = (m) => console.log(`[12:00:00] [Server thread/INFO]: ${m}`);
log('Starting minecraft server version fake');
setTimeout(() => log('Done (1.2s)! For help, type "help"'), 300);
setTimeout(() => {
  players.add('Steve');
  log('Steve joined the game');
}, 1200);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  for (const line of d.split('\n').filter(Boolean)) {
    const [cmd, ...rest] = line.trim().split(' ');
    if (cmd === 'stop') {
      log('Stopping server');
      process.exit(0);
    } else if (cmd === 'list') log(`There are ${players.size} of a max of 20 players online: ${[...players].join(', ')}`);
    else if (cmd === 'say') log(`[Server] ${rest.join(' ')}`);
    else if (cmd === 'save-all') log('Saved the game');
    else if (cmd === 'kick' && players.delete(rest[0])) log(`${rest[0]} left the game`);
    else log(`Executed: ${line}`);
  }
});
