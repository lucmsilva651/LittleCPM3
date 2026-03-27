/**
 * pm3.js — Proxmark3 interface for MIFARE Classic 1K card storage
 *
 * Storage layout:
 *   Block 0  : manufacturer (read-only, skipped)
 *   Block 1  : metadata (16 bytes)
 *              [0-3]  magic "PM3C"
 *              [4-7]  payload size (uint32 BE)
 *              [8]    chunk index (0-based, for multi-card)
 *              [9]    total chunks (1 = single card)
 *              [10-11] CRC-16/ARC of bytes 0-9
 *              [12-15] reserved
 *   Block 2+ : payload data (skipping sector trailers at 3,7,11,...,63)
 *
 * Capacity: 45 data blocks × 16 bytes = 720 bytes per card
 *
 * Read strategy : hf mf dump  → parse JSON (single round-trip, reliable)
 * Write strategy: hf mf wrbl  with explicit -a (Key A) flag per block
 */

'use strict';

const { spawn } = require('child_process');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');

const MAGIC         = 'PM3C';
const AUTOPWN_TIMEOUT_MS = 120000;

// All sector trailer block numbers in a MIFARE Classic 1K card
const SECTOR_TRAILERS = new Set([3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47, 51, 55, 59, 63]);

// Ordered list of usable data blocks
// (excludes block 0 = manufacturer, block 1 = our metadata, all trailers)
const DATA_BLOCKS = [];
for (let i = 2; i <= 62; i++) {
  if (!SECTOR_TRAILERS.has(i)) DATA_BLOCKS.push(i);
}

const MAX_PAYLOAD_BYTES = DATA_BLOCKS.length * 16; // 45 × 16 = 720 bytes

let logFn = null;

function setLogger(fn) {
  logFn = typeof fn === 'function' ? fn : null;
}

function emitLog(msg) {
  if (!logFn) return;
  try { logFn(msg); } catch (_) {}
}

// ─── CRC-16/ARC ──────────────────────────────────────────────────────────────

function crc16(buf) {
  let crc = 0xFFFF;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1;
    }
  }
  return crc & 0xFFFF;
}

// ─── Port detection ───────────────────────────────────────────────────────────

function detectPort() {
  const candidates = [
    '/dev/ttyACM0', '/dev/ttyACM1',
    '/dev/ttyUSB0', '/dev/ttyUSB1'
  ];
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
      return p;
    } catch (_) {}
  }
  throw new Error(
    'Proxmark3 not found on any of: ' + candidates.join(', ') +
    '\nIs it plugged in? Do you have read/write permission to the serial port?'
  );
}

// ─── proxmark3 CLI bridge ─────────────────────────────────────────────────────

function runPm3Raw(cmd, port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn('proxmark3', [port, '-c', cmd], {
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`proxmark3 timeout after ${timeoutMs}ms for command: ${cmd}`));
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
    }

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`proxmark3 spawn error: ${err.message}`));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ out: stdout + stderr, code: code ?? 0 });
    });
  });
}

async function runPm3(cmd, port) {
  emitLog(`[pm3] ${cmd}`);

  const { out, code } = await runPm3Raw(cmd, port, 30000);
  emitLog(`[pm3] exit ${code}`);

  if (code !== 0) {
    const summary = summarizePm3Output(out);
    const hint = buildPm3Hint(out, code);
    emitLog(`[pm3] ${summary}`);
    if (hint) emitLog(`[pm3] hint: ${hint}`);

    const err = new Error(
      `proxmark3 failed (exit ${code}): ${summary}` +
      (hint ? `\nHint: ${hint}` : '')
    );
    err.code = code;
    err.out = out;
    throw err;
  }

  if (!out.trim()) {
    throw new Error('proxmark3 produced no output. Check device connection and permissions.');
  }

  return { out, code };
}

