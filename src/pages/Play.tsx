import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, RotateCw, Trophy, Undo2, Zap } from 'lucide-react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  DEFAULT_TUNING,
  FULL,
  createGame,
  play,
  preview,
  seededRandom,
  type Board,
  type Dir,
  type Game,
  type GameEvent,
  type Move
} from '../game/carry';

const SIZE = DEFAULT_TUNING.size;
const BEST_KEY = 'ipp.carry.best.v1';
/** 事件回放的节奏。连锁的乐趣全在这几十毫秒里，所以每种事件单独给时长。 */
const BEAT: Record<GameEvent['type'], number> = { bump: 80, burst: 95, carry: 110, spawn: 40, turn: 110, over: 0 };
/** 连锁越接越快，像一串倒下的多米诺。同时也保证十几环的长链不会把输入卡住两秒。 */
const tempo = (order: number) => Math.max(0.3, 0.86 ** order);
const DIR_LABEL = ['上', '右', '下', '左'];

type Best = { score: number; chain: number };
const readBest = (): Best => {
  try {
    const raw = JSON.parse(localStorage.getItem(BEST_KEY) || '');
    return { score: Number(raw?.score) || 0, chain: Number(raw?.chain) || 0 };
  } catch {
    return { score: 0, chain: 0 };
  }
};
/** 无痕模式下写不进去是正常的，不该让游戏跟着崩掉。 */
const writeBest = (best: Best) => {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(best));
  } catch {
    /* ignore */
  }
};

const cloneBoard = (board: Board): Board => board.map(cell => (cell ? { ...cell } : null));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const center = (index: number) => ({
  x: ((index % SIZE) + 0.5) * (100 / SIZE),
  y: (Math.floor(index / SIZE) + 0.5) * (100 / SIZE)
});
/** 进位飞出棋盘时没有落点，让火花飞到界外，玩家才看得出这一击浪费掉了。 */
function endPoint(from: number, to: number | null, dir: Dir) {
  if (to !== null) return center(to);
  const step = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0]
  ][dir];
  const start = center(from);
  return { x: start.x + step[0] * 130, y: start.y + step[1] * 130 };
}

const Face = ({ value, dir }: { value: number; dir: Dir }) => (
  <>
    <span className="counter-value">{value}</span>
    <span className="counter-arrow" style={{ '--dir': dir } as CSSProperties} aria-hidden="true" />
  </>
);

