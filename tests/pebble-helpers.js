// Shared helpers for the emulator-backed tests (not a test file itself).
//
// Prerequisites: `pebble` on PATH (plus Node for the SDK). On a machine where
// the emulator's SDL libraries were unpacked into ~/.local/sdl (no root), they
// are picked up automatically below.

const { execFileSync, spawnSync } = require('child_process');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const GYMTRACKER = path.join(ROOT, 'gymtracker');

// ------------------------------------------------------------------
// pebble CLI
// ------------------------------------------------------------------
function cliEnv() {
  const env = { ...process.env, PYTHONWARNINGS: 'ignore' };
  const sdl = path.join(os.homedir(), '.local', 'sdl', 'usr', 'lib', 'x86_64-linux-gnu');
  if (fs.existsSync(sdl)) {
    env.LD_LIBRARY_PATH = [
      path.join(sdl, 'sdl2-classic'), sdl, path.join(sdl, 'pulseaudio'), env.LD_LIBRARY_PATH,
    ].filter(Boolean).join(':');
  }
  return env;
}

function pebble(args, opts = {}) {
  return execFileSync('pebble', args, {
    cwd: GYMTRACKER,
    encoding: 'utf8',
    timeout: opts.timeout || 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cliEnv(),
  });
}

function hasPebble() {
  try { execFileSync('pebble', ['--version'], { stdio: 'ignore', env: cliEnv() }); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function killEmulator() {
  try { pebble(['kill'], { timeout: 10_000 }); } catch { /* nothing running */ }
}

const APP_UUID = JSON.parse(fs.readFileSync(path.join(GYMTRACKER, 'package.json'), 'utf8')).pebble.uuid;

// Fresh emulator with the freshly built app. Wipes emulator storage first so
// every run starts from a blank watch and a blank phone-side localStorage.
// `phoneStorage` ({key: value}) is written into the app's phone-side
// localStorage (what pkjs reads via localStorage.getItem) before the app runs.
function startEmulator(platform, { phoneStorage } = {}) {
  killEmulator();
  try { pebble(['wipe'], { timeout: 15_000 }); } catch { /* older tool versions */ }
  pebble(['build'], { timeout: 180_000 });
  pebble(['install', '--emulator', platform], { timeout: 120_000 });
  if (phoneStorage) {
    // pypkjs keeps its store open, so seed with the emulator stopped, then relaunch.
    const dir = persistDir();
    killEmulator();
    seedPhoneStorage(dir, phoneStorage);
    pebble(['install', '--emulator', platform], { timeout: 120_000 });
  }
}

function persistDir() {
  const out = execFileSync('pgrep', ['-af', 'pypkjs'], { encoding: 'utf8' });
  const m = out.match(/--persist (\S+)/);
  if (!m) throw new Error('pypkjs is not running');
  return m[1];
}

function pythonDbm(script, args) {
  return execFileSync('python3', ['-I', '-c', script, ...args], { encoding: 'utf8' });
}

function seedPhoneStorage(dir, values) {
  pythonDbm(
    'import dbm.dumb, json, os, sys\n' +
    'os.makedirs(os.path.dirname(sys.argv[1]), exist_ok=True)\n' +
    'db = dbm.dumb.open(sys.argv[1], "c")\n' +
    'for k, v in json.loads(sys.argv[2]).items(): db[k] = v\n' +
    'db.close()',
    [path.join(dir, 'localstorage', APP_UUID), JSON.stringify(values)]);
}

// Snapshot of the phone-side localStorage (reads a copy: pypkjs holds the live files open).
function readPhoneStorage() {
  const dir = persistDir();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ls-'));
  try {
    for (const ext of ['.dat', '.dir']) {
      const src = path.join(dir, 'localstorage', APP_UUID + ext);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, 'ls' + ext));
    }
    return JSON.parse(pythonDbm(
      'import dbm.dumb, json, sys\n' +
      'db = dbm.dumb.open(sys.argv[1], "r")\n' +
      'print(json.dumps({k.decode(): db[k].decode() for k in db.keys()}))',
      [path.join(tmp, 'ls')]));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// The phone app's way of putting a routine on the watch: AppMessage ROUTINE_DATA.
function messageKey(name) {
  return JSON.parse(fs.readFileSync(path.join(GYMTRACKER, 'build', 'appinfo.json'), 'utf8')).appKeys[name];
}

function sendRoutineToWatch(platform, routineString) {
  pebble(['send-app-message', '--emulator', platform, '--string', `${messageKey('ROUTINE_DATA')}=${routineString}`]);
}

function press(platform, button, { times = 1, duration = 100, interval = 250 } = {}) {
  pebble(['emu-button', '--emulator', platform, '--duration', String(duration),
          '--repeat', String(times), '--interval', String(interval), 'click', button]);
}

// Default long-press threshold on the watch is 500 ms.
function longPress(platform, button) { press(platform, button, { duration: 800 }); }

function screenshot(platform) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-shot-')), 'shot.png');
  pebble(['screenshot', '--emulator', platform, '--no-open', file], { timeout: 30_000 });
  const buf = fs.readFileSync(file);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return buf;
}

// ------------------------------------------------------------------
// Minimal PNG decoder (8-bit RGBA, non-interlaced: what `pebble screenshot` emits)
// ------------------------------------------------------------------
function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bitDepth = buf[24], colorType = buf[25], interlace = buf[28];
  if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error(`Unsupported PNG (depth ${bitDepth}, type ${colorType}, interlace ${interlace})`);
  }
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    if (buf.toString('latin1', o + 4, o + 8) === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { w, h, data: out };
}

