// @ts-check
// Timed (Count down) modifier (value 8) on the watch — runs the real app in the
// Pebble emulator, from a routine delivered over AppMessage through to the
// workout summary the phone uploads and the routine it syncs back.
//
// How this stays deterministic: while a timed exercise's timer is NOT running,
// Up adds one second to the elapsed time. Pressing Up N times therefore puts the
// watch in an exact state (elapsed 0, exactly the target, past it) without
// racing a clock. A few "live" sets also run the real timer, with tolerances,
// to prove it counts in the right direction and stops when asked.
//
// Screens are compared pixel-for-pixel (no OCR): a count-down box at elapsed E
// must look identical to a count-up box showing the same number, and the
// overtime display is checked against a golden image (tests/golden/).
// The crop rectangles below are for the Emery platform.
//
// Prerequisites: `pebble` on PATH (see pebble-helpers.js).
// Run: cd tests && npx playwright test test-countdown-watch.js
// Not covered: vibration (the emulator can't report it).

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('./pebble-helpers');

const P = 'emery';
const BOX = { x: 60, y: 92, w: 80, h: 94 };      // bordered value box: label, big number, "Target: N"
const DIGITS = { x: 70, y: 120, w: 60, h: 40 };  // the big number only

// Entries of the double-click menu (see mega_window_load in main.c)
const MENU_SKIP_SET = 7;
const MENU_SKIP_EXERCISE = 8;

// Every exercise is one case. Targets are seconds; weight is 0 except where noted.
const ROUTINE = [
  'Timed Mix',
  'Wall Sit|3|5|0|6|-',           // count up:    elapsed 0, target, past target
  'Plank|3|5|0|8|-',              // count down:  elapsed 0, target, past target
  'Plank B|1|7|0|8|-',            // count down, different target, same overshoot (+3)
  'Weighted Plank|1|5|20|8|-',    // a weight sent for a timed exercise must be dropped
  'Skip Set Hold|2|5|0|8|-',      // Skip Set (Log 0), with and without elapsed time
  'Skip Ex Hold|2|5|0|8|-',       // Skip Exercise (Log 0)
  'Skip Live|1|5|0|8|-',          // Skip Set while the timer is running
  'Live Hold|2|6|0|8|-',          // real timer: stopped early, then run past the target
  'Live Up|1|6|0|6|-',            // real timer, count up
].join('|');

// Everything the tests assert on is captured during one scripted workout and kept
// in `run` (screenshots as base64 PNG so it can be cached as JSON).
let run = null;
const shots = {};

function shoot(name) { shots[name] = h.screenshot(P).toString('base64'); }
const screen = (name) => h.decodePng(Buffer.from(run.shots[name], 'base64'));
const box = (name) => h.crop(screen(name), BOX);
const digits = (name) => h.crop(screen(name), DIGITS);

const wait = (ms) => h.sleep(ms);
async function pressUp(n) { if (n > 0) h.press(P, 'up', { times: n, interval: 200 }); await wait(600); }
async function startOrStopTimer() { h.press(P, 'select'); await wait(700); }
async function finishSet() { h.longPress(P, 'select'); await wait(1000); }     // long-press Select = Finish Set
async function skipRest() { h.press(P, 'select'); await wait(1000); }
async function menuPick(index) {
  h.press(P, 'select', { times: 2, interval: 120 });                          // double-click opens the menu
  await wait(1000);
  h.press(P, 'down', { times: index, interval: 200 });
  await wait(500);
  h.press(P, 'select');
  await wait(1000);
}

