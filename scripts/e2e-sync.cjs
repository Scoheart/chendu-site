// Browser end-to-end test of login + sync (two devices, offline, merge, logout).
// Needs playwright (npm i -D playwright && npx playwright install chromium) and a running
// `npm run dev:local` on :3000 with a fresh auth_attempts table (registration is rate limited).
// Screenshots go to SHOTS (default /workspace/chendu-site-shots/).
const { chromium } = require('playwright');
const assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000', ISSUE = '/issues/2026-10-19/', SHOTS = process.env.SHOTS || '/workspace/chendu-site-shots/';
const NK = 'chendu:notes:2026-10-19', TK = 'chendu:tr:2026-10-19', RK = 'chendu:recall:2026-10-19';
const email = `lin-${Date.now().toString(36)}@example.com`, pw = 'chendu-test-123';
const errors = [];
let n = 0; const ok = (m) => console.log(`ok ${++n} - ${m}`);

function note(id, quote, text, prefix, t) { return { id, quote, prefix, suffix: '', start: 0, end: 0, text, created: t, updated: t }; }
async function newDevice(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.mobile ? { width: 390, height: 844 } : { width: 1360, height: 900 }, deviceScaleFactor: 2, hasTouch: !!opts.mobile, isMobile: !!opts.mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}
const ls = (page, k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || 'null'), k);
const synced = (page) => page.waitForSelector('.acct.in[data-status="ok"]', { timeout: 15000 });
async function login(page, mode) {
  await page.click('.acct');
  await page.waitForSelector('.acct-modal:not([hidden])');
  if (mode === 'register') await page.click('.am-tab[data-mode="register"]');
  await page.fill('.am-form input[type=email]', email);
  await page.fill('.am-form input[type=password]', pw);
  await page.click('.am-submit');
  await synced(page);
}
async function writeTr(page, i, text) {
  const box = page.locator('.para-tr').nth(i);
  if (await box.locator('.tr-add').isVisible()) await box.locator('.tr-add').click(); else await box.locator('.tr-edit').click();
  await box.locator('textarea').fill(text);
  await page.locator('h1.title').click();
  await page.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch();

  // ---------- no backend at all (static hosting): page must behave exactly as before
  {
    const { ctx, page } = await newDevice(browser);
    await page.route('**/api/**', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
    await page.goto(BASE + ISSUE);
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.acct').count(), 0);
    await writeTr(page, 0, '静态托管下也能写翻译');
    assert.equal((await ls(page, TK)).items[0].text, '静态托管下也能写翻译');
    ok('without /api: no login entry, translation still saved to localStorage');
    await ctx.close();
  }

  // ---------- device 1: logged out, has local data
  const d1 = await newDevice(browser);
  await d1.page.goto(BASE + ISSUE);
  await d1.page.evaluate(([NK, n]) => localStorage.setItem(NK, JSON.stringify({ v: 1, notes: [n] })),
    [NK, note('pc1', 'Quarterly financial updates', '电脑上写的：季报', 'NEW YORK (AP) — ', 1000)]);
  await d1.page.reload();
  await d1.page.waitForSelector('.acct');
  assert.equal((await d1.page.textContent('.acct')).trim(), '登录 · 同步笔记'); assert.equal(await d1.page.locator('.acct-more').isVisible(), true);
  await writeTr(d1.page, 0, '纽约（美联社）——本周，包括科技公司和航空公司在内的众多美国大公司将密集发布季报。');
  await d1.page.locator('.recall-item').nth(0).locator('input').check();
  assert.equal(await d1.page.locator('.un-hl').count() > 0, true);
  await d1.page.screenshot({ path: SHOTS + '01-logged-out-header.png', clip: { x: 0, y: 0, width: 1360, height: 420 } });
  ok('logged out: login entry shown, local note/translation/checkbox work');

  await d1.page.click('.acct');
  await d1.page.waitForSelector('.acct-modal:not([hidden])');
  await d1.page.screenshot({ path: SHOTS + '02-login-dialog.png' });
  await d1.page.click('.am-tab[data-mode="register"]');
  await d1.page.fill('.am-form input[type=email]', 'bad');
  await d1.page.fill('.am-form input[type=password]', '123');
  await d1.page.click('.am-submit');
  assert.match(await d1.page.textContent('.am-err'), /邮箱/);
  await d1.page.keyboard.press('Escape');
  await login(d1.page, 'register');
  await d1.page.screenshot({ path: SHOTS + '03-registered-synced-header.png', clip: { x: 0, y: 0, width: 1360, height: 420 } });
  const srv1 = await d1.page.evaluate(() => fetch('/api/sync').then((r) => r.json()));
  assert.equal(srv1.docs.length, 3);
  assert.match(await d1.page.textContent('.mynotes .hint'), /同步到你的账号/);
  ok('register on device 1: local note, translation and checkbox uploaded (3 docs)');

  // ---------- device 2 (phone): already has its own local note, then logs in -> both sides kept
  const d2 = await newDevice(browser, { mobile: true });
  await d2.page.goto(BASE + ISSUE);
  await d2.page.evaluate(([NK, n]) => localStorage.setItem(NK, JSON.stringify({ v: 1, notes: [n] })),
    [NK, note('ph1', 'dominate the calendar', '手机上写的：占据日程', 'airlines, will ', 2000)]);
  await d2.page.reload();
  await d2.page.waitForSelector('.acct');
  await d2.page.screenshot({ path: SHOTS + '04-phone-logged-out.png' });
  await d2.page.click('.acct');
  await d2.page.waitForSelector('.acct-modal:not([hidden])');
  await d2.page.screenshot({ path: SHOTS + '05-phone-login-dialog.png' });
  await d2.page.keyboard.press('Escape');
  await login(d2.page, 'login');
  await d2.page.waitForFunction((NK) => (JSON.parse(localStorage.getItem(NK)).notes || []).length === 2, NK);
  const ids = (await ls(d2.page, NK)).notes.map((x) => x.id).sort();
  assert.deepEqual(ids, ['pc1', 'ph1']);
  assert.match((await ls(d2.page, TK)).items[0].text, /纽约/);
  assert.equal(await d2.page.locator('.recall-item').nth(0).locator('input').isChecked(), true);
  assert.equal(await d2.page.locator('.un-hl').count() >= 2, true);
  ok('first login on device 2 merged: both notes kept, translation + checkbox pulled down and rendered');
  await d2.page.locator('.para-col').first().scrollIntoViewIfNeeded();
  await d2.page.locator('.un-sup').first().click();
  await d2.page.waitForTimeout(400);
  await d2.page.screenshot({ path: SHOTS + '06-phone-synced-note.png' });

  // ---------- device 1 picks up device 2's note on reload, and shows it
  await d1.page.reload(); await synced(d1.page);
  assert.equal((await ls(d1.page, NK)).notes.length, 2);
  await d1.page.locator('#mynotes').scrollIntoViewIfNeeded();
  await d1.page.waitForTimeout(300);
  await d1.page.screenshot({ path: SHOTS + '07-desktop-synced-notes-list.png', fullPage: false });
  await d1.page.locator('h1.title').scrollIntoViewIfNeeded();
  await d1.page.screenshot({ path: SHOTS + '08-desktop-synced-note-in-margin.png', clip: { x: 0, y: 200, width: 1360, height: 700 } });
  ok('device 1 reload: note written on the phone appears');

  // ---------- edit on phone -> desktop sees it after focus/reload
  await writeTr(d2.page, 0, '手机上改过的翻译');
  await d2.page.waitForTimeout(1600); await synced(d2.page);
  await d1.page.reload(); await synced(d1.page);
  assert.equal((await ls(d1.page, TK)).items[0].text, '手机上改过的翻译');
  ok('edit on phone synced to desktop');

  // ---------- offline: desktop edits while the API is unreachable, edit survives reload and syncs later
  await d1.page.route('**/api/**', (r) => r.abort('internetdisconnected'));
  await writeTr(d1.page, 1, '离线时写的翻译');
  await d1.page.waitForSelector('.acct[data-status="error"], .acct[data-status="offline"]', { timeout: 8000 });
  await d1.page.click('.acct'); await d1.page.waitForTimeout(200);
  await d1.page.screenshot({ path: SHOTS + '09-offline-status-menu.png', clip: { x: 760, y: 0, width: 600, height: 380 } });
  await d1.page.keyboard.press('Escape'); await d1.page.locator('h1.title').click();
  await d1.page.reload(); await d1.page.waitForTimeout(800);
  assert.equal((await ls(d1.page, TK)).items.find((x) => x.i === 1).text, '离线时写的翻译');
  // meanwhile the phone also edits paragraph 0 -> must merge, not overwrite
  await writeTr(d2.page, 2, '手机上同时写的第三段'); await d2.page.waitForTimeout(1600); await synced(d2.page);
  await d1.page.unroute('**/api/**');
  await d1.page.reload(); await synced(d1.page);
  const trs = (await ls(d1.page, TK)).items.map((x) => x.i + ':' + x.text).sort();
  assert.deepEqual(trs, ['0:手机上改过的翻译', '1:离线时写的翻译', '2:手机上同时写的第三段']);
  await d2.page.reload(); await synced(d2.page);
  assert.equal((await ls(d2.page, TK)).items.length, 3);
  ok('offline edit kept locally, pushed once back online, merged with concurrent phone edit');

  // ---------- concurrent edit of the SAME paragraph -> both texts kept
  await d1.page.route('**/api/**', (r) => r.abort('internetdisconnected'));
  await writeTr(d1.page, 0, '电脑版译文');
  await writeTr(d2.page, 0, '手机版译文'); await d2.page.waitForTimeout(1600); await synced(d2.page);
  await d1.page.unroute('**/api/**'); await d1.page.reload(); await synced(d1.page);
  const t0 = (await ls(d1.page, TK)).items.find((x) => x.i === 0).text;
  assert.ok(t0.includes('电脑版译文') && t0.includes('手机版译文'), t0);
  ok('same paragraph edited on two devices while offline: both versions kept');

  // ---------- delete on phone propagates
  await d2.page.reload(); await synced(d2.page);
  await d2.page.evaluate((NK) => { const v = JSON.parse(localStorage.getItem(NK)); v.notes = v.notes.filter((x) => x.id !== 'ph1'); localStorage.setItem(NK, JSON.stringify(v)); ChenduSync.touch(NK); }, NK);
  await d2.page.waitForTimeout(1600); await synced(d2.page);
  await d1.page.reload(); await synced(d1.page);
  assert.deepEqual((await ls(d1.page, NK)).notes.map((x) => x.id), ['pc1']);
  ok('deleting a note on one device removes it on the other (not resurrected by merge)');

  // ---------- logout keeps local copy; logout+wipe clears it; login restores
  await d1.page.click('.acct'); await d1.page.click('.acct-btn:has-text("退出登录")');
  await d1.page.waitForSelector('.acct:not(.in)');
  assert.equal((await d1.page.textContent('.acct')).trim(), '登录 · 同步笔记'); assert.equal(await d1.page.locator('.acct-more').isVisible(), true);
  assert.equal((await ls(d1.page, NK)).notes.length, 1);
  assert.equal(await d1.page.evaluate(() => fetch('/api/sync').then((r) => r.status)), 401);
  ok('logout: back to logged-out UI, local notes stay on the device');
  d2.page.on('dialog', (dlg) => dlg.accept());
  await d2.page.click('.acct'); await d2.page.click('.acct-btn:has-text("退出并清除本机笔记")');
  await d2.page.waitForSelector('.acct:not(.in)');
  assert.equal(await ls(d2.page, NK), null);
  assert.equal(await d2.page.locator('.un-hl').count(), 0);
  await login(d2.page, 'login');
  await d2.page.waitForFunction((NK) => !!localStorage.getItem(NK), NK);
  assert.deepEqual((await ls(d2.page, NK)).notes.map((x) => x.id), ['pc1']);
  ok('logout + wipe clears this device; logging in again restores from the account');

  // index page shows the entry too
  await d1.page.goto(BASE + '/');
  await d1.page.waitForSelector('.acct');
  await d1.page.screenshot({ path: SHOTS + '10-home-login-entry.png', clip: { x: 0, y: 0, width: 1360, height: 360 } });

  assert.deepEqual(errors, []);
  ok('no page errors');
  await browser.close();
})().catch((e) => { console.error('FAIL', e); console.error('page errors:', errors); process.exit(1); });
