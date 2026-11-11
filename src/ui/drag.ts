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

/** ハンドルの pointerdown から呼ぶ。以降の移動・離す操作は window で拾う */
export function beginDrag(e: PointerEvent, item: { id: string; text: string }) {
  if (e.button !== undefined && e.button > 0) return;
  e.preventDefault();
  drag = { id: item.id, text: item.text, x: e.clientX, y: e.clientY, copy: e.ctrlKey || e.altKey || e.metaKey, over: null };
  document.body.classList.add('is-dragging');
  emit();

  let raf = 0;
  const autoScroll = () => {
    if (!drag) return;
    const scroller = document.querySelector<HTMLElement>('.col-tree .col-body');
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const edge = 56;
      if (drag.y < r.top + edge) scroller.scrollTop -= 14;
      else if (drag.y > r.bottom - edge) scroller.scrollTop += 14;
      // スクロールした分だけドロップ先を取り直す
      const over = overAt(drag.x, drag.y, drag.id);
      if (JSON.stringify(over) !== JSON.stringify(drag.over)) {
        drag = { ...drag, over };
        emit();
      }
    }
    raf = requestAnimationFrame(autoScroll);
  };
  raf = requestAnimationFrame(autoScroll);

  const move = (ev: PointerEvent) => {
    if (!drag) return;
    drag = { ...drag, x: ev.clientX, y: ev.clientY, copy: ev.ctrlKey || ev.altKey || ev.metaKey, over: overAt(ev.clientX, ev.clientY, drag.id) };
    emit();
  };

  const finish = (ev: PointerEvent, commit: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    cancelAnimationFrame(raf);
    const current = drag;
    drag = null;
    document.body.classList.remove('is-dragging');
    emit();
    if (!commit || !current) return;
    const target = resolveTarget(overAt(ev.clientX, ev.clientY, current.id), current.id);
    if (!target) return;
    const copy = ev.ctrlKey || ev.altKey || ev.metaKey;
    if (copy) copyQuestionTree(current.id, target.interviewId, target.parentId, target.beforeId ?? null);
    else moveQuestion(current.id, target);
  };
  const up = (ev: PointerEvent) => finish(ev, true);
  const cancel = (ev: PointerEvent) => finish(ev, false);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
}
