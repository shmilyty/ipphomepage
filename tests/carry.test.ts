import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL,
  DEFAULT_TUNING,
  applyMove,
  createGame,
  heatDebt,
  play,
  preview,
  rayHit,
  rotate,
  type Board,
  type Counter,
  type Dir
} from '../src/game/carry.ts';

const SIZE = DEFAULT_TUNING.size;
/** 用空格分隔的 "值朝向" 记号描述棋盘，单个句点表示空格。朝向用 ^ > v < 四个字符。 */
function makeBoard(rows: string[]): Board {
  const dirs: Record<string, Dir> = { '^': 0, '>': 1, v: 2, '<': 3 };
  const board: Board = Array(SIZE * SIZE).fill(null);
  rows.forEach((row, y) =>
    row
      .trim()
      .split(/\s+/)
      .forEach((token, x) => {
        if (token === '.') return;
        board[y * SIZE + x] = { id: y * SIZE + x + 1, value: Number(token[0]), dir: dirs[token[1]] };
      })
  );
  return board;
}
const fixed = (values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

test('进位沿射线穿过空格，并且前段清掉的格子会让后段打得更远', () => {
  const board = makeBoard(['3> . 3< . 2^']);
  assert.equal(rayHit(board, 0, 1, SIZE), 2, '向右应越过空格命中第 3 格');
  assert.equal(rayHit(board, 0, 0, SIZE), null, '射出棋盘则作废');
  // C A B 三枚相邻且全满：A 向右打 B，B 回头时会穿过 A 留下的空位继续打到 C。
  const dynamic = makeBoard(['3v 3> 3<']);
  const { order, points } = applyMove(dynamic, { kind: 'bump', index: 1 }, SIZE);
  assert.equal(order, 3, '连锁应为 3，静态箭头图里 A、B 互指会误判成 2');
  assert.equal(points, 6);
});

test('连锁计分是三角数，preview 与真正结算完全一致', () => {
  const board = makeBoard(['3> 3> 3> 3> 3>']);
  const game = { ...createGame(fixed([0]), DEFAULT_TUNING), board };
  const shown = preview(game, 0);
  assert.deepEqual(shown.path, [0, 1, 2, 3, 4]);
  assert.equal(shown.points, 1 + 2 + 3 + 4 + 5);
  const played = play(game, { kind: 'bump', index: 0 }, fixed([0]));
  assert.equal(played.game.score, shown.points, 'preview 不能只是估计');
  assert.equal(played.game.chain, shown.order);
});

test('提前加热可以在相同回合数内多得分：这是本作的核心取舍', () => {
  // 3> 2> 3v 三枚相邻，其余为空。两种打法都花两回合、都清三枚，得分不同。
  const start = () => ({
    ...createGame(fixed([0]), { ...DEFAULT_TUNING, seedCount: 0 }),
    board: makeBoard(['3> 2> 3v'])
  });
  const noSpawn = () => 0; // 生成落在 0 号空格，不影响这三枚
  let greedy = start();
  greedy = play(greedy, { kind: 'bump', index: 0 }, noSpawn).game; // 先兑现：清 1 枚
  greedy = play(greedy, { kind: 'bump', index: 1 }, noSpawn).game; // 再清 2 枚
  let planned = start();
  planned = play(planned, { kind: 'bump', index: 1 }, noSpawn).game; // 先加热中间那枚
  planned = play(planned, { kind: 'bump', index: 0 }, noSpawn).game; // 再一次清 3 枚
  assert.equal(greedy.score, 4);
  assert.equal(planned.score, 6);
  assert.ok(planned.score > greedy.score, '见满就点不应支配提前加热');
});

test('转向把两段接起来，正好多得两段长度之积', () => {
  // 上排三连朝右，下排两连朝右；把上排末枚从「右」转成「下」即可把两段接成一条。
  const board = makeBoard(['3> 3> 3> . .', '. . . . .', '. . 3> 3> .']);
  const game = { ...createGame(fixed([0]), DEFAULT_TUNING), board };
  const split = preview(game, 0).points,
    tail = preview(game, 12).points;
  const merged = preview(play(game, { kind: 'turn', index: 2 }, () => 0).game, 0).points;
  assert.equal(split, 1 + 2 + 3, '上排单独打是三连');
  assert.equal(tail, 1 + 2, '下排单独打是二连');
  assert.equal(merged, 1 + 2 + 3 + 4 + 5, '转向后应并成一条五连');
  assert.equal(merged - split - tail, 3 * 2, '合并收益应正好等于两段长度之积');
});

test('一次操作最多只能加热一枚低值计数器：生成分布能否让牌局收敛全靠这条', () => {
  // 进位一路消耗已备好的满格，撞到第一枚低值格就停下，所以欠热量每步至多降 1。
  const random = fixed([0.31, 0.77, 0.12, 0.58, 0.93, 0.44, 0.05, 0.69, 0.23, 0.86]);
  let game = createGame(random, DEFAULT_TUNING);
  for (let i = 0; i < 60 && !game.over; i++) {
    const index = game.board.findIndex(cell => cell);
    const before = heatDebt(game.board);
    const after = heatDebt(applyMove(game.board, { kind: 'bump', index }, SIZE).board);
    assert.ok(before - after <= 1, `第 ${i} 步一次加热了 ${before - after} 枚`);
    game = play(game, { kind: 'bump', index }, random).game;
  }
});

test('固定回合数结算，填满棋盘本身不算输', () => {
  const tuning = { ...DEFAULT_TUNING, turnLimit: 3 };
  let game = createGame(fixed([0.5]), tuning);
  for (let i = 0; i < 3; i++) {
    assert.equal(game.over, false, `第 ${i} 回合不该结束`);
    game = play(game, { kind: 'bump', index: game.board.findIndex(c => c) }, fixed([0.5])).game;
  }
  assert.equal(game.over, true);
  assert.equal(game.moves, 3);
  // 满盘而未操作时仍可继续：玩家还能点掉一枚腾出位置。
  const packed: Board = Array(SIZE * SIZE)
    .fill(null)
    .map((_, i): Counter => ({ id: i + 1, value: FULL - 1, dir: 1 }));
  const full = { ...createGame(fixed([0.5]), DEFAULT_TUNING), board: packed };
  assert.equal(full.over, false);
  assert.ok(play(full, { kind: 'bump', index: 0 }, fixed([0.5])).game.score > 0);
});

test('转向四次回到原位，且不改变数值与得分', () => {
  const board = makeBoard(['2> .. .. .. ..']);
  let game = { ...createGame(fixed([0]), DEFAULT_TUNING), board };
  const before = game.board[0]!.dir;
  for (let i = 0; i < 4; i++) game = play(game, { kind: 'turn', index: 0 }, () => 0).game;
  assert.equal(game.board[0]!.dir, before);
  assert.equal(game.board[0]!.value, 2);
  assert.equal(game.score, 0);
  assert.equal(rotate(rotate(rotate(rotate(0)))), 0);
});