function summarizePm3Output(out) {
  const cleanedLines = (out || '')
    .split('\n')
    .map(line => line.replace(/^\[.{1,8}\]\s*/, '').trim())
    .filter(Boolean);

  const errorPatterns = [
    /error/i,
    /failed|fail/i,
    /collision|multiple tags/i,
    /can'?t find/i,
    /auth|denied|permission/i,
    /timeout|no tag|not found/i,
    /wrong key|key/i
  ];

  const focused = cleanedLines.filter((line) => errorPatterns.some((re) => re.test(line)));
  const chosen = (focused.length ? focused : cleanedLines.slice(-6)).slice(0, 6);
  const summary = chosen.join(' | ');
  return summary || 'unknown proxmark3 error';
}

function buildPm3Hint(out, code) {
  const lower = (out || '').toLowerCase();

  if (lower.includes('multiple tags') || lower.includes('collision')) {
    return 'Multiple tags/cards detected. Keep only one card in the RF field and retry.';
  }
  if (lower.includes("can't find") || lower.includes('wrong key') || lower.includes('auth')) {
    return 'Authentication failed. Run autopwn to discover the correct card key.';
  }
  if (lower.includes('permission') || lower.includes('access denied')) {
    return 'Insufficient serial-port permission. Ensure read/write access to /dev/ttyACM*.';
  }
  if (lower.includes('timeout') || lower.includes('no tag')) {
    return 'Communication timeout with the tag. Reposition the card on the antenna and retry.';
  }
  if (code === 246) {
    return 'Command ended with a PM3 script/operation error. Check the last session-log lines for the root cause.';
  }
  return '';
}

function isAuthFailure(text) {
  const lower = String(text || '').toLowerCase();
  return (
    lower.includes("can't find") ||
    lower.includes('wrong key') ||
    lower.includes('auth') ||
    lower.includes('key')
  );
}

function extractHexKeys(text) {
  const matches = String(text || '').match(/\b[0-9a-fA-F]{12}\b/g) || [];
  const uniq = [];
  const seen = new Set();
  for (const k of matches) {
    const key = k.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(key);
  }
  return uniq;
}

function extractAutopwnJsonPath(text) {
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const cleaned = line.replace(/^\[.{1,8}\]\s*/, '').trim();
    const m = cleaned.match(/Saved to json file\s+(.+\.json)/i);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function extractUidFromText(text) {
  const src = String(text || '');
  const candidates = [];

  const byLabel = /\buid\b\s*[:=]\s*([0-9a-fA-F\s]{8,24})/gi;
  for (let m = byLabel.exec(src); m; m = byLabel.exec(src)) {
    candidates.push(m[1]);
  }

  const byDumpName = /hf-mf-([0-9a-fA-F]{8,14})-dump/gi;
  for (let m = byDumpName.exec(src); m; m = byDumpName.exec(src)) {
    candidates.push(m[1]);
  }

  for (const c of candidates) {
    const uid = String(c).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    if (uid.length === 8 || uid.length === 14) return uid;
  }
  return null;
}

function extractAutopwnArtifacts(text) {
  const lines = String(text || '').split('\n');
  const files = [];
  const seen = new Set();

  const pushFile = (filePath) => {
    if (!filePath) return;
    const p = filePath.trim().replace(/^`|`$/g, '');
    if (!p || seen.has(p)) return;
    seen.add(p);
    files.push(p);
  };

  for (const line of lines) {
    const cleaned = line.replace(/^\[.{1,8}\]\s*/, '').trim();

    const m1 = cleaned.match(/saved to json file\s+`?([^`\s]+\.json)`?/i);
    if (m1 && m1[1]) pushFile(m1[1]);

    const m2 = cleaned.match(/saved\s+\d+\s+bytes\s+to\s+binary\s+file\s+`?([^`\s]+\.bin)`?/i);
    if (m2 && m2[1]) pushFile(m2[1]);

    const m3 = cleaned.match(/dumped to\s+`?([^`\s]+\.bin)`?/i);
    if (m3 && m3[1]) pushFile(m3[1]);
  }

  return files;
}

function parseDumpJsonFile(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !data.blocks) {
    throw new Error(`Dump JSON missing \"blocks\" field: ${jsonPath}`);
  }
  return { blocks: data.blocks, uid: extractUidFromText(raw) };
}

