import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database, chosen BEFORE the connection module is imported — DATA_DIR is read at import
// time and the handle is a module singleton, so this must happen first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'qalo-forecast-test-'));

const { default: Fastify } = await import('fastify');
const { forecastRoutes } = await import('../forecast.ts');
const { getDb, today } = await import('../../db/connection.ts');
const { addMonths, firstOfMonth, monthKey } = await import('../../../engine/dates.ts');

const app = Fastify();
forecastRoutes(app);

const db = getDb();
const setMonths = (rows: [number, number, number][]) => {
  db.prepare('DELETE FROM wearable_forecast').run();
  const ins = db.prepare('INSERT INTO wearable_forecast (year, month, units, updated_at) VALUES (?,?,?,?)');
  for (const [y, m, u] of rows) ins.run(y, m, u, '2026-01-01T00:00:00Z');
};
const get = async () => (await app.inject({ method: 'GET', url: '/api/forecast' })).json();
const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/forecast', payload });

/** The Nth month of the rolling window, as the route labels it. */
const win = (n: number) => monthKey(addMonths(firstOfMonth(today()), n));

before(() => { app.ready(); });

test('GET returns the rolling window from THIS month, not the highest year on file', async () => {
  // The shape that broke it in production: a current year and a next year both on file. The old
  // route answered with whichever year was highest, so the editor always opened on next year — and
  // the figures the user had just saved for this year appeared to have vanished.
  const thisYear = Number(today().slice(0, 4));
  setMonths([
    ...Array.from({ length: 12 }, (_, i) => [thisYear, i + 1, 100 + i] as [number, number, number]),
    ...Array.from({ length: 12 }, (_, i) => [thisYear + 1, i + 1, 900 + i] as [number, number, number]),
  ]);

  const res = await get();
  assert.equal(res.months[0].month, win(0), 'the window must start with the current month');
  assert.equal(res.months[0].units, 100 + Number(today().slice(5, 7)) - 1,
    'and carry THIS month\'s figure, not next year\'s');
  assert.equal(res.plan_months, 12);
  assert.ok(res.months.length > 12, 'the window must reach past the plan into the China lead');
  assert.equal(res.months.filter((m: any) => m.in_plan_window).length, 12);
  // Consecutive real months, so no month can be silently skipped or repeated.
  res.months.forEach((m: any, i: number) => assert.equal(m.month, win(i), `month ${i}`));
});

test('a month with nothing on file is reported as not entered, so the UI can flag it', async () => {
  setMonths([]);
  const res = await get();
  assert.ok(res.months.every((m: any) => m.entered === false && m.units === 0));
  assert.equal(res.months_on_file, 0);

  // Fill exactly one month; only that one flips.
  await put({ months: [{ month: win(2), units: 500 }] });
  const after = await get();
  assert.deepEqual(
    after.months.filter((m: any) => m.entered).map((m: any) => [m.month, m.units]),
    [[win(2), 500]],
  );
});

test('save then reload returns what was saved — the bug the user actually hit', async () => {
  setMonths([]);
  const sent = [
    { month: win(0), units: 1234 },
    { month: win(1), units: 777 },
  ];
  const res = await put({ months: sent });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().saved, sent, 'the response states what was stored');

  const reloaded = await get();
  assert.equal(reloaded.months[0].units, 1234);
  assert.equal(reloaded.months[1].units, 777);
});

test('a partial save leaves the months it did not send alone', async () => {
  setMonths([]);
  await put({ months: [{ month: win(0), units: 111 }, { month: win(1), units: 222 }] });
  await put({ months: [{ month: win(1), units: 333 }] });
  const res = await get();
  assert.equal(res.months[0].units, 111, 'an untouched month must survive a partial save');
  assert.equal(res.months[1].units, 333);
});

test('rejects nonsense instead of storing it', async () => {
  for (const bad of [
    { months: [{ month: '2026-13', units: 5 }] },      // month 13
    { months: [{ month: 'July 2026', units: 5 }] },    // not YYYY-MM
    { months: [{ month: win(0), units: -5 }] },        // negative
    { months: [{ month: win(0), units: 'lots' }] },    // not a number
    { months: [] },                                    // nothing to save
    { nonsense: true },                                // wrong shape entirely
  ]) {
    const res = await put(bad);
    assert.equal(res.statusCode, 400, `should reject ${JSON.stringify(bad)}`);
    assert.ok(String(res.json().error).length > 0, 'and say why');
  }
});

test('still accepts the retired year-at-a-time shape, so an old browser tab keeps working', async () => {
  setMonths([]);
  const year = Number(win(0).slice(0, 4));
  const res = await put({ year, monthlyUnits: Array.from({ length: 12 }, (_, i) => 50 + i) });
  assert.equal(res.statusCode, 200);
  const rows = db.prepare('SELECT month, units FROM wearable_forecast WHERE year = ? ORDER BY month').all(year) as
    { month: number; units: number }[];
  assert.deepEqual(rows.map(r => r.units), Array.from({ length: 12 }, (_, i) => 50 + i));
});