// Pixels of a rectangle as a Buffer, for exact equality checks between screens.
function crop(png, { x, y, w, h }) {
  const rows = [];
  for (let row = y; row < y + h; row++) {
    rows.push(png.data.subarray((row * png.w + x) * 4, (row * png.w + x + w) * 4));
  }
  return Buffer.concat(rows);
}

// Crop -> PNG file, so a region can be compared against a stored golden image.
function encodePng({ w, h, data }) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter: none
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])), 0);
    return Buffer.concat([len, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;                          // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A rectangle of a decoded screenshot as its own image.
function cropImage(png, rect) {
  return { w: rect.w, h: rect.h, data: crop(png, rect) };
}

// ------------------------------------------------------------------
// pypkjs (the emulator's phone-side JS runtime) over WebSocket
// ------------------------------------------------------------------
function getPypkjsPort() {
  try {
    const out = execFileSync('pgrep', ['-af', 'pypkjs'], { encoding: 'utf8' });
    const m = out.match(/--port (\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

function wsHandshake(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write([
        'GET / HTTP/1.1', `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
      let data = Buffer.alloc(0);
      const onData = (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.toString().includes('\r\n\r\n')) {
          sock.removeListener('data', onData);
          data.includes('101') ? resolve(sock) : reject(new Error(`Handshake failed: ${data.toString().slice(0, 200)}`));
        }
      };
      sock.on('data', onData);
    });
    sock.on('error', reject);
  });
}

function wsSendBinary(sock, payload) {
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x82, payload.length | 0x80]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x82; header[1] = 126 | 0x80; header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([header, mask, masked]));
}

// Server -> client WebSocket frames are unmasked. Returns the binary payloads
// found in `buf` plus any unconsumed remainder.
function readFrames(buf) {
  const frames = [];
  let o = 0;
  while (buf.length - o >= 2) {
    let len = buf[o + 1] & 0x7f, hdr = 2;
    if (len === 126) { if (buf.length - o < 4) break; len = buf.readUInt16BE(o + 2); hdr = 4; }
    else if (len === 127) { if (buf.length - o < 10) break; len = Number(buf.readBigUInt64BE(o + 2)); hdr = 10; }
    if (buf.length - o < hdr + len) break;
    frames.push(buf.subarray(o + hdr, o + hdr + len));
    o += hdr + len;
  }
  return { frames, rest: buf.subarray(o) };
}

// Opens the app's settings the way the phone app does, which runs the app's
// `showConfiguration` handler, and returns the config-page URL it announces
// (including the ?sync=...&history=... parameters built from phone storage).
//
// Delivering a *response* back (the `webviewclosed` path) is not possible here:
// pypkjs passes the response to its JS engine as bytes, which the engine rejects.
// Routines are therefore delivered with sendRoutineToWatch() instead.
async function getConfigUrlFromPhone() {
  const port = getPypkjsPort();
  if (!port) throw new Error('pypkjs is not running');
  const sock = await wsHandshake('localhost', port);
  let pending = Buffer.alloc(0);
  const received = [];
  sock.on('data', (chunk) => {
    const { frames, rest } = readFrames(Buffer.concat([pending, chunk]));
    pending = rest;
    received.push(...frames);
  });
  wsSendBinary(sock, Buffer.from([0x0a, 0x01]));
  const announce = await waitFor(
    () => received.find((f) => f[0] === 0x0a && f[1] === 0x01),
    { timeout: 15_000, interval: 100, message: 'config URL from pypkjs' });
  sock.destroy();
  return announce.subarray(6, 6 + announce.readUInt32BE(2)).toString('utf8');
}

// ------------------------------------------------------------------
// Stand-in for the Google Apps Script endpoint: records what the phone posts.
// ------------------------------------------------------------------
function startCaptureServer() {
  const posts = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        try { posts.push(JSON.parse(body)); } catch { posts.push({ raw: body }); }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${srv.address().port}/exec`,
      posts,
      close: () => srv.close(),
    }));
  });
}

async function waitFor(fn, { timeout = 20_000, interval = 500, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${message}`);
    await sleep(interval);
  }
}

// ------------------------------------------------------------------
// Workout summary string (WORKOUT_SUMMARY): the same format the config page,
// the Sheets script and the CSV export all read.
//   routine|date|duration|sensation|accuracy|density|<exercise|(reps|weight|peakHR|avgHR)*>...|@HR|series
// ------------------------------------------------------------------
function parseWorkoutSummary(str) {
  const parts = str.split('|');
  const hr = parts.indexOf('@HR');
  const body = parts.slice(6, hr === -1 ? parts.length : hr);
  const exercises = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '') continue;
    if (isNaN(body[i])) {
      exercises.push({ name: body[i], sets: [] });
    } else {
      exercises[exercises.length - 1].sets.push({ reps: Number(body[i]), weight: Number(body[i + 1]) });
      i += 3;
    }
  }
  return { routine: parts[0], duration: Number(parts[2]), exercises };
}

module.exports = {
  ROOT, GYMTRACKER, pebble, hasPebble, sleep, startEmulator, killEmulator, press, longPress, screenshot,
  decodePng, crop, cropImage, encodePng, getPypkjsPort, getConfigUrlFromPhone, readPhoneStorage, sendRoutineToWatch, messageKey, startCaptureServer, waitFor,
  parseWorkoutSummary, spawnSync,
};
