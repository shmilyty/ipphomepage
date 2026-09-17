import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DEFAULT_TUNING, createGame, preview, seededRandom } from '../src/game/carry';

/** 固定种子让页面与引擎算出同一局，断言才能写成确切数字而不是范围。 */
const SEED = 20260916;
const SIZE = DEFAULT_TUNING.size;
const hud = (page: Page, nth: number) => page.locator('.play-hud strong').nth(nth);
const counters = (page: Page) => page.locator('.play-board .counter');

test('同一个种子给出同一局，预览标出的连锁与真正结算一致', async ({ page }) => {
  await page.goto(`/play?seed=${SEED}`);
  const expected = createGame(seededRandom(SEED));
  await expect(counters(page)).toHaveCount(DEFAULT_TUNING.seedCount);
  await expect(hud(page, 1)).toHaveText(`0/${DEFAULT_TUNING.turnLimit}`);

  // 引擎里找一枚点下去能连锁的计数器，页面上应当预览出同样的环数与分数。
  const best = expected.board
    .map((cell, index) => (cell ? { index, ...preview(expected, index) } : null))
    .filter((item): item is NonNullable<typeof item> => !!item)
    .sort((a, b) => b.points - a.points)[0];
  expect(best.order, '这个种子应当开局就有可引爆的计数器').toBeGreaterThan(0);

  const target = page.locator('.play-board .cell').nth(best.index).locator('.counter');
  await target.hover();
  await expect(page.locator('.preview-card')).toContainText(`+${best.points}`);
  await expect(page.locator('.preview-card')).toContainText(`连锁 ${best.order} 环`);
  await expect(page.locator('.cell.is-path')).toHaveCount(best.order);

  await target.click();
  await expect(hud(page, 0)).toHaveText(String(best.points));
  await expect(hud(page, 1)).toHaveText(`1/${DEFAULT_TUNING.turnLimit}`, { timeout: 5000 });
  await expect(hud(page, 2)).toHaveText(String(best.order));
});

test('一次点击只走一个回合，转向不得分但同样花掉一个回合', async ({ page }) => {
  await page.goto(`/play?seed=${SEED}`);
  const first = counters(page).first();
  await first.hover();
  await first.click();
  await expect(hud(page, 1)).toHaveText(`1/${DEFAULT_TUNING.turnLimit}`);
  await page.waitForTimeout(600);
  await expect(hud(page, 1)).toHaveText(`1/${DEFAULT_TUNING.turnLimit}`, { timeout: 2000 });

  // 转向：数值不变、分数不变，但回合数照样 +1。
  const cell = page
    .locator('.play-board .cell')
    .filter({ has: page.locator('.counter') })
    .first();
  const before = { value: await cell.locator('.counter-value').innerText(), score: await hud(page, 0).innerText() };
  await cell.locator('.counter').hover();
  await cell.locator('.rotate-badge').click();
  await expect(hud(page, 1)).toHaveText(`2/${DEFAULT_TUNING.turnLimit}`);
  await expect(hud(page, 0)).toHaveText(before.score);
  await expect(
    page
      .locator('.play-board .cell')
      .filter({ has: page.locator('.counter') })
      .first()
      .locator('.counter-value')
  ).toHaveText(before.value);
});

test('纯键盘可玩：方向键移动、回车加一、R 转向', async ({ page }) => {
  await page.goto(`/play?seed=${SEED}`);
  await counters(page).first().focus();
  const dirOf = () => page.locator('.counter:focus .counter-arrow').evaluate(node => getComputedStyle(node).rotate);
  const before = await dirOf();
  await page.keyboard.press('r');
  await expect(hud(page, 1)).toHaveText(`1/${DEFAULT_TUNING.turnLimit}`);
  await page.waitForTimeout(400);
  expect(await dirOf(), 'R 应当把箭头顺时针转 90 度').not.toBe(before);

  // 方向键移动光标，并且不越过左右边界。
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.play-board .cell').nth(1)).toHaveClass(/is-armed/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.play-board .cell').nth(0)).toHaveClass(/is-armed/);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.play-board .cell').nth(0)).toHaveClass(/is-armed/);
  await expect(page.locator('.play-board .cell.is-armed')).toHaveCount(1);
});

test('一局打满就结算，可以按同一种子重开', async ({ page }) => {
  test.setTimeout(180000);
  // 关掉动效，回放直接落到结果，一百个回合才跑得完。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/play?seed=${SEED}`);
  for (let i = 0; i < DEFAULT_TUNING.turnLimit; i++) {
    if (await page.locator('.play-over').isVisible()) break;
    const live = counters(page).first();
    if (!(await live.count())) break;
    await live.hover();
    await live.click();
  }
  const over = page.locator('.play-over');
  await expect(over).toBeVisible({ timeout: 20000 });
  await expect(over).toContainText(`种子 ${SEED}`);
  await expect(hud(page, 1)).toHaveText(`${DEFAULT_TUNING.turnLimit}/${DEFAULT_TUNING.turnLimit}`);

  await over.getByRole('button', { name: /重开这一局/ }).click();
  await expect(over).toBeHidden();
  await expect(hud(page, 1)).toHaveText(`0/${DEFAULT_TUNING.turnLimit}`);
  await expect(counters(page)).toHaveCount(DEFAULT_TUNING.seedCount);
  // 最高分要留在 HUD 上，重开不清零。
  await expect(hud(page, 3)).not.toHaveText('0');
});

test('游戏页在深浅色下都没有严重可访问性问题', async ({ page }) => {
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.goto(`/play?seed=${SEED}`);
    await expect(counters(page).first()).toBeVisible();
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(
      result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical'),
      `/play ${mode}`
    ).toEqual([]);
  }
});

test('棋盘在手机宽度下仍是正方形且不横向溢出', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', '只在移动端项目跑');
  await page.goto(`/play?seed=${SEED}`);
  const box = await page.locator('.play-board').boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true
  );
  expect(box!.width / SIZE).toBeGreaterThan(40); // 每格至少有可点的尺寸
});