function cleanupAutopwnArtifacts(discovery) {
  if (!discovery) return;

  const targets = [];
  if (Array.isArray(discovery.generatedFiles)) {
    targets.push(...discovery.generatedFiles);
  }
  if (discovery.dumpJsonPath) {
    targets.push(discovery.dumpJsonPath);
  }

  const seen = new Set();
  for (const pRaw of targets) {
    const p = String(pRaw || '').trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        emitLog(`[pm3] cleaned autopwn artifact: ${p}`);
      }
    } catch (err) {
      emitLog(`[pm3] failed to remove autopwn artifact: ${err.message}`);
    }
  }
}

async function discoverKeysWithAutopwn(port) {
  emitLog('[pm3] running hf mf autopwn for key discovery...');

  let out = '';
  let code = 0;

  try {
    const res = await runPm3Raw('hf mf autopwn', port, AUTOPWN_TIMEOUT_MS);
    out = res.out;
    code = res.code;
  } catch (err) {
    emitLog(`[pm3] autopwn error: ${err.message}`);
    return { keys: [], dumpJsonPath: '' };
  }

  emitLog(`[pm3] autopwn exit ${code}`);

  const keys = extractHexKeys(out);
  const dumpJsonPath = extractAutopwnJsonPath(out);
  const generatedFiles = extractAutopwnArtifacts(out);

  if (keys.length) {
    emitLog(`[pm3] autopwn keys found: ${keys.join(', ')}`);
  } else {
    emitLog('[pm3] autopwn did not reveal keys');
  }

  if (dumpJsonPath) {
    emitLog(`[pm3] autopwn dump json: ${dumpJsonPath}`);
  }

  return { keys, dumpJsonPath, generatedFiles };
}

function pickPreferredKey(keys) {
  if (!keys || !keys.length) return '';
  const nonDefault = keys.find(k => k !== 'FFFFFFFFFFFF');
  return nonDefault || keys[0];
}

async function withAutopwnKey(port, actionName, runWithKey) {
  const discovery = await discoverKeysWithAutopwn(port);
  const keys = discovery.keys;

  if (!keys.length) {
    cleanupAutopwnArtifacts(discovery);
    throw new Error(`${actionName}: autopwn did not return any usable key.`);
  }

  const preferred = pickPreferredKey(keys);
  const queue = [preferred, ...keys.filter(k => k !== preferred)];
  let lastErr = null;

  for (const key of queue) {
    try {
      emitLog(`[pm3] ${actionName} using key ${key}`);
      const result = await runWithKey(key, discovery);
      cleanupAutopwnArtifacts(discovery);
      return result;
    } catch (err) {
      lastErr = err;
      const msg = `${err.message}\n${err.out || ''}`;
      if (!isAuthFailure(msg)) throw err;
    }
  }

  cleanupAutopwnArtifacts(discovery);
  throw new Error(`${actionName}: authentication failed for all discovered keys (${queue.join(', ')}). ${lastErr ? lastErr.message : ''}`.trim());
}

function assertSuccess(out, context, requireConfirm = false) {
  const lower = out.toLowerCase();
  const failPhrases = [
    'failed',
    'fail',
    'error',
    'wrong',
    'timeout',
    'no tag',
    'not found',
    'collision',
    "can't find",
    'auth',
    'denied'
  ];
  for (const phrase of failPhrases) {
    if (lower.includes(phrase)) {
      // Extract a clean error line from proxmark3 output
      let msg = '';
      for (const line of out.split('\n')) {
        const t = line.replace(/^\[.{1,5}\]\s*/, '').trim();
        if (t.length > 5 && t.length < 200) { msg = t; break; }
      }
      throw new Error(`${context}: ${msg || out.slice(0, 120)}`);
    }
  }

  if (!requireConfirm) return;

  const successHints = ['ok', 'done', 'written', 'saved'];
  const hasSuccessHint = successHints.some(h => lower.includes(h));
  if (!hasSuccessHint) {
    throw new Error(`${context}: proxmark3 output did not confirm success (${summarizePm3Output(out)})`);
  }
}

