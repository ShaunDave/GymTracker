// @ts-check
// Timed (Count down) modifier (value 8) — config page and phone-side JS.
//
// Layer 1 needs no emulator: the config page runs in Chromium and pkjs/index.js
// runs in a Node sandbox with Pebble/localStorage stubbed. The watch itself is
// covered by test-countdown-watch.js.
//
// Run: cd tests && npx playwright test test-countdown-config.js

const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index.html', 'index_dev.html'];

// A workout summary as the watch sends it (captured from a real emulator run):
// both timed modes export under the same [TIMED] label, and the reps column
// holds elapsed seconds.
const SUMMARY =
  'Timed Mix|2026-10-24 17:11|18|5|110|0|Wall Sit [TIMED]|0|0|0|0|5|0|0|0|8|0|0|0' +
  '|Plank [TIMED]|0|0|0|0|5|0|0|0|8|0|0|0|@HR|';

async function openConfig(page, file, query = {}) {
  const qs = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`).join('&');
  await page.goto(`file://${ROOT}/${file}${qs ? `?${qs}` : ''}`);
  await page.waitForFunction(() => typeof Storage !== 'undefined');
}

// Fills the builder form the way a user would. Weight is left alone for timed
// exercises: the page fills it with 0 itself.
async function addExercise(page, { name, sets, reps, weight, modifier = 0, note = '' }) {
  await page.evaluate((n) => {
    const sel = document.getElementById('exerciseSelect');
    sel.appendChild(new Option(n, n));
    sel.value = n;
  }, name);
  await page.fill('#targetSets', String(sets));
  await page.fill('#targetReps', String(reps));
  await page.selectOption('#exerciseModifier', String(modifier));
  if (weight !== undefined) await page.fill('#targetWeight', String(weight));
  if (note) await page.fill('#exerciseComment', note);
  await page.click('#addUpdateBtn');
}

// Intercepts what would be handed to the Pebble app when the page closes.
async function captureSend(page, buttonSelector = '#btn-send-single') {
  await page.evaluate(() => {
    window.__sent = null;
    window.alert = () => {};
    window.sendToPebble = (cfg) => { window.__sent = cfg; };
  });
  await page.click(buttonSelector);
  return page.evaluate(() => window.__sent);
}

