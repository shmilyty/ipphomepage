/* 「进位」的全部规则。纯函数、无 DOM，随机源与数值可注入，所以规则能脱离页面测试与调平衡。
   每枚计数器 = 一个数值 + 一个朝向。数值满 4 就溢出：计数器消失，沿朝向射出一次进位，
   进位穿过空格命中第一枚计数器并给它加一；若它也满了就继续溢出，于是形成连锁。
   一局固定回合数，目标是把有限的操作换成尽可能高的连锁分，而不是活得久。 */
export const FULL = 4;

/** 0=上 1=右 2=下 3=左，顺时针。转向就是 +1 取模。 */
export type Dir = 0 | 1 | 2 | 3;
export type Counter = { id: number; value: number; dir: Dir };
export type Board = (Counter | null)[];
export type Random = () => number;

/** 调平衡用的全部旋钮，集中在这里，模拟脚本可以直接扫。 */
export type Tuning = {
  size: number;
  seedCount: number;
  turnLimit: number;
  /** 新计数器的初始值池。池里满格(FULL-1)的比例决定连锁材料的多少，是最敏感的一个旋钮。 */
  spawnValues: readonly number[];
};
export const DEFAULT_TUNING: Tuning = { size: 5, seedCount: 8, turnLimit: 100, spawnValues: [2, 3] };

const STEP: Record<Dir, [number, number]> = { 0: [0, -1], 1: [1, 0], 2: [0, 1], 3: [-1, 0] };
export const rotate = (dir: Dir): Dir => ((dir + 1) % 4) as Dir;

/** 进位沿射线飞行，穿过空格，命中第一枚计数器；没撞上就飞出棋盘，连锁到此为止。
    射线是实时算的：连锁前段清掉的格子会让后段打得更远。 */
export function rayHit(board: Board, from: number, dir: Dir, size: number): number | null {
  const [dx, dy] = STEP[dir];
  let x = from % size,
    y = Math.floor(from / size);
  for (;;) {
    x += dx;
    y += dy;
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    const next = y * size + x;
    if (board[next]) return next;
  }
}

/** 动画按事件逐条回放，所以每个事件都要足以还原当时的棋盘变化。 */
export type GameEvent =
  | { type: 'bump'; index: number; value: number }
  | { type: 'burst'; index: number; dir: Dir; order: number }
  | { type: 'carry'; from: number; to: number | null; dir: Dir }
  | { type: 'spawn'; index: number; value: number; dir: Dir }
  | { type: 'turn'; index: number; dir: Dir }
  | { type: 'over' };

export type Game = {
  board: Board;
  score: number;
  clears: number;
  moves: number;
  chain: number; // 上一次操作打出的连锁长度
  longest: number;
  nextId: number;
  over: boolean;
  tuning: Tuning;
};
export type Move = { kind: 'bump' | 'turn'; index: number };

const clone = (board: Board): Board => board.map(cell => (cell ? { ...cell } : null));

function place(game: Game, random: Random, events: GameEvent[]): boolean {
  const empty: number[] = [];
  for (let i = 0; i < game.board.length; i++) if (!game.board[i]) empty.push(i);
  if (!empty.length) return false;
  const index = empty[Math.floor(random() * empty.length)];
  const value = game.tuning.spawnValues[Math.floor(random() * game.tuning.spawnValues.length)];
  const dir = Math.floor(random() * 4) as Dir;
  game.board[index] = { id: game.nextId++, value, dir };
  events.push({ type: 'spawn', index, value, dir });
  return true;
}

export function createGame(random: Random = Math.random, tuning: Tuning = DEFAULT_TUNING): Game {
  const game: Game = {
    board: Array(tuning.size * tuning.size).fill(null),
    score: 0,
    clears: 0,
    moves: 0,
    chain: 0,
    longest: 0,
    nextId: 1,
    over: false,
    tuning
  };
  for (let i = 0; i < tuning.seedCount; i++) place(game, random, []);
  return game;
}

/** 从 index 起结算一次连锁。溢出会移除计数器且至多射出一次进位，所以链长必然收敛。 */
function cascade(board: Board, index: number, size: number, events: GameEvent[] | null) {
  let order = 0,
    points = 0,
    cursor: number | null = index;
  const path: number[] = [];
  while (cursor !== null) {
    const counter = board[cursor];
    if (!counter || counter.value < FULL) break;
    order++;
    points += order; // 连锁中第 n 次溢出得 n 分
    path.push(cursor);
    const { dir } = counter;
    events?.push({ type: 'burst', index: cursor, dir, order });
    board[cursor] = null;
    const target = rayHit(board, cursor, dir, size);
    events?.push({ type: 'carry', from: cursor, to: target, dir });
    if (target === null) break;
    const hit = board[target]!;
    hit.value++;
    events?.push({ type: 'bump', index: target, value: hit.value });
    cursor = target;
  }
  return { order, points, path };
}

/** 加一之后会打出什么，先算给玩家看。连锁本身没有分支，所以预览是精确的，不是估计。 */
export function preview(game: Game, index: number): { order: number; points: number; path: number[] } {
  const counter = game.board[index];
  if (!counter || game.over) return { order: 0, points: 0, path: [] };
  const board = clone(game.board);
  board[index]!.value++;
  return cascade(board, index, game.tuning.size, null);
}

/** 只结算操作本身，不补充新计数器。搜索与预览走这条路，避免把随机生成算进推演。 */
export function applyMove(board: Board, move: Move, size: number, events: GameEvent[] | null = null) {
  const next = clone(board);
  const target = next[move.index];
  if (!target) return { board: next, order: 0, points: 0 };
  if (move.kind === 'turn') {
    target.dir = rotate(target.dir);
    events?.push({ type: 'turn', index: move.index, dir: target.dir });
    return { board: next, order: 0, points: 0 };
  }
  target.value++;
  events?.push({ type: 'bump', index: move.index, value: target.value });
  const { order, points } = cascade(next, move.index, size, events);
  return { board: next, order, points };
}

/** 走一步棋：返回新局面和一串供回放的事件。原局面不被修改。 */
export function play(game: Game, move: Move, random: Random = Math.random): { game: Game; events: GameEvent[] } {
  const events: GameEvent[] = [];
  if (game.over || !game.board[move.index]) return { game, events };
  const result = applyMove(game.board, move, game.tuning.size, events);
  const next: Game = { ...game, board: result.board, moves: game.moves + 1, chain: result.order };
  next.score += result.points;
  next.clears += result.order;
  next.longest = Math.max(next.longest, result.order);
  // 死亡判定：填满棋盘不算输，操作之后仍然满、放不下新计数器才算。
  if (!place(next, random, events)) {
    next.over = true;
    events.push({ type: 'over' });
  } else if (next.moves >= next.tuning.turnLimit) {
    next.over = true;
    events.push({ type: 'over' });
  }
  return { game: next, events };
}

/** U = Σ(3−数值)：把全场加热到满格还差多少次加一。一次操作最多只能加热一枚低值计数器，
    所以这个量是判断「生成分布会不会让局面无限续下去」的硬指标，见 tests/carry.test.ts。 */
export const heatDebt = (board: Board) => board.reduce((sum, cell) => sum + (cell ? FULL - 1 - cell.value : 0), 0);

/** 可复现的随机源（mulberry32）。同一个种子重开会得到完全相同的一局，
    所以玩家可以把一次失误重打一遍，而不是只能接受运气。 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