// ─── Bulk read via hf mf dump ─────────────────────────────────────────────────
//
// Reads all blocks in a single authenticated operation per sector.
// proxmark3 handles key negotiation per sector internally, which avoids
// the silent write/read failures that happen with per-block commands when
// sector access conditions differ (e.g. AC=00000000 vs FF078069).

async function dumpCard(port) {
  const tmpBase = path.join(os.tmpdir(), `pm3_${Date.now()}`);
  let tempFiles = [];
  let discovery = null;

  try {
    discovery = await discoverKeysWithAutopwn(port);

    if (discovery.dumpJsonPath && fs.existsSync(discovery.dumpJsonPath)) {
      emitLog('[pm3] using JSON dump generated by autopwn');
      const parsed = parseDumpJsonFile(discovery.dumpJsonPath);
      cleanupAutopwnArtifacts(discovery);
      return parsed;
    }

    if (!discovery.keys.length) {
      throw new Error('dump: autopwn did not return any usable key.');
    }

    const preferred = pickPreferredKey(discovery.keys);
    const queue = [preferred, ...discovery.keys.filter(k => k !== preferred)];

    let out = '';
    let lastErr = null;

    for (const key of queue) {
      try {
        emitLog(`[pm3] dump using key ${key}`);
        const res = await runPm3(`hf mf dump -k ${key} -f ${tmpBase}`, port);
        assertSuccess(res.out, `Dump card (key ${key})`);
        out = res.out;
        break;
      } catch (err) {
        lastErr = err;
        const msg = `${err.message}\n${err.out || ''}`;
        if (!isAuthFailure(msg)) throw err;
      }
    }

    if (!out) {
      throw new Error(`dump: authentication failed for all discovered keys (${queue.join(', ')}). ${lastErr ? lastErr.message : ''}`.trim());
    }

    // proxmark3 may suffix the filename with the card UID, so glob for it
    const dir     = path.dirname(tmpBase);
    const base    = path.basename(tmpBase);
    const matches = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && (f === `${base}.json` || f.startsWith(base)))
      .map(f => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

    tempFiles = matches.slice();
    tempFiles.push(tmpBase + '.json', tmpBase + '.bin');

    if (matches.length === 0) {
      const nearby = fs.readdirSync(dir)
        .filter(f => f.startsWith('pm3_'))
        .slice(0, 8)
        .join(', ');
      throw new Error(
        'hf mf dump produced no JSON file.\n' +
        'Likely causes: multiple tags in field, wrong key, or authentication failure.\n' +
        'proxmark3 output:\n' + out.slice(0, 400) +
        (nearby ? `\nTemporary files seen in ${dir}: ${nearby}` : '')
      );
    }

    const raw  = fs.readFileSync(matches[0], 'utf8');
    const data = JSON.parse(raw);
    const uid = extractUidFromText(raw) || extractUidFromText(out) || extractUidFromText(matches[0]);

    // Cleanup
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }

    if (!data.blocks) throw new Error('Dump JSON missing "blocks" field.');
    return {
      blocks: data.blocks,
      uid
    };

  } catch (err) {
    // Best-effort cleanup on error
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    cleanupAutopwnArtifacts(discovery);
    try { fs.unlinkSync(tmpBase + '.json'); } catch (_) {}
    try { fs.unlinkSync(tmpBase + '.bin'); } catch (_) {}
    throw err;
  }
}

// ─── Single block write ───────────────────────────────────────────────────────
//
// -a must be specified explicitly to force Key A authentication.
// Without it, some proxmark3 builds pick the wrong key type based on the
// sector trailer access conditions, causing silent write failures.