for (const file of PAGES) {
  test.describe(`Layer 1 — Count down modifier on config page (${file})`, () => {
    test('offers "Timed (Count down)" as modifier 8, next to Count up', async ({ page }) => {
      await openConfig(page, file);
      const options = await page.$$eval('#exerciseModifier option', (os) => os.map((o) => [o.value, o.textContent]));
      expect(options).toContainEqual(['6', 'Timed (Count up)']);
      expect(options).toContainEqual(['8', 'Timed (Count down)']);
    });

    test('choosing it switches the form to seconds and forces weight to 0', async ({ page }) => {
      await openConfig(page, file);
      await page.selectOption('#exerciseModifier', '8');
      await expect(page.locator('#modifierDesc')).toContainText('Count down');
      await expect(page.locator('#labelTargetReps')).toHaveText('Target Seconds:');
      await expect(page.locator('#targetWeight')).toHaveValue('0');

      // Leaving the timed modifier restores the normal reps/weight form.
      await page.selectOption('#exerciseModifier', '0');
      await expect(page.locator('#labelTargetReps')).toHaveText('Target Reps:');
      await expect(page.locator('#targetWeight')).toHaveValue('');
    });

    test('lists a countdown exercise as seconds with a COUNTDOWN badge, never as bodyweight', async ({ page }) => {
      await openConfig(page, file);
      await addExercise(page, { name: 'Wall Sit', sets: 3, reps: 30, modifier: 6 });
      await addExercise(page, { name: 'Plank', sets: 3, reps: 45, modifier: 8 });

      const items = page.locator('.exercise-item');
      await expect(items).toHaveCount(2);

      // control: count up is unchanged
      await expect(items.nth(0)).toContainText('TIMED');
      await expect(items.nth(0)).toContainText('30sec');
      await expect(items.nth(0)).not.toContainText('BODYWEIGHT');

      await expect(items.nth(1)).toContainText('COUNTDOWN');
      await expect(items.nth(1)).toContainText('45sec');
      await expect(items.nth(1)).not.toContainText('45r');
      await expect(items.nth(1)).not.toContainText('BODYWEIGHT');
      await expect(items.nth(1)).not.toContainText('BW');

      const routine = await page.evaluate(() => myRoutine);
      expect(routine[1].slice(0, 5)).toEqual(['Plank', 3, 45, 0, 8]);
    });

    test('editing a countdown exercise reloads modifier 8 and keeps it on update', async ({ page }) => {
      await openConfig(page, file);
      await addExercise(page, { name: 'Plank', sets: 3, reps: 45, modifier: 8 });

      await page.click('.exercise-item button:has-text("Edit")');
      await expect(page.locator('#exerciseModifier')).toHaveValue('8');
      await expect(page.locator('#modifierDesc')).toContainText('Count down');
      await expect(page.locator('#targetWeight')).toHaveValue('0');

      await page.fill('#targetReps', '60');
      await page.click('#addUpdateBtn');
      const routine = await page.evaluate(() => myRoutine);
      expect(routine).toHaveLength(1);
      expect(routine[0].slice(0, 5)).toEqual(['Plank', 3, 60, 0, 8]);
    });

    test('sends a mixed count-up / count-down routine to the watch with modifiers intact', async ({ page }) => {
      await openConfig(page, file);
      await page.fill('#routineName', 'Timed Mix');
      await addExercise(page, { name: 'Wall Sit', sets: 3, reps: 30, modifier: 6 });
      await addExercise(page, { name: 'Plank', sets: 3, reps: 45, modifier: 8, note: 'Elbows' });
      await addExercise(page, { name: 'Bench Press', sets: 3, reps: 10, weight: 60 });

      const sent = await captureSend(page);
      expect(sent.routineData).toBe('Timed Mix|Wall Sit|3|30|0|6|-|Plank|3|45|0|8|Elbows|Bench Press|3|10|60|0|-');
      expect(encodeURIComponent(JSON.stringify(sent)).length)
        .toBeLessThanOrEqual(await page.evaluate(() => MAX_CONFIG_RESPONSE));
    });

    test('switching an already-synced exercise from count up to count down is re-sent, not skipped as unchanged', async ({ page }) => {
      const synced = 'Timed Mix|-1|2|Plank|3|45|0|6|-';
      await openConfig(page, file, { sync: { 'Timed Mix': synced } });
      await page.waitForFunction(() => document.getElementById('savedRoutineSelect').options.length >= 2);
      await page.selectOption('#savedRoutineSelect', 'Timed Mix');

      // control: unchanged → only settings are sent, no routine
      const unchanged = await captureSend(page);
      expect(unchanged.routineData).toBeUndefined();

      await page.click('.exercise-item button:has-text("Edit")');
      await page.selectOption('#exerciseModifier', '8');
      await page.click('#addUpdateBtn');

      const changed = await captureSend(page);
      expect(changed.routineData).toBe('Timed Mix|Plank|3|45|0|8|-');
    });

    test('a countdown routine synced back from the watch keeps modifier 8', async ({ page }) => {
      const synced = 'Timed Mix|-1|2|Wall Sit|3|30|0|6|-|Plank|3|45|0|8|-';
      await openConfig(page, file, { sync: { 'Timed Mix': synced } });
      await page.waitForFunction(() => document.getElementById('savedRoutineSelect').options.length >= 2);
      await page.selectOption('#savedRoutineSelect', 'Timed Mix');

      const routine = await page.evaluate(() => myRoutine.map((e) => [e[0], e[4]]));
      expect(routine).toEqual([['Wall Sit', 6], ['Plank', 8]]);
      await expect(page.locator('.exercise-item').nth(1)).toContainText('COUNTDOWN');
    });

    test('routine definitions exported for backup carry the modifier', async ({ page }) => {
      await openConfig(page, file);
      await page.evaluate(() => saveRoutineToStorage('Timed Mix', [['Plank', 3, 45, 0, 8, '']], '-1', '2'));
      const defs = await page.evaluate(() => getAllRoutineDefinitions());
      expect(defs['Timed Mix']).toBe('Timed Mix|-1|2|Plank:3:45:0:8:');
    });

    test('a finished timed workout exports to CSV with both modes under [TIMED] and seconds as reps', async ({ page }) => {
      await openConfig(page, file, { history: [{ timestamp: 1, data: SUMMARY }] });
      await page.click('.tab-btn:has-text("History")');
      await page.click('button:has-text("Copy Selected")');
      const csv = await page.locator('#csv-export-textarea').inputValue();
      const rows = csv.split('\n');

      expect(rows[0]).toBe('Date,Routine,Duration (s),Mood,Accuracy (%),Density,Peak HR,Avg HR,Exercise,Set,Reps,Weight');
      const sets = rows.slice(1).filter((r) => r.includes('[TIMED]')).map((r) => r.split(','));
      expect(sets.map((c) => [c[8], c[9], c[10]])).toEqual([
        ['Wall Sit [TIMED]', '1', '0'], ['Wall Sit [TIMED]', '2', '5'], ['Wall Sit [TIMED]', '3', '8'],
        ['Plank [TIMED]', '1', '0'], ['Plank [TIMED]', '2', '5'], ['Plank [TIMED]', '3', '8'],
      ]);
    });
  });
}

