/**
 * slint-runner.js — Standalone child process for executing Slint components
 * loaded dynamically from NFC card payloads.
 *
 * Usage (spawned by main.js):
 *   node slint-runner.js
 *
 * Protocol (line-delimited JSON over stdin/stdout):
 *   stdin  ← { type: "run",   code: "<slint source>" }
 *   stdin  ← { type: "close" }
 *   stdout → { type: "ready" }
 *   stdout → { type: "error", message: "<description>" }
 *   stdout → { type: "closed" }
 */

'use strict';

/**
 * Send a JSON message to the parent process on stdout.
 * @param {object} msg
 */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Signal to the parent that we are running and ready for instructions
send({ type: 'ready' });

let slint;
try {
  slint = require('slint-ui');
} catch (err) {
  send({ type: 'error', message: `Failed to load slint-ui: ${err.message}` });
  process.exit(1);
}

// Buffer for partial stdin data
let stdinBuf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  // Process all complete newline-terminated JSON messages
  let nl;
  while ((nl = stdinBuf.indexOf('\n')) !== -1) {
    const line = stdinBuf.slice(0, nl).trim();
    stdinBuf = stdinBuf.slice(nl + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      send({ type: 'error', message: 'Invalid JSON received by slint-runner' });
      continue;
    }

    handleMessage(msg);
  }
});

process.stdin.on('end', () => {
  // Parent closed stdin — clean up and exit
  try { slint.quitEventLoop(); } catch (_) {}
});

/**
 * Handle a message received from the parent process.
 * @param {{ type: string, code?: string }} msg
 */
async function handleMessage(msg) {
  if (msg.type === 'run') {
    await runSlintCode(msg.code || '');
  } else if (msg.type === 'close') {
    try { slint.quitEventLoop(); } catch (_) {}
    send({ type: 'closed' });
    process.exit(0);
  }
}

/**
 * Compile and run a Slint component from source code.
 * @param {string} code  Raw Slint source read from the NFC card.
 */
async function runSlintCode(code) {
  let componentDefs;
  try {
    // loadSource compiles the Slint code in-process using the Slint interpreter.
    // The second argument is a virtual "file path" used for resolving relative
    // imports and diagnostic messages — it does not need to exist on disk.
    componentDefs = slint.loadSource(code, 'nfc-card.slint');
  } catch (err) {
    send({ type: 'error', message: `Slint compile error: ${err.message || String(err)}` });
    return;
  }

  // Find the first exported component to instantiate
  const exportedNames = Object.keys(componentDefs);
  if (!exportedNames.length) {
    send({ type: 'error', message: 'Slint code compiled but exported no components.' });
    return;
  }

  const ComponentClass = componentDefs[exportedNames[0]];
  let instance;
  try {
    instance = new ComponentClass();
  } catch (err) {
    send({ type: 'error', message: `Slint instantiation error: ${err.message || String(err)}` });
    return;
  }

  try {
    // run() shows the window and starts the Slint event loop.
    // It resolves when the window is closed by the user.
    await instance.run();
    send({ type: 'closed' });
    process.exit(0);
  } catch (err) {
    send({ type: 'error', message: `Slint runtime error: ${err.message || String(err)}` });
    process.exit(1);
  }
}