async function writeBlock(blockNum, hexData, port, key) {
  const padded = hexData.toLowerCase().padEnd(32, '0').slice(0, 32);
  const { out } = await runPm3(
    `hf mf wrbl --blk ${blockNum} -k ${key} -a -d ${padded}`,
    port
  );
  assertSuccess(out, `Write block ${blockNum}`, true);
}

// ─── Metadata encode / decode ─────────────────────────────────────────────────

function encodeMetadata({ payloadSize, chunkIndex, totalChunks }) {
  const buf = Buffer.alloc(16, 0);
  buf.write(MAGIC, 0, 'ascii');        // [0-3]  "PM3C"
  buf.writeUInt32BE(payloadSize, 4);   // [4-7]  size
  buf.writeUInt8(chunkIndex,   8);     // [8]    chunk index
  buf.writeUInt8(totalChunks,  9);     // [9]    total chunks
  const crc = crc16(buf.slice(0, 10));
  buf.writeUInt16LE(crc, 10);          // [10-11] CRC-16
  // [12-15] reserved / zero
  return buf.toString('hex');
}

function decodeMetadata(hex32) {
  if (!hex32 || hex32.length < 32) return null;
  const buf = Buffer.from(hex32.slice(0, 32), 'hex');

  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== MAGIC) return null;

  const payloadSize = buf.readUInt32BE(4);
  const chunkIndex  = buf.readUInt8(8);
  const totalChunks = buf.readUInt8(9);
  const storedCrc   = buf.readUInt16LE(10);
  const computed    = crc16(buf.slice(0, 10));

  if (storedCrc !== computed) return null;

  return { payloadSize, chunkIndex, totalChunks };
}

function inferCardType(blocks) {
  const n = Object.keys(blocks || {}).length;
  if (n >= 256) return 'MIFARE Classic 4K';
  if (n >= 64) return 'MIFARE Classic 1K';
  if (n > 0) return 'MIFARE Classic (unknown size)';
  return 'Unknown card';
}

function deviceLabelFromPort(port) {
  return `Proxmark3 @ ${port}`;
}

