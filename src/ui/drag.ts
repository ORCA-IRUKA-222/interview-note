import { useEffect, useState } from 'preact/hooks';
import { descendantIds } from '../lib/model';
import { copyQuestionTree, getState, moveQuestion } from '../lib/store';
import type { MoveTarget } from '../lib/model';

/**
 * 質問のドラッグ&ドロップ（マウスもタッチも Pointer Events で共通に扱う）。
 * つかみ口(ハンドル)から始め、ドロップ先は DOM の data-drop 属性で判定する:
 *   data-drop="row"       data-qid data-iid  … 質問の行（上 30%=前に / 中央=子に / 下 30%=後ろに）
 *   data-drop="interview" data-iid           … 面接の行（その面接の末尾へ。Ctrl/Alt/⌘ でコピー）
 *   data-drop="tree-end"  data-iid           … 質問ツリーの末尾の余白
 */
export type DropPos = 'before' | 'inside' | 'after';

export type Over =
  | { kind: 'row'; qid: string; pos: DropPos }
  | { kind: 'interview'; iid: string }
  | { kind: 'tree-end'; iid: string }
  | null;

export interface DragState {
  id: string;
  text: string;
  x: number;
  y: number;
  /** Ctrl / Alt / ⌘ を押している間はコピー */
  copy: boolean;
  over: Over;
}

let drag: DragState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useDrag(): DragState | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return drag;
}

/** ドロップ位置から移動先を求める。置けない場所なら null */
export function resolveTarget(over: Over, draggedId: string): MoveTarget | null {
  if (!over) return null;
  const { questions } = getState().data;
  if (over.kind === 'interview' || over.kind === 'tree-end') {
    return { interviewId: over.iid, parentId: null, beforeId: null };
  }
  const row = questions.find((q) => q.id === over.qid);
  if (!row) return null;
  if (descendantIds(questions, draggedId).includes(row.id)) return null; // 自分自身・自分の子孫の上には置けない
  if (over.pos === 'inside') return { interviewId: row.interviewId, parentId: row.id, beforeId: null };
  if (over.pos === 'before') return { interviewId: row.interviewId, parentId: row.parentId, beforeId: row.id };
  // after: 同じ親の中で、この行（とその子孫）の次の兄弟の手前
  const sibs = questions
    .filter((q) => q.interviewId === row.interviewId && q.parentId === row.parentId && q.id !== draggedId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const i = sibs.findIndex((s) => s.id === row.id);
  return { interviewId: row.interviewId, parentId: row.parentId, beforeId: sibs[i + 1]?.id ?? null };
}

function overAt(x: number, y: number, draggedId: string): Over {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop]');
  if (!el) return null;
  const kind = el.dataset.drop;
  if (kind === 'row' && el.dataset.qid) {
    if (!resolveTarget({ kind: 'row', qid: el.dataset.qid, pos: 'inside' }, draggedId)) return null;
    const r = el.getBoundingClientRect();
    const ratio = (y - r.top) / Math.max(1, r.height);
    return { kind: 'row', qid: el.dataset.qid, pos: ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'inside' };
  }
  if (kind === 'interview' && el.dataset.iid) return { kind: 'interview', iid: el.dataset.iid };
  if (kind === 'tree-end' && el.dataset.iid) return { kind: 'tree-end', iid: el.dataset.iid };
  return null;
}

export function isDragging(): boolean {
  return drag !== null;
}

/** 長押しで持ち上げるまでの時間(ms)と、その間に指が動いてもよい距離(px)。動いたらスクロールとみなす */
const LONG_PRESS_MS = 380;
const TOUCH_SLOP = 10;
/** マウスは、これだけ動いたらドラッグ開始（クリックと区別する） */
const MOUSE_THRESHOLD = 5;

export interface PressOptions {
  /** true なら押した瞬間につかむ（つかみ口の「⋮⋮」用）。false なら、マウスは少し動かしたら／タッチは長押しでつかむ */
  immediate?: boolean;
}

/**
 * 質問の行・つかみ口の pointerdown から呼ぶ。
 *  - マウス: 行を押したまま少し動かすとドラッグ開始。動かさずに離せば通常のクリック
 *  - タッチ: 行を長押し（約 0.4 秒）で持ち上がる。その前に指が動けばスクロールとして扱う
 *  - つかみ口(immediate): 押した瞬間につかむ
 */