test.describe('Layer 1 — Count down modifier: both config pages stay in step', () => {
  test('index.html and index_dev.html are identical', () => {
    const norm = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    expect(norm('index.html') === norm('index_dev.html')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phone-side JS (pkjs/index.js) in a Node sandbox
// ---------------------------------------------------------------------------
function loadPkjs() {
  const store = {};
  const handlers = {};
  const sent = [];
  const posts = [];
  const ctx = {
    console: { log() {} },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    Pebble: {
      addEventListener: (name, fn) => { handlers[name] = fn; },
      sendAppMessage: (msg) => { sent.push(msg); },
      openURL() {},
    },
    XMLHttpRequest: function () {
      this.open = () => {};
      this.setRequestHeader = () => {};
      this.send = (body) => { posts.push(JSON.parse(body)); };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gymtracker/src/pkjs/index.js'), 'utf8'), ctx);
  return { ctx, store, handlers, sent, posts };
}

test.describe('Layer 1 — Count down modifier in the phone-side JS (pkjs)', () => {
  test('forwards the routine from the config page to the watch unchanged', () => {
    const { handlers, sent } = loadPkjs();
    const routine = 'Timed Mix|Wall Sit|3|30|0|6|-|Plank|3|45|0|8|-';
    handlers.webviewclosed({ response: encodeURIComponent(JSON.stringify({ routineData: routine, progressionMode: '-1', weightIncrement: '2' })) });
    expect(sent[0].ROUTINE_DATA).toBe(routine);
  });

  test('routine synced back from the watch is stored with modifier 8', () => {
    const { handlers, store } = loadPkjs();
    handlers.appmessage({ payload: { ROUTINE_DATA: 'Timed Mix|-1|2|Wall Sit|3|30|0|6|-|Plank|3|45|0|8|-' } });

    const saved = JSON.parse(store.savedRoutines);
    expect(saved[0].exercises.map((e) => [e[0], e[4]])).toEqual([['Wall Sit', 6], ['Plank', 8]]);
    expect(JSON.parse(store.synced_routines)['Timed Mix']).toContain('|Plank|3|45|0|8|-');
  });

  test('a finished workout is stored verbatim and uploaded to the Google endpoint', () => {
    const { handlers, store, posts } = loadPkjs();
    store.googleUrl = 'https://example.invalid/exec';
    store.googlePwd = 'secret';
    handlers.appmessage({ payload: { WORKOUT_SUMMARY: SUMMARY } });

    expect(JSON.parse(store.workoutHistory)[0].data).toBe(SUMMARY);
    expect(posts).toEqual([{ token: 'secret', workoutData: SUMMARY }]);
  });
});