function extractUid(blocks, ...extraSources) {
  for (const src of extraSources) {
    const uid = extractUidFromText(src);
    if (uid) return uid;
  }

  const b0 = blocks && blocks['0'];
  if (!b0 || typeof b0 !== 'string') return null;

  const hex = b0.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length >= 14) {
    // Common fallback for 7-byte UID representation in manufacturer bytes.
    return hex.slice(0, 6) + hex.slice(8, 16);
  }
  if (hex.length >= 8) {
    return hex.slice(0, 8);
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan card without reading payload.
 */
async function checkCard() {
  const port   = detectPort();
  const dump = await dumpCard(port);
  const blocks = dump.blocks;
  const meta   = decodeMetadata(blocks['1']);
  const cardType = inferCardType(blocks);
  const uid = extractUid(blocks, dump.uid);

  return {
    present:    true,
    uid,
    hasData:    meta !== null,
    meta,
    usedBytes:  meta ? meta.payloadSize : 0,
    totalBytes: MAX_PAYLOAD_BYTES,
    port,
    cardType,
    deviceLabel: deviceLabelFromPort(port)
  };
}

/**
 * Read payload from card.
 */
async function readCard() {
  const port   = detectPort();
  const dump = await dumpCard(port);
  const blocks = dump.blocks;
  const cardType = inferCardType(blocks);
  const deviceLabel = deviceLabelFromPort(port);
  const uid = extractUid(blocks, dump.uid);

  const meta = decodeMetadata(blocks['1']);
  if (!meta) {
    return {
      content: '',
      chunkIndex: 0,
      totalChunks: 1,
      payloadSize: 0,
      hasData: false,
      uid,
      meta: null,
      usedBytes: 0,
      totalBytes: MAX_PAYLOAD_BYTES,
      port,
      cardType,
      deviceLabel,
      blank: true,
      rawBlock1: blocks['1'] || '(missing)'
    };
  }

  const { payloadSize, chunkIndex, totalChunks } = meta;
  const blocksNeeded = Math.ceil(payloadSize / 16);

  const chunks = [];
  for (let i = 0; i < blocksNeeded; i++) {
    const blkNum = DATA_BLOCKS[i];
    const hex    = blocks[String(blkNum)];
    if (!hex || hex.length < 32) {
      throw new Error(`Block ${blkNum} missing or unreadable from dump.`);
    }
    chunks.push(Buffer.from(hex.slice(0, 32), 'hex'));
  }
  const payload = Buffer.concat(chunks);

  return {
    content:     payload.slice(0, payloadSize).toString('utf8'),
    chunkIndex,
    totalChunks,
    payloadSize,
    hasData: true,
    uid,
    meta,
    usedBytes: payloadSize,
    totalBytes: MAX_PAYLOAD_BYTES,
    port,
    cardType,
    deviceLabel,
    blank: false
  };
}

/**
 * Write payload to card.
 */
async function writeCard(content, chunkIndex = 0, totalChunks = 1) {
  const port    = detectPort();
  const payload = Buffer.from(content, 'utf8');

  if (payload.length === 0) throw new Error('Nothing to write.');
  if (payload.length > MAX_PAYLOAD_BYTES) {
    const needed = Math.ceil(payload.length / MAX_PAYLOAD_BYTES);
    throw new Error(
      `Content too large: ${payload.length} B (max ${MAX_PAYLOAD_BYTES} B per card). ` +
      `Use Split — needs ${needed} cards.`
    );
  }

  await withAutopwnKey(port, 'write', async (key) => {
    // Write metadata block first
    await writeBlock(1, encodeMetadata({ payloadSize: payload.length, chunkIndex, totalChunks }), port, key);

    // Write payload blocks
    const blocksNeeded = Math.ceil(payload.length / 16);
    for (let i = 0; i < blocksNeeded; i++) {
      const chunk = payload.slice(i * 16, (i + 1) * 16);
      await writeBlock(DATA_BLOCKS[i], chunk.toString('hex'), port, key);
    }
  });

  const blocksNeeded = Math.ceil(payload.length / 16);

  return { bytesWritten: payload.length, blocksUsed: blocksNeeded };
}

/**
 * Wipe PM3C metadata (block 1 → zeros). Data blocks left as-is.
 */
async function wipeCard() {
  const port = detectPort();
  await withAutopwnKey(port, 'wipe', async (key) => {
    await writeBlock(1, '00'.repeat(16), port, key);
  });
}

/**
 * Split a large string into card-sized UTF-8 chunks.
 */
function splitIntoChunks(content) {
  const payload = Buffer.from(content, 'utf8');
  const chunks  = [];
  for (let offset = 0; offset < payload.length; offset += MAX_PAYLOAD_BYTES) {
    chunks.push(payload.slice(offset, offset + MAX_PAYLOAD_BYTES).toString('utf8'));
  }
  return chunks;
}

// ─── Continuous NFC scanning ──────────────────────────────────────────────────

/** Active polling timer handle (null when not scanning). */
let _scanTimer = null;

/** Whether a full readCard() is currently in progress during scan. */
let _scanReading = false;

/**
 * True while a user-triggered manual operation (read / write / wipe) holds
 * the serial port.  The scan tick checks this flag and skips rather than
 * spawning a conflicting proxmark3 process.
 */
let _portBusy = false;

/**
 * Promise that resolves when the currently-running scan tick (if any)
 * finishes.  Manual operations await this before touching the port so they
 * don't collide with an in-flight hf search or automatic card read.
 */
let _scanTickDone = Promise.resolve();

/**
 * Call this before every user-triggered (manual) port operation.
 * Sets the busy flag so the scan loop skips the next ticks, then waits
 * for any currently-running scan tick to complete before returning.
 */
async function beginManualOp() {
  _portBusy = true;
  await _scanTickDone;
}

/**
 * Call this after every user-triggered port operation finishes (or fails).
 * Clears the busy flag so the scan loop can resume on its next timer tick.
 */
function endManualOp() {
  _portBusy = false;
}

/**
 * Perform a lightweight card-presence check using `hf search`.
 * Returns true when any HF tag is detected, without fully reading it.
 *
 * @param {string} port  Serial port path.
 * @returns {Promise<boolean>}
 */
async function scanForCardPresence(port) {
  try {
    const { out } = await runPm3Raw('hf search', port, 8000);
    const lower = out.toLowerCase();
    // hf search prints a UID line when a card is present
    return lower.includes('uid') || lower.includes('atqa') || lower.includes('mifare');
  } catch (_) {
    return false;
  }
}

/**
 * Start continuous NFC polling.  The loop runs every `intervalMs`
 * milliseconds: it checks for a card via a lightweight hf-search, and
 * when a card is found it performs a full readCard() and delivers the
 * result to `onResult`.
 *
 * The loop is automatically paused while a read is already in progress.
 *
 * @param {(result: object) => void} onResult  Called with the readCard() result on success.
 * @param {(err: Error) => void}     onError   Called when an error occurs (port not found, etc.).
 * @param {number} [intervalMs=4000]  Polling interval in milliseconds.
 */
function startContinuousScan(onResult, onError, intervalMs = 4000) {
  // Cancel any existing scan loop before starting a new one
  stopContinuousScan();

  emitLog('[scan] continuous NFC scan started');

  const tick = async () => {
    // Skip if a manual operation (read/write/wipe) is using the port,
    // or if a previous auto-read is still in progress.
    // Reset _scanTickDone to an already-resolved promise so that a
    // concurrently-called beginManualOp() does not stall waiting for a
    // tick that never actually ran.
    if (_scanReading || _portBusy) {
      _scanTickDone = Promise.resolve();
      return;
    }

    let port;
    try {
      port = detectPort();
    } catch (err) {
      // Proxmark3 not connected — notify caller but keep the loop alive
      // so it can recover when the device is plugged in later.
      if (typeof onError === 'function') {
        onError(Object.assign(err, { code: 'NO_DEVICE' }));
      }
      return;
    }

    // Wrap the rest of the tick in its own promise and expose it via
    // _scanTickDone so that beginManualOp() can wait for this tick to
    // finish before letting a manual operation acquire the port.
    const thisTick = (async () => {
      let present = false;
      try {
        present = await scanForCardPresence(port);
      } catch (err) {
        // Transient hardware error — skip this tick silently
        emitLog(`[scan] presence check error: ${err.message}`);
        return;
      }

      if (!present) return;

      // A card was detected — pause the loop and do a full read
      _scanReading = true;
      emitLog('[scan] card detected — performing full read');

      try {
        const result = await readCard();
        if (typeof onResult === 'function') onResult(result);
      } catch (err) {
        emitLog(`[scan] read error: ${err.message}`);
        if (typeof onError === 'function') onError(err);
      } finally {
        _scanReading = false;
      }
    })();

    // Assign the swallowed promise first so beginManualOp() always has a
    // settled-or-pending promise to await regardless of when it is called.
    const caught = thisTick.catch(() => {});
    _scanTickDone = caught;
    await thisTick;
  };

  // Run the first tick after a short delay so the caller has time to
  // update the UI before the first presence check starts.
  _scanTimer = setTimeout(function loop() {
    tick().finally(() => {
      // Re-schedule only if the scan has not been stopped in the meantime
      if (_scanTimer !== null) {
        _scanTimer = setTimeout(loop, intervalMs);
      }
    });
  }, 500);
}

/**
 * Stop the continuous NFC polling loop.
 */
function stopContinuousScan() {
  if (_scanTimer !== null) {
    clearTimeout(_scanTimer);
    _scanTimer = null;
    emitLog('[scan] continuous NFC scan stopped');
  }
}

module.exports = {
  MAX_PAYLOAD_BYTES,
  DATA_BLOCKS,
  setLogger,
  checkCard,
  readCard,
  writeCard,
  wipeCard,
  splitIntoChunks,
  startContinuousScan,
  stopContinuousScan,
  beginManualOp,
  endManualOp
};