test.describe('Layer 2 — Count down modifier on the watch (Pebble emulator)', () => {
  // Playwright restarts its worker after a failing test, which would rerun a
  // five-minute workout. The captured data is therefore cached on disk for the
  // lifetime of this test run (keyed by the runner's pid), so every test below
  // reports independently of the others.
  test.beforeAll(async () => {
    test.setTimeout(900_000);
    const cache = path.join(os.tmpdir(), `gt-countdown-${process.ppid}.json`);
    if (fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < 30 * 60_000) {
      run = JSON.parse(fs.readFileSync(cache, 'utf8'));
      return;
    }
    for (const f of fs.readdirSync(os.tmpdir())) {                  // tidy up old runs
      if (/^gt-countdown-\d+\.json$/.test(f)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
    }
    run = await collectRun();
    fs.writeFileSync(cache, JSON.stringify(run));
  });

  async function collectRun() {
    const capture = await h.startCaptureServer();
    try {
      h.startEmulator(P, { phoneStorage: { googleUrl: capture.url, googlePwd: 'pw' } });

      // The phone app puts a routine on the watch with AppMessage ROUTINE_DATA.
      h.sendRoutineToWatch(P, ROUTINE);
      await wait(1000);
      h.pebble(['install', '--emulator', P]);       // relaunch so the routine list reloads
      await wait(2500);
      h.press(P, 'select');                          // open "Timed Mix"
      await wait(1500);

      // --- Wall Sit (count up) ---
      for (const e of [0, 5, 8]) {
        await pressUp(e);                                  // elapsed resets to 0 for every set
        shoot(`up${e}`);
        await finishSet(); await skipRest();
      }
      // --- Plank (count down) ---
      for (const e of [0, 5, 8]) {
        await pressUp(e);
        shoot(`down${e}`);
        await finishSet(); await skipRest();
      }
      // --- Plank B (count down, target 7): elapsed 10 shows +3 as well ---
      await pressUp(10); shoot('downB10');
      await finishSet(); await skipRest();

      // --- Weighted Plank: the weight sent with it must be ignored ---
      await pressUp(5); shoot('weighted5');
      await finishSet(); await skipRest();

      // --- Skip Set Hold: skip with elapsed time on the clock, then with none ---
      await pressUp(3); shoot('skipSet3');
      await menuPick(MENU_SKIP_SET);
      shoot('skipSet_afterFirstSkip');
      await menuPick(MENU_SKIP_SET);

      // --- Skip Ex Hold: skip the whole exercise after some elapsed time ---
      await pressUp(2); shoot('skipEx2');
      await menuPick(MENU_SKIP_EXERCISE);

      // --- Skip Live: skip the set while the timer is running ---
      await startOrStopTimer();
      await wait(2000);
      await menuPick(MENU_SKIP_SET);

      // --- Live Hold set 1: start, stop early, check it stays stopped ---
      await startOrStopTimer();
      await wait(2000);
      await startOrStopTimer();
      shoot('liveStopped_a');
      await wait(2500);
      shoot('liveStopped_b');
      await finishSet(); await skipRest();
      // --- Live Hold set 2: run past the target and log while still running ---
      await startOrStopTimer();
      await wait(8000);
      await finishSet(); await skipRest();

      // --- Live Up: count-up control ---
      await startOrStopTimer();
      await wait(2000);
      await finishSet();                              // last set: sensation prompt
      h.press(P, 'select');                           // pick the default sensation -> summary, uploads
      await h.waitFor(() => capture.posts.length > 0, { timeout: 30_000, message: 'workout upload' });
      await wait(500);
      h.press(P, 'select');                           // leave the summary

      // phone-side state, read while the emulator is still up
      const stored = h.readPhoneStorage();
      const configUrl = await h.getConfigUrlFromPhone();
      return {
        shots, stored, configUrl,
        posts: capture.posts,
        summary: h.parseWorkoutSummary(capture.posts[0].workoutData),
      };
    } finally {
      capture.close();
      h.killEmulator();
    }
  }

  const sets = (name) => run.summary.exercises.find((e) => e.name === name)?.sets.map((s) => s.reps);

  // ------------------------------------------------------------------
  test('the routine reaches the watch with count-down exercises recognised as timed', () => {
    // Had modifier 8 been parsed as a normal exercise the box would read "Reps".
    // Elapsed 0 on count up and elapsed = target on count down must both read "0";
    // elapsed = target on count up and elapsed 0 on count down must both read "5".
    expect(box('down5').equals(box('up0'))).toBe(true);
    expect(box('down0').equals(box('up5'))).toBe(true);
    // and the two modes are really different screens at the same elapsed time
    expect(box('down0').equals(box('up0'))).toBe(false);
    expect(box('down8').equals(box('up8'))).toBe(false);
  });

  test('count down shows seconds remaining, then +N overtime past zero', () => {
    // the golden confirms the sign: "+3", not "-3" and not the elapsed "8"
    const plus3 = h.encodePng(h.cropImage(screen('down8'), DIGITS));
    expect(plus3).toMatchSnapshot('countdown-overtime-plus3-emery.png');

    // "+3" depends on the overshoot, not on the target or the elapsed time
    expect(digits('down8').equals(digits('downB10'))).toBe(true);
    expect(digits('down8').equals(digits('up8'))).toBe(false);
  });

  test('logs elapsed seconds when stopped at 0, exactly on target, and past zero', () => {
    expect(sets('Wall Sit [TIMED]')).toEqual([0, 5, 8]);      // control: count up
    expect(sets('Plank [TIMED]')).toEqual([0, 5, 8]);         // target 5: not 5, 0, -3 / +3
    expect(sets('Plank B [TIMED]')).toEqual([10]);            // target 7: 10 elapsed, not +3
  });

  test('a weight sent with a count-down exercise is dropped', () => {
    expect(run.summary.exercises.find((e) => e.name === 'Weighted Plank [TIMED]').sets)
      .toEqual([{ reps: 5, weight: 0 }]);
    // single-column bodyweight layout, same as any other timed exercise
    expect(box('weighted5').equals(box('up0'))).toBe(true);
    for (const ex of run.summary.exercises) {
      for (const set of ex.sets) expect(set.weight).toBe(0);
    }
  });

  test('Skip Set (Log 0) logs zero seconds, not the target or the elapsed time', () => {
    // the watch really did show a non-zero state just before skipping...
    expect(box('skipSet3').equals(box('down0'))).toBe(false);
    // ...and a fresh set after a skip is back at the full target
    expect(box('skipSet_afterFirstSkip').equals(box('down0'))).toBe(true);
    expect(sets('Skip Set Hold [TIMED]')).toEqual([0, 0]);
  });

  test('Skip Exercise (Log 0) logs zero seconds for every set', () => {
    expect(box('skipEx2').equals(box('down0'))).toBe(false);
    expect(sets('Skip Ex Hold [TIMED]')).toEqual([0, 0]);
  });

  test('skipping while the timer is running still logs zero', () => {
    expect(sets('Skip Live [TIMED]')).toEqual([0]);
  });

  test('the live timer stops when asked, and keeps counting past the target when not', () => {
    // stopped: the display does not move
    expect(box('liveStopped_a').equals(box('liveStopped_b'))).toBe(true);

    const [stopped, pastTarget] = sets('Live Hold [TIMED]');
    expect(stopped).toBeGreaterThanOrEqual(1);
    expect(stopped).toBeLessThan(6);                          // stopped before the 6 s target
    expect(pastTarget).toBeGreaterThan(6);                    // ran ~8 s: elapsed, not "remaining"

    const [up] = sets('Live Up [TIMED]');                     // control
    expect(up).toBeGreaterThanOrEqual(1);
    expect(up).toBeLessThan(10);
  });

  test('both timed modes export under the same [TIMED] label', () => {
    const names = run.summary.exercises.map((e) => e.name);
    expect(names).toEqual([
      'Wall Sit [TIMED]', 'Plank [TIMED]', 'Plank B [TIMED]', 'Weighted Plank [TIMED]',
      'Skip Set Hold [TIMED]', 'Skip Ex Hold [TIMED]', 'Skip Live [TIMED]',
      'Live Hold [TIMED]', 'Live Up [TIMED]',
    ]);
    expect(names.join('|')).not.toContain('COUNTDOWN');
  });

  test('the workout is uploaded once, with the phone token', () => {
    expect(run.posts).toHaveLength(1);
    expect(run.posts[0].token).toBe('pw');
    expect(run.summary.routine).toBe('Timed Mix');
  });

  test('the routine synced back to the phone keeps both modifiers', async () => {
    const stored = run.stored;
    const synced = JSON.parse(stored.synced_routines)['Timed Mix'];
    expect(synced).toContain('|Wall Sit|3|5|0|6|-');
    expect(synced).toContain('|Plank|3|5|0|8|-');
    expect(synced).toContain('|Live Hold|2|6|0|8|-');

    const saved = JSON.parse(stored.savedRoutines).find((r) => r.name === 'Timed Mix');
    expect(saved.exercises.map((e) => [e[0], e[4]])).toEqual([
      ['Wall Sit', 6], ['Plank', 8], ['Plank B', 8], ['Weighted Plank', 8], ['Skip Set Hold', 8],
      ['Skip Ex Hold', 8], ['Skip Live', 8], ['Live Hold', 8], ['Live Up', 6],
    ]);
  });

  test('the config page opened from that phone shows the synced count-down exercises', async ({ page }) => {
    // The URL the phone would open Settings with, carrying the synced routines.
    const url = new URL(run.configUrl);
    await page.goto(`file://${h.ROOT}/index.html${url.search}`);
    await page.waitForFunction(() => document.getElementById('savedRoutineSelect').options.length >= 2);
    await page.selectOption('#savedRoutineSelect', 'Timed Mix');

    const items = page.locator('.exercise-item');
    await expect(items).toHaveCount(9);
    await expect(items.nth(1)).toContainText('Plank');
    await expect(items.nth(1)).toContainText('COUNTDOWN');
    await expect(items.nth(1)).toContainText('5sec');
    await expect(items.nth(0)).toContainText('TIMED');
    await expect(items.nth(0)).not.toContainText('COUNTDOWN');
  });
});