export function pressStart(e: PointerEvent, item: { id: string; text: string }, opts: PressOptions = {}) {
  if (drag) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const touch = e.pointerType !== 'mouse';
  const startX = e.clientX;
  const startY = e.clientY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raf = 0;
  let lifted = false;

  const lift = (x: number, y: number, ctrl: boolean) => {
    lifted = true;
    drag = { id: item.id, text: item.text, x, y, copy: ctrl, over: overAt(x, y, item.id) };
    document.body.classList.add('is-dragging');
    // 持ち上がったことを手応えで伝える（対応端末のみ）
    if (touch && !opts.immediate) navigator.vibrate?.(18);
    emit();
    raf = requestAnimationFrame(autoScroll);
  };

  const autoScroll = () => {
    if (!drag) return;
    const scroller = document.querySelector<HTMLElement>('.col-tree .col-body');
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const edge = 56;
      // スマホでは画面下に会社名のドロップ先の帯が出るので、スクロールの下端はその上端を基準にする
      // （帯の上にいるときは「会社へ落とす」操作なのでスクロールしない）
      const dockTop = document.querySelector('.drop-dock')?.getBoundingClientRect().top;
      const bottom = dockTop ?? r.bottom;
      if (drag.y < r.top + edge) scroller.scrollTop -= 14;
      else if (drag.y > bottom - edge && (dockTop === undefined || drag.y < dockTop)) scroller.scrollTop += 14;
      // スクロールした分だけドロップ先を取り直す
      const over = overAt(drag.x, drag.y, drag.id);
      if (JSON.stringify(over) !== JSON.stringify(drag.over)) {
        drag = { ...drag, over };
        emit();
      }
    }
    raf = requestAnimationFrame(autoScroll);
  };

  const cleanup = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    if (lifted) {
      drag = null;
      document.body.classList.remove('is-dragging');
      emit();
    }
  };

  function move(ev: PointerEvent) {
    const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
    if (!lifted) {
      if (touch) {
        // 長押しの前に動いた = スクロールしたいので、つかむのをやめる
        if (dist > TOUCH_SLOP) cleanup();
        return;
      }
      if (dist < MOUSE_THRESHOLD) return;
      lift(ev.clientX, ev.clientY, ev.ctrlKey || ev.altKey || ev.metaKey);
      return;
    }
    if (!drag) return;
    drag = { ...drag, x: ev.clientX, y: ev.clientY, copy: ev.ctrlKey || ev.altKey || ev.metaKey, over: overAt(ev.clientX, ev.clientY, drag.id) };
    emit();
  }

  function up(ev: PointerEvent) {
    const wasLifted = lifted;
    const current = drag;
    cleanup();
    if (!wasLifted || !current) return;
    // 離した操作そのものが出すクリック（pointerup の直後 ~数ms）だけを止め、リンクが開かないようにする。
    // 時刻で見分けるので、その後の正当なクリックは通る
    const upTime = ev.timeStamp;
    const stop = (c: Event) => {
      if (c.timeStamp - upTime > 30) return;
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener('click', stop, true);
    setTimeout(() => window.removeEventListener('click', stop, true), 80);

    const target = resolveTarget(overAt(ev.clientX, ev.clientY, current.id), current.id);
    if (!target) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) copyQuestionTree(current.id, target.interviewId, target.parentId, target.beforeId ?? null);
    else moveQuestion(current.id, target);
  }

  function cancel() {
    cleanup();
  }

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);

  if (opts.immediate) {
    e.preventDefault();
    lift(startX, startY, e.ctrlKey || e.altKey || e.metaKey);
  } else if (touch) {
    timer = setTimeout(() => lift(startX, startY, false), LONG_PRESS_MS);
  }
}

const guarded = new WeakSet<Element>();

/**
 * 質問ツリーの ref に渡す。ドラッグ中だけタッチの移動でページがスクロールしないようにする。
 * （touchmove を preventDefault できるのは「最初から非パッシブで登録されている」リスナーだけなので、
 *   ツリーの描画時に一度だけ登録しておく）
 */
export function guardTouchScroll(el: Element | null) {
  if (!el || guarded.has(el)) return;
  guarded.add(el);
  el.addEventListener(
    'touchmove',
    (e) => {
      if (isDragging() && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
}