/** 规则里最难讲清的一条：先加热再引爆，回合数一样，分数更高。直接摆出来给玩家看。 */
function HeatExample() {
  const cells: { value: number; dir: Dir }[] = [
    { value: 3, dir: 1 },
    { value: 2, dir: 1 },
    { value: 3, dir: 2 }
  ];
  const lines = [
    {
      label: '见满就点',
      steps: ['点左边这枚：它溢出，进位只把中间加热到 3，链就断了。', '再点中间：清掉剩下两枚。'],
      total: '1 + 3 = 4 分'
    },
    {
      label: '先加热',
      steps: ['先点中间那枚 2，把它填到 3。这一步一分不得。', '再点左边：三枚接成一条连锁。'],
      total: '0 + 6 = 6 分'
    }
  ];
  return (
    <div className="heat-example">
      <div className="example-board" aria-hidden="true">
        {cells.map((cell, i) => (
          <span key={i} className={`counter is-static ${cell.value === FULL - 1 ? 'is-full' : ''}`}>
            <Face value={cell.value} dir={cell.dir} />
          </span>
        ))}
      </div>
      <div className="example-lines">
        {lines.map(line => (
          <div key={line.label}>
            <strong>{line.label}</strong>
            <ol>
              {line.steps.map(step => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <span className="example-total">{line.total}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 允许用 ?seed= 指定牌局：同一个种子永远是同一局，便于复盘、分享和端到端测试。 */
const initialSeed = () => {
  const asked = Number(new URLSearchParams(location.search).get('seed'));
  return Number.isInteger(asked) && asked > 0 ? asked : Math.floor(Math.random() * 2 ** 31);
};

export function Play() {
  const [seed, setSeed] = useState(initialSeed);
  const random = useRef(seededRandom(seed));
  const [game, setGame] = useState<Game>(() => createGame(random.current));
  const [board, setBoard] = useState<Board>(game.board); // 回放中的棋盘；结算后与 game.board 一致
  const [score, setScore] = useState(0);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const [spark, setSpark] = useState<{ from: number; to: number | null; dir: Dir; ms: number; key: number } | null>(
    null
  );
  const [flash, setFlash] = useState<{ index: number; order: number; key: number } | null>(null);
  const [best, setBest] = useState<Best>({ score: 0, chain: 0 });
  const [announce, setAnnounce] = useState('');
  const run = useRef(0); // 回放批次号：重开时让还在跑的那一批自己停下
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false); // 长按转向后，随之而来的 click 不该再发射一次
  const hovered = useRef<number | null>(null); // 指针停在哪一格，结算后要照旧瞄回去
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  // localStorage 在服务端渲染与无痕模式下都可能读不到，所以挂载后再取。
  useEffect(() => setBest(readBest()), []);
  useEffect(
    () => () => {
      run.current++;
      clearTimeout(press.current);
    },
    []
  );

  const restart = useCallback((nextSeed: number) => {
    run.current++;
    const source = seededRandom(nextSeed);
    random.current = source;
    const fresh = createGame(source);
    setSeed(nextSeed);
    setGame(fresh);
    setBoard(fresh.board);
    setScore(0);
    setArmed(null);
    setCursor(0);
    setSpark(null);
    setFlash(null);
    setBusy(false);
    setAnnounce('');
  }, []);

  /** 逐条回放事件，让连锁一环一环地发生；关掉动效时直接落到结果。 */
  const replay = useCallback(
    async (events: GameEvent[], next: Game) => {
      const token = ++run.current;
      setBusy(true);
      setArmed(null);
      const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const live = cloneBoard(game.board);
      let shown = game.score,
        step = 0;
      for (const event of events) {
        if (event.type === 'bump') {
          const cell = live[event.index];
          if (cell) cell.value = event.value;
        }
        if (event.type === 'burst') {
          live[event.index] = null;
          shown += event.order;
          step = event.order;
          setFlash({ index: event.index, order: event.order, key: token * 1000 + event.order });
        }
        if (event.type === 'carry')
          setSpark({
            from: event.from,
            to: event.to,
            dir: event.dir,
            ms: BEAT.carry * tempo(step),
            key: token * 1000 + event.from
          });
        if (event.type === 'spawn')
          live[event.index] = { id: next.nextId + event.index, value: event.value, dir: event.dir };
        if (event.type === 'turn') {
          const cell = live[event.index];
          if (cell) cell.dir = event.dir;
        }
        if (quick) continue;
        setBoard(cloneBoard(live));
        setScore(shown);
        await sleep(BEAT[event.type] * tempo(step));
        if (run.current !== token) return; // 期间重开了，这一批作废
      }
      setBoard(next.board);
      setScore(next.score);
      setSpark(null);
      setGame(next);
      setBusy(false);
      // 结算后重新瞄准指针或键盘焦点所在的格子，否则鼠标不动时下一次点击只会「再瞄一次」。
      // 触屏没有 hover，也不会有焦点，于是保持未瞄准状态，仍然是「先看后打」两步。
      const focused = cells.current.findIndex(node => node && node === document.activeElement);
      setArmed(hovered.current ?? (focused >= 0 ? focused : null));
      if (next.chain > 1) setAnnounce(`连锁 ${next.chain} 环，得 ${next.score - game.score} 分`);
      if (next.over) {
        const record = { score: Math.max(best.score, next.score), chain: Math.max(best.chain, next.longest) };
        setBest(record);
        writeBest(record);
        setAnnounce(`本局结束，${next.score} 分，最长连锁 ${next.longest} 环`);
      }
    },
    [game, best]
  );

  const move = useCallback(
    (kind: Move['kind'], index: number) => {
      if (busy || game.over || !game.board[index]) return;
      const result = play(game, { kind, index }, random.current);
      void replay(result.events, result.game);
    },
    [busy, game, replay]
  );

  // 悬停即预览，点击已预览的格子才发射：鼠标上仍是一次点击，触屏上自然变成「先看后打」。
  const fire = (index: number) => {
    if (armed === index) move('bump', index);
    else {
      setArmed(index);
      setCursor(index);
    }
  };

  const shown = useMemo(
    () => (armed !== null && !busy && !game.over ? preview(game, armed) : null),
    [armed, busy, game]
  );
  const pathOrder = useMemo(() => {
    const map = new Map<number, number>();
    shown?.path.forEach((cell, i) => map.set(cell, i + 1));
    return map;
  }, [shown]);

  function onKeyDown(event: ReactKeyboardEvent) {
    const step: Record<string, number> = { ArrowUp: -SIZE, ArrowDown: SIZE, ArrowLeft: -1, ArrowRight: 1 };
    if (event.key in step) {
      event.preventDefault();
      const edge =
        (event.key === 'ArrowLeft' && cursor % SIZE === 0) ||
        (event.key === 'ArrowRight' && cursor % SIZE === SIZE - 1);
      const target = cursor + step[event.key];
      if (edge || target < 0 || target >= SIZE * SIZE) return;
      setCursor(target);
      setArmed(target);
      cells.current[target]?.focus();
    }
    if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      move('turn', cursor);
    }
  }

  // 长按转向只给触摸和笔用；鼠标有右键和角标按钮，不需要等 450ms。
  const holdStart = (index: number) => (event: ReactPointerEvent) => {
    held.current = false;
    if (event.pointerType === 'mouse') return;
    press.current = setTimeout(() => {
      held.current = true;
      move('turn', index);
    }, 450);
  };
  const holdEnd = () => clearTimeout(press.current);

  const turns = game.tuning.turnLimit;
  const bestScore = Math.max(best.score, score);
  return (
    <div className="page narrow play-page">
      <div className="breadcrumb">
        <Link to="/">首页</Link>
        <ChevronRight size={16} />
        进位
      </div>
      <header className="play-hero">
        <h1>进位</h1>
        <p>计数器满 4 就溢出，沿箭头把进位送给下一枚。一局 {turns} 回合，把有限的操作换成尽量长的连锁。</p>
      </header>

      <div className="play-hud">
        <div>
          <strong>{score}</strong>
          <span>分数</span>
        </div>
        <div>
          <strong>
            {Math.min(game.moves, turns)}
            <i>/{turns}</i>
          </strong>
          <span>回合</span>
        </div>
        <div>
          <strong>{game.longest}</strong>
          <span>最长连锁</span>
        </div>
        <div className="hud-best">
          <strong>{bestScore}</strong>
          <span>
            <Trophy size={12} aria-hidden="true" />
            最高分
          </span>
        </div>
      </div>

      <div className="play-stage">
        <div className={`play-board ${busy ? 'is-busy' : ''}`} onKeyDown={onKeyDown}>
          {board.map((cell, index) => {
            const order = pathOrder.get(index);
            return (
              <div key={index} className={`cell ${order ? 'is-path' : ''} ${armed === index ? 'is-armed' : ''}`}>
                {cell && (
                  <>
                    <button
                      ref={node => {
                        cells.current[index] = node;
                      }}
                      type="button"
                      className={`counter ${cell.value === FULL - 1 ? 'is-full' : ''}`}
                      tabIndex={index === cursor ? 0 : -1}
                      aria-label={`第 ${Math.floor(index / SIZE) + 1} 行第 ${(index % SIZE) + 1} 列，计数 ${cell.value}，朝${DIR_LABEL[cell.dir]}${order ? `，是连锁的第 ${order} 环` : ''}`}
                      onPointerEnter={event => {
                        if (event.pointerType !== 'mouse') return;
                        hovered.current = index;
                        if (!busy) {
                          setArmed(index);
                          setCursor(index);
                        }
                      }}
                      onFocus={() => {
                        if (!busy) {
                          setArmed(index);
                          setCursor(index);
                        }
                      }}
                      onClick={() => {
                        if (!held.current) fire(index);
                      }}
                      onContextMenu={event => {
                        event.preventDefault();
                        move('turn', index);
                      }}
                      onPointerDown={holdStart(index)}
                      onPointerUp={holdEnd}
                      onPointerCancel={holdEnd}
                      onPointerLeave={() => {
                        holdEnd();
                        if (hovered.current === index) hovered.current = null;
                      }}
                    >
                      <Face value={cell.value} dir={cell.dir} />
                      {order ? (
                        <span className="path-order" aria-hidden="true">
                          {order}
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="rotate-badge"
                      tabIndex={-1}
                      aria-label={`转向这枚计数器，当前朝${DIR_LABEL[cell.dir]}`}
                      onClick={() => move('turn', index)}
                    >
                      <RotateCw size={13} />
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {spark && (
            <span
              key={spark.key}
              className="carry-spark"
              aria-hidden="true"
              style={
                {
                  '--from-x': `${center(spark.from).x}%`,
                  '--from-y': `${center(spark.from).y}%`,
                  '--to-x': `${endPoint(spark.from, spark.to, spark.dir).x}%`,
                  '--to-y': `${endPoint(spark.from, spark.to, spark.dir).y}%`,
                  '--fly': `${spark.ms}ms`
                } as CSSProperties
              }
            />
          )}
          {flash && (
            <span
              key={flash.key}
              className="burst-score"
              aria-hidden="true"
              style={{ '--at-x': `${center(flash.index).x}%`, '--at-y': `${center(flash.index).y}%` } as CSSProperties}
            >
              +{flash.order}
            </span>
          )}
          {game.over && (
            <div className="play-over">
              <p className="eyebrow muted">本局结束</p>
              <strong>{game.score}</strong>
              <p>
                最长连锁 {game.longest} 环{game.score > 0 && game.score >= best.score ? ' · 新纪录' : ''}
              </p>
              <p className="over-seed">种子 {seed}</p>
              <div className="over-actions">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => restart(Math.floor(Math.random() * 2 ** 31))}
                >
                  再来一局 <Zap size={17} aria-hidden="true" />
                </button>
                <button type="button" className="text-link" onClick={() => restart(seed)}>
                  <Undo2 size={16} aria-hidden="true" />
                  重开这一局
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="play-side">
          <div className={`preview-card ${shown?.order ? 'has-chain' : ''}`}>
            {shown?.order ? (
              <>
                <strong>+{shown.points}</strong>
                <span>连锁 {shown.order} 环</span>
              </>
            ) : (
              <>
                <strong>·</strong>
                <span>{game.over ? '本局已结束' : armed !== null ? '这一步不会溢出' : '指向一枚计数器看结果'}</span>
              </>
            )}
          </div>
          <p className="play-hint">
            <b>加一</b>　点一下计数器。满 4 就溢出，沿箭头射出进位，穿过空格命中第一枚。
            <br />
            <b>转向</b>　点角上的 <RotateCw size={12} aria-hidden="true" /> 按钮或按 <kbd>R</kbd>
            ，右键与长按同样可以。箭头只能顺时针转。
            <br />
            <b>计分</b>　一次连锁里第 n 次溢出得 n 分，所以接得越长越划算。
          </p>
          <p className="play-hint muted">
            键盘：方向键移动，<kbd>Enter</kbd> 加一，<kbd>R</kbd> 转向。转向和加热都要花掉一整个回合。
          </p>
        </aside>
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      <section className="play-lesson" aria-labelledby="play-lesson-title">
        <h2 id="play-lesson-title">同样两回合，先加热多得两分</h2>
        <p>
          转向和加热都要花掉一整个回合，还会照常落下新计数器。所以这局问的不是「哪一步最长」，而是「什么时候准备、什么时候兑现」。
        </p>
        <HeatExample />
      </section>
    </div>
  );
}
