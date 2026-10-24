// @ts-check
// End-to-end: config page -> phone -> watch -> phone, in the Pebble emulator.
//
//   1. A routine is built in the real config page (Chromium) and "Save & Send"
//      is clicked; the payload the page would hand to the Pebble app is captured.
//   2. That payload's routine is delivered to the watch as AppMessage ROUTINE_DATA,
//      which is exactly what the phone-side JS does with it (pkjs forwards
//      `routineData` untouched; test-countdown-config.js covers that hop).
//   3. The workout is run and finished on the watch.
//   4. The workout the phone uploads to the Google endpoint, the routine the
//      phone stores as synced back from the watch, and the URL the phone would
//      open Settings with are checked against what the page originally sent.
//
// Why step 2 does not go through the emulator's WebSocket: pypkjs only accepts a
// config response after the app's settings were opened, and then hands the response
// to its JS engine as bytes, which the engine rejects. The page's response therefore
// cannot be injected into the app's `webviewclosed` handler under this SDK.
// What can be checked is that opening settings runs the app's `showConfiguration`
// and announces the config-page URL, which is done below.
//
// Prerequisites: `pebble` on PATH (see pebble-helpers.js).
// Run: cd tests && npx playwright test test-e2e.js

const { test, expect } = require('@playwright/test');
const h = require('./pebble-helpers');

const P = 'emery';

test.describe('Layer 2 — E2E: config page → phone → watch → phone', () => {
  test('a routine built in the page runs on the watch and comes back intact', async ({ page }) => {
    test.skip(!h.hasPebble(), 'pebble CLI not found on PATH');
    test.setTimeout(300_000);

    // ---- 1. Build the routine in the real page and capture what it would send ----
    await page.goto(`file://${h.ROOT}/index_dev.html`);
    await page.waitForFunction(() => typeof Storage !== 'undefined');
    await page.fill('#routineName', 'E2E Routine');

    const add = async ({ name, sets, reps, weight, modifier = 0 }) => {
      await page.evaluate((n) => {
        const sel = document.getElementById('exerciseSelect');
        sel.appendChild(new Option(n, n));
        sel.value = n;
      }, name);
      await page.fill('#targetSets', String(sets));
      await page.fill('#targetReps', String(reps));
      await page.selectOption('#exerciseModifier', String(modifier));
      if (weight !== undefined) await page.fill('#targetWeight', String(weight));
      await page.click('#addUpdateBtn');
    };
    await add({ name: 'Bench Press', sets: 1, reps: 10, weight: 60 });
    await add({ name: 'Plank', sets: 1, reps: 5, modifier: 8 });

    await page.evaluate(() => {
      window.__sent = null;
      window.alert = () => {};
      window.sendToPebble = (cfg) => { window.__sent = cfg; };
    });
    await page.click('#btn-send-single');
    const payload = await page.evaluate(() => window.__sent);

    const expectedRoutine = 'E2E Routine|Bench Press|1|10|60|0|-|Plank|1|5|0|8|-';
    expect(payload.routineData).toBe(expectedRoutine);
    expect(encodeURIComponent(JSON.stringify(payload)).length)
      .toBeLessThanOrEqual(await page.evaluate(() => MAX_CONFIG_RESPONSE));

    // ---- 2. Phone and watch ----
    const capture = await h.startCaptureServer();
    try {
      h.startEmulator(P, { phoneStorage: { googleUrl: capture.url, googlePwd: 'pw' } });

      // What the phone does with the page's response: forward the routine to the watch
      h.sendRoutineToWatch(P, payload.routineData);
      await h.sleep(1000);
      h.pebble(['install', '--emulator', P]);            // relaunch so the routine list reloads
      await h.sleep(2500);

      // ---- 3. Run the workout on the watch ----
      h.press(P, 'select');                               // open the routine
      await h.sleep(1500);
      h.longPress(P, 'select');                           // Bench Press: log the pre-filled 10 x 60
      await h.sleep(1000);
      h.press(P, 'select');                               // skip the rest timer
      await h.sleep(1000);
      h.press(P, 'up', { times: 5, interval: 200 });      // Plank (count down): exactly its 5 s target
      await h.sleep(600);
      h.longPress(P, 'select');                           // last set -> how did it feel?
      await h.sleep(1000);
      h.press(P, 'select');                               // default answer -> summary, uploads
      await h.waitFor(() => capture.posts.length > 0, { timeout: 30_000, message: 'workout upload' });

      // ---- 4. What the phone received ----
      const summary = h.parseWorkoutSummary(capture.posts[0].workoutData);
      expect(summary.routine).toBe('E2E Routine');
      expect(summary.exercises).toEqual([
        { name: 'Bench Press', sets: [{ reps: 10, weight: 60 }] },
        { name: 'Plank [TIMED]', sets: [{ reps: 5, weight: 0 }] },
      ]);

      const syncedBack = 'E2E Routine|-1|2|Bench Press|1|10|60|0|-|Plank|1|5|0|8|-';
      const stored = h.readPhoneStorage();
      expect(JSON.parse(stored.synced_routines)['E2E Routine']).toBe(syncedBack);

      // ---- 5. Opening settings again runs the app's showConfiguration, and the
      //         page URL it announces carries the synced routine and the workout.
      //         (Done last: leaving a settings session open stalls the phone-side
      //         JS in the emulator.)
      const settings = new URL(await h.getConfigUrlFromPhone());
      expect(JSON.parse(settings.searchParams.get('sync'))['E2E Routine']).toBe(syncedBack);
      const history = JSON.parse(settings.searchParams.get('history'));
      expect(history.map((w) => w.data)).toEqual([capture.posts[0].workoutData]);
    } finally {
      capture.close();
      h.killEmulator();
    }
  });
});
