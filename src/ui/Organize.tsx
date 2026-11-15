import { useEffect, useRef, useState } from 'preact/hooks';
import { COMMON_ID, descendantIds, flattenTree, interviewName } from '../lib/model';
import {
  copyQuestionTree,
  getState,
  moveQuestion,
  nudgeQuestion,
  pasteClipboard,
  setClipboard,
  useAppState,
} from '../lib/store';
import type { Question } from '../types';
import { useDrag } from './drag';
import { go, paths } from './router';

const ellipsis = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n)}…` : s || '(質問未入力)');

/** ドラッグ中に指に付いてくる表示。画面が狭く会社の一覧が見えないときは、下に会社名のドロップ先を出す */
export function DragLayer() {
  const drag = useDrag();
  const { data } = useAppState();
  if (!drag) return null;
  const narrow = window.innerWidth < 900;
  const interviews = [...data.interviews].sort((a, b) => (a.id === COMMON_ID ? -1 : b.id === COMMON_ID ? 1 : 0));
  return (
    <>
      {narrow && (
        <div class="drop-dock" aria-hidden="true">
          <span class="dock-label">ここに落とすと別の面接へ移動</span>
          <div class="dock-chips">
            {interviews.map((i) => (
              <span
                key={i.id}
                data-drop="interview"
                data-iid={i.id}
                class={`dock-chip ${drag.over?.kind === 'interview' && drag.over.iid === i.id ? 'drop-into' : ''}`}
              >
                {i.kind === 'common' ? '📌 共通' : interviewName(i, '(無題)')}
              </span>
            ))}
          </div>
        </div>
      )}
      <div class="drag-ghost" style={{ left: `${drag.x + 12}px`, top: `${drag.y - 44}px` }} aria-hidden="true">
        {drag.copy && <span class="ghost-copy">＋コピー</span>}
        {ellipsis(drag.text)}
      </div>
    </>
  );
}

/** コピー/切り取り中の質問を示し、この面接の末尾に貼り付ける */
export function ClipboardBar({ iid }: { iid: string }) {
  const { clipboard, data } = useAppState();
  if (!clipboard) return null;
  const q = data.questions.find((x) => x.id === clipboard.id);
  if (!q) return null;
  return (
    <div class="clip-bar" role="status">
      <span class="clip-text">
        📋 {clipboard.mode === 'cut' ? '切り取り中' : 'コピー中'}: 「{ellipsis(q.text, 22)}」
      </span>
      <button
        type="button"
        class="btn primary"
        onClick={() => {
          const id = pasteClipboard({ interviewId: iid, parentId: null });
          if (id) go(paths.question(iid, id));
        }}
      >
        この面接に貼り付け
      </button>
      <button type="button" class="btn" aria-label="貼り付け待ちを取り消す" onClick={() => setClipboard(null)}>
        ✕
      </button>
    </div>
  );
}

/** 別の面接（や別の質問の下）へ移動/コピーするダイアログ。スマホではドラッグの代わりにこれを使う */
export function MoveDialog({ q, onClose }: { q: Question; onClose(): void }) {
  const { data } = useAppState();
  const [iid, setIid] = useState(q.interviewId);
  const [parentId, setParentId] = useState<string>(q.parentId && iid === q.interviewId ? q.parentId : '');
  const exclude = new Set(descendantIds(data.questions, q.id));
  const rows = flattenTree(data.questions, iid).filter((r) => !exclude.has(r.question.id));
  const interviews = [...data.interviews].sort((a, b) => (a.id === COMMON_ID ? -1 : b.id === COMMON_ID ? 1 : 0));

  const run = (copy: boolean) => {
    const target = { interviewId: iid, parentId: parentId || null, beforeId: null };
    let id = q.id;
    if (copy) id = copyQuestionTree(q.id, iid, target.parentId, null);
    else if (!moveQuestion(q.id, target)) return;
    onClose();
    go(paths.question(iid, id));
  };

  return (
    <div class="modal-back" role="dialog" aria-modal="true" aria-label="別の場所へ移動またはコピー" onClick={onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>「{ellipsis(q.text, 24)}」を…</h3>
        <label>
          移動・コピー先の面接
          <select
            value={iid}
            onChange={(e) => {
              setIid((e.target as HTMLSelectElement).value);
              setParentId('');
            }}
          >
            {interviews.map((i) => (
              <option value={i.id} key={i.id}>
                {i.kind === 'common' ? '📌 共通' : interviewName(i, '(無題の面接)')}
              </option>
            ))}
          </select>
        </label>
        <label>
          その中の位置
          <select value={parentId} onChange={(e) => setParentId((e.target as HTMLSelectElement).value)}>
            <option value="">面接の直下（末尾）</option>
            {rows.map(({ question: r, depth }) => (
              <option value={r.id} key={r.id}>
                {'　'.repeat(depth)}└ {ellipsis(r.text, 22)} の下（深掘りとして）
              </option>
            ))}
          </select>
        </label>
        <p class="muted small">
          深掘りも一緒に動きます。別の質問の下へ入れると、元の回答への引用(ハイライト)は外れます。
        </p>
        <div class="form-actions">
          <button type="button" class="btn primary" onClick={() => run(false)}>
            移動
          </button>
          <button type="button" class="btn" onClick={() => run(true)}>
            コピー
          </button>
          <button type="button" class="btn" onClick={onClose}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}

/** 質問の行の「⋯」メニュー（並べ替え・コピー・切り取り・貼り付け・移動） */
export function RowMenu({ q }: { q: Question }) {
  const { clipboard } = useAppState();
  const [pos, setPos] = useState<{ top: number; right: number; up: boolean } | null>(null);
  const [moving, setMoving] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => {
      if ((e.target as HTMLElement).closest?.('.row-menu')) return;
      setPos(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('scroll', close, true);
    };
  }, [pos]);

  const open = () => {
    const r = btnRef.current!.getBoundingClientRect();
    const up = r.bottom + 280 > window.innerHeight;
    setPos({ top: up ? r.top : r.bottom, right: Math.max(8, window.innerWidth - r.right), up });
  };

  const sibs = getState().data.questions.filter((x) => x.interviewId === q.interviewId && x.parentId === q.parentId);
  const sorted = [...sibs].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  const idx = sorted.findIndex((x) => x.id === q.id);
  const next = sorted[idx + 1];
  const canPaste = !!clipboard && clipboard.id !== q.id && !descendantIds(getState().data.questions, clipboard.id).includes(q.id) ;
  const act = (fn: () => void) => () => {
    setPos(null);
    fn();
  };

  return (
    <>
      <button ref={btnRef} type="button" class="icon-btn row-menu-btn" aria-label="この質問のメニュー" aria-haspopup="menu" onClick={open}>
        ⋯
      </button>
      {pos && (
        <div class="row-menu" role="menu" style={{ right: `${pos.right}px`, ...(pos.up ? { bottom: `${window.innerHeight - pos.top}px` } : { top: `${pos.top}px` }) }}>
          <button type="button" role="menuitem" disabled={idx <= 0} onClick={act(() => void nudgeQuestion(q.id, -1))}>
            ↑ 1 つ上へ
          </button>
          <button type="button" role="menuitem" disabled={idx < 0 || idx >= sorted.length - 1} onClick={act(() => void nudgeQuestion(q.id, 1))}>
            ↓ 1 つ下へ
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={act(() => setClipboard({ id: q.id, mode: 'copy' }))}>
            コピー
          </button>
          <button type="button" role="menuitem" onClick={act(() => setClipboard({ id: q.id, mode: 'cut' }))}>
            切り取り
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canPaste}
            onClick={act(() => void pasteClipboard({ interviewId: q.interviewId, parentId: q.parentId, beforeId: next?.id ?? null }))}
          >
            ここ（この下）に貼り付け
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canPaste}
            onClick={act(() => void pasteClipboard({ interviewId: q.interviewId, parentId: q.id, beforeId: null }))}
          >
            深掘りとして貼り付け
          </button>
          <hr />
          <button type="button" role="menuitem" onClick={act(() => setMoving(true))}>
            別の面接へ移動・コピー…
          </button>
        </div>
      )}
      {moving && <MoveDialog q={q} onClose={() => setMoving(false)} />}
    </>
  );
}
