import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  allTags,
  ancestorsOf,
  backlinksTo,
  childrenOf,
  expandToParagraph,
  interviewName,
  makeAnchor,
  normalizeTag,
  questionTrail,
  suggestLinkTargets,
} from '../lib/model';
import { search } from '../lib/search';
import { addLink, addMark, addQuestion, deleteQuestion, removeLink, removeMark, updateQuestion, useAppState } from '../lib/store';
import type { Question } from '../types';
import { AutoTextarea, selectionOffsets, ShareBar, StatusDot, STATUS_LABEL, tagLine, tagTint, TagEditor } from './common';
import { shareOfQuestion } from '../lib/stats';
import { go, paths } from './router';

interface Selection {
  start: number;
  end: number;
}

/** 回答の範囲から行ける先（深掘りの質問か、リンク先の質問） */
interface Target {
  id: string;
  kind: 'dive' | 'link';
}

/**
 * 回答テキストを描画する。範囲に付けたものは、種類ごとに表現を分けて重なっても見分けられるようにする:
 *   内容タグ    … 色の塗り
 *   深掘り      … 黒い点線の下線 + 末尾の「Q」
 *   リンク      … 青い実線の下線 + 末尾の「→」
 * タップすると行き先へ移動する（行き先が複数あるときは選ぶ）。
 * （選択位置の計算のため、このコンテナの textContent は回答テキストと一致させる）
 */
function AnswerView(props: {
  text: string;
  anchors: { id: string; start: number; end: number }[];
  links: { id: string; start: number; end: number; targetId: string }[];
  marks: { id: string; start: number; end: number; tag: string }[];
  containerRef: { current: HTMLDivElement | null };
  onOpen(targets: Target[]): void;
}) {
  const { text, anchors, links, marks } = props;
  const parts = useMemo(() => {
    const cuts = new Set<number>([0, text.length]);
    const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
    for (const a of [...anchors, ...links, ...marks]) {
      cuts.add(clamp(a.start));
      cuts.add(clamp(a.end));
    }
    const sorted = [...cuts].sort((x, y) => x - y);
    const out: { from: number; to: number; targets: Target[]; tags: string[]; diveEnd: boolean; linkEnd: boolean }[] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i];
      const to = sorted[i + 1];
      const covers = (r: { start: number; end: number }) => r.start <= from && r.end >= to;
      out.push({
        from,
        to,
        targets: [
          ...anchors.filter(covers).map((a): Target => ({ id: a.id, kind: 'dive' })),
          ...links.filter(covers).map((l): Target => ({ id: l.targetId, kind: 'link' })),
        ],
        tags: [...new Set(marks.filter(covers).map((m) => m.tag))],
        // 範囲の最後の部分に印を付ける
        diveEnd: anchors.some((a) => clamp(a.end) === to && a.start < to),
        linkEnd: links.some((l) => clamp(l.end) === to && l.start < to),
      });
    }
    return out;
  }, [text, anchors, links, marks]);

  return (
    <div class="answer-view" ref={props.containerRef}>
      {parts.map((p) => {
        // 内容タグ = 色の塗り（複数なら上下に帯状に分ける）
        const n = p.tags.length;
        const style = n
          ? {
              background:
                n === 1
                  ? tagTint(p.tags[0])
                  : `linear-gradient(to bottom, ${p.tags.map((t, i) => `${tagTint(t)} ${(i * 100) / n}% ${((i + 1) * 100) / n}%`).join(', ')})`,
            }
          : undefined;
        const hasDive = p.targets.some((t) => t.kind === 'dive');
        const hasLink = p.targets.some((t) => t.kind === 'link');
        const cls = [n ? 'tagged' : '', hasDive ? 'hl' : '', hasLink ? 'lnk' : '', p.diveEnd ? 'dive-end' : '', p.linkEnd ? 'link-end' : '']
          .filter(Boolean)
          .join(' ');
        if (!p.targets.length) {
          return (
            <span key={p.from} class={cls} style={style} title={n ? p.tags.map((t) => `#${t}`).join(' ') : undefined}>
              {text.slice(p.from, p.to)}
            </span>
          );
        }
        return (
          <mark
            key={p.from}
            class={cls}
            style={style}
            title={hasLink && !hasDive ? 'リンク先の質問へ移動' : hasDive && !hasLink ? 'この部分への深掘り質問を開く' : 'つながっている質問を開く'}
            onClick={() => {
              // 範囲選択の操作中は移動しない
              if (window.getSelection()?.isCollapsed === false) return;
              props.onOpen(p.targets);
            }}
          >
            {text.slice(p.from, p.to)}
          </mark>
        );
      })}
    </div>
  );
}

/** 質問の所在つきの 1 行（リンク先の候補・リンク元・行き先の選択で共通） */
function QuestionLine({ q, kind }: { q: Question; kind?: string }) {
  const { data } = useAppState();
  const trail = questionTrail(data, q);
  return (
    <span class="qline">
      <span class="qline-trail">{trail.join(' ▸ ')}</span>
      <span class="qline-text">
        {kind && <span class="qline-kind">{kind}</span>}
        {q.text || '(質問未入力)'}
      </span>
    </span>
  );
}

const BAR_TAB_KEY = 'iqa.bartab';
const readTab = (): 'ask' | 'tag' => {
  try {
    return localStorage.getItem(BAR_TAB_KEY) === 'tag' ? 'tag' : 'ask';
  } catch {
    return 'ask';
  }
};

/**
 * 選択範囲に対する操作バー。操作が増えても迷わないよう、入口は 2 つだけにしている:
 *   「質問につなぐ」… 入力欄に打った文で新しい深掘りを作る、または既存の質問を選んでリンクする（候補は自動で出る）
 *   「タグ」       … 内容タグを付ける
 */
function SelectionBar(props: {
  quote: string;
  currentId: string;
  tags: string[];
  onDive(text: string): void;
  onLink(targetId: string): void;
  onTag(tag: string, wholeParagraph: boolean): void;
  onCancel(): void;
  barRef: { current: HTMLDivElement | null };
}) {
  const { data } = useAppState();
  const [tab, setTab] = useState<'ask' | 'tag'>(readTab);
  const [text, setText] = useState('');
  const [tagDraft, setTagDraft] = useState('');
  const [para, setPara] = useState(false);
  const switchTab = (t: 'ask' | 'tag') => {
    setTab(t);
    try {
      localStorage.setItem(BAR_TAB_KEY, t);
    } catch {
      /* 記憶できなくても動く */
    }
  };

  // 候補: 何か打っていればその検索結果、空なら「選んだ文に近い質問」
  const typed = text.trim();
  const candidates = useMemo(() => {
    if (typed) return search(data, typed).map((h) => h.question).filter((x) => x.id !== props.currentId).slice(0, 8);
    return suggestLinkTargets(data, props.quote, props.currentId);
  }, [data, typed, props.quote, props.currentId]);

  const addTag = (raw: string) => {
    const t = normalizeTag(raw);
    if (t) props.onTag(t, para);
  };

  return (
    <div
      class="deep-bar"
      ref={props.barRef}
      role="region"
      aria-label="選択範囲の操作"
      // ボタンを押しても選択が外れないようにする（入力欄は除く）
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest('input')) e.preventDefault();
      }}
    >
      <div class="deep-quote">
        <span class="muted">選択中</span> 「{props.quote.length > 60 ? `${props.quote.slice(0, 60)}…` : props.quote}」
        <button type="button" class="icon-btn bar-close" aria-label="選択を閉じる" onClick={props.onCancel}>
          ✕
        </button>
      </div>
      <div class="seg bar-tabs">
        <button type="button" class={tab === 'ask' ? 'on' : ''} onClick={() => switchTab('ask')}>
          質問につなぐ
        </button>
        <button type="button" class={tab === 'tag' ? 'on' : ''} onClick={() => switchTab('tag')}>
          タグ
        </button>
      </div>
      {tab === 'ask' ? (
        <div class="ask-pane">
          <form
            class="deep-form"
            onSubmit={(e) => {
              e.preventDefault();
              props.onDive(typed);
            }}
          >
            <input
              value={text}
              placeholder="新しい深掘りの質問、または既存の質問を検索"
              enterkeyhint="done"
              aria-label="深掘り質問の文、または既存の質問の検索語"
              onInput={(e) => setText((e.target as HTMLInputElement).value)}
            />
          </form>
          <ul class="cand-list">
            <li>
              <button type="button" class="cand cand-new" onClick={() => props.onDive(typed)}>
                <span class="cand-plus">＋</span>
                <span class="cand-main">{typed ? `「${typed}」を新しい深掘り質問にする` : '新しい深掘り質問を作る'}</span>
              </button>
            </li>
            {candidates.length > 0 && (
              <li class="cand-head muted small">{typed ? '既存の質問（タップでリンク）' : '選んだ文に近い既存の質問（タップでリンク）'}</li>
            )}
            {candidates.map((c) => (
              <li key={c.id}>
                <button type="button" class="cand" onClick={() => props.onLink(c.id)}>
                  <span class="cand-main">
                    <QuestionLine q={c} kind={c.parentId ? '深掘り' : 'トップ'} />
                  </span>
                  <span class="cand-go">リンク →</span>
                </button>
              </li>
            ))}
            {typed && candidates.length === 0 && <li class="cand-head muted small">一致する既存の質問はありません。</li>}
          </ul>
        </div>
      ) : (
        <div class="tag-pick">
          <label class="check small">
            <input type="checkbox" checked={para} onChange={(e) => setPara((e.target as HTMLInputElement).checked)} />
            段落（改行まで）に広げて付ける
          </label>
          <div class="tags">
            {props.tags.map((t) => (
              <button
                type="button"
                class="chip tagchip"
                key={t}
                style={{ borderColor: tagLine(t), background: tagTint(t) }}
                onClick={() => addTag(t)}
              >
                #{t}
              </button>
            ))}
          </div>
          <form
            class="deep-form"
            onSubmit={(e) => {
              e.preventDefault();
              addTag(tagDraft);
            }}
          >
            <input
              value={tagDraft}
              placeholder="新しいタグ（例: 自己PR・志望動機・ガクチカ）"
              enterkeyhint="done"
              onInput={(e) => setTagDraft((e.target as HTMLInputElement).value)}
            />
            <button type="submit" class="btn primary" disabled={!normalizeTag(tagDraft)}>
              付ける
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** 行き先が複数あるとき（深掘りとリンクが重なった範囲など）に選ぶ */
function TargetPicker(props: { targets: Target[]; onPick(t: Target): void; onClose(): void }) {
  const { data } = useAppState();
  return (
    <div class="modal-back" role="dialog" aria-modal="true" aria-label="移動先を選ぶ" onClick={props.onClose}>
      <div class="modal" onClick={(e) => e.stopPropagation()}>
        <h3>どこへ移動しますか？</h3>
        <ul class="cand-list">
          {props.targets.map((t) => {
            const q = data.questions.find((x) => x.id === t.id);
            if (!q) return null;
            return (
              <li key={`${t.kind}-${t.id}`}>
                <button type="button" class="cand" onClick={() => props.onPick(t)}>
                  <span class="cand-main">
                    <QuestionLine q={q} kind={t.kind === 'dive' ? '深掘り' : 'リンク'} />
                  </span>
                  <span class="cand-go">開く →</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div class="form-actions">
          <button type="button" class="btn" onClick={props.onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function QuestionDetail({ iid, qid, from }: { iid: string; qid: string; from?: string }) {
  const { data } = useAppState();
  const q = data.questions.find((x) => x.id === qid);
  const [mode, setMode] = useState<'view' | 'edit'>(() => (q && q.answer ? 'view' : 'edit'));
  const [sel, setSel] = useState<Selection | null>(null);
  const [picker, setPicker] = useState<Target[] | null>(null);
  const [notice, setNotice] = useState('');
  const answerRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  // 操作結果の短い知らせ（数秒で消える）
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 2800);
    return () => clearTimeout(t);
  }, [notice]);

  // 閲覧モードの範囲選択を監視する（スマホの長押し選択も selectionchange で拾える）
  useEffect(() => {
    if (mode !== 'view') return;
    const onChange = () => {
      const container = answerRef.current;
      if (!container) return;
      // 深掘り入力欄にフォーカスがある間は、選択が解除されても保持する
      if (barRef.current?.contains(document.activeElement)) return;
      const next = selectionOffsets(container);
      clearTimeout(hideTimer.current);
      if (next) setSel(next);
      else hideTimer.current = setTimeout(() => setSel(null), 250);
    };
    document.addEventListener('selectionchange', onChange);
    // 切り替え直後にすでに選択されていた場合も拾う
    onChange();
    return () => {
      document.removeEventListener('selectionchange', onChange);
      clearTimeout(hideTimer.current);
    };
  }, [mode]);

  if (!q) {
    return (
      <section class="col col-detail">
        <header class="col-head">
          <a class="btn back" href={paths.interview(iid)}>
            ← 質問一覧
          </a>
        </header>
        <div class="col-body">
          <div class="empty">この質問は見つかりません（別の端末で削除された可能性があります）。</div>
        </div>
      </section>
    );
  }

  const interview = data.interviews.find((i) => i.id === q.interviewId);
  const ancestors = ancestorsOf(data.questions, q.id);
  const children = childrenOf(data.questions, q.interviewId, q.id);
  const anchors = children
    .filter((c): c is Question & { anchor: NonNullable<Question['anchor']> } => !!c.anchor && !c.anchor.broken)
    .map((c) => ({ id: c.id, start: c.anchor.start, end: c.anchor.end }));
  const byId = new Map(data.questions.map((x) => [x.id, x]));
  const links = q.links.filter((l) => !l.broken && byId.has(l.targetId));
  const backlinks = backlinksTo(data.questions, q.id);
  const fromQuestion = from && from !== q.id ? byId.get(from) : undefined;
  const tags = allTags(data.questions).map((t) => t.tag);
  const patch = (p: Partial<Question>) => updateQuestion(q.id, p);

  const quoteFor = (s: Selection) => makeAnchor(q.answer, s.start, s.end);
  const anchor = sel ? quoteFor(sel) : null;

  const share = shareOfQuestion(q);
  const tagPool = [...new Set([...tags, ...data.questions.flatMap((x) => x.marks.map((m) => m.tag))])];
  const applyTag = (tag: string, wholeParagraph: boolean) => {
    if (!sel) return;
    const range = wholeParagraph ? expandToParagraph(q.answer, sel.start, sel.end) : sel;
    addMark(q.id, range, tag);
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  const openTarget = (t: Target) => {
    setPicker(null);
    const tq = byId.get(t.id);
    if (!tq) return;
    // リンクをたどったときは、元の質問へ戻る印を付ける
    go(t.kind === 'link' ? paths.question(tq.interviewId, tq.id, q.id) : paths.question(tq.interviewId, tq.id));
  };
  const openTargets = (targets: Target[]) => {
    const valid = targets.filter((t) => byId.has(t.id));
    if (valid.length === 1) openTarget(valid[0]);
    else if (valid.length > 1) setPicker(valid);
  };

  const applyLink = (targetId: string) => {
    if (!sel) return;
    const target = byId.get(targetId);
    if (addLink(q.id, sel, targetId)) setNotice(`リンクしました →「${target?.text || '(質問未入力)'}」`);
    else setNotice('すでに同じ範囲から同じ質問へリンクしています');
    window.getSelection()?.removeAllRanges();
    setSel(null);
  };

  const createDeepDive = (text: string) => {
    if (!anchor) return;
    const id = addQuestion(q.interviewId, { text, parentId: q.id, anchor });
    window.getSelection()?.removeAllRanges();
    setSel(null);
    go(paths.question(q.interviewId, id));
  };

  const remove = () => {
    const n = children.length;
    const msg = n ? `この質問と、その深掘り質問 ${n} 件以上を削除しますか？` : 'この質問を削除しますか？';
    if (!confirm(msg)) return;
    deleteQuestion(q.id);
    go(q.parentId ? paths.question(q.interviewId, q.parentId) : paths.interview(q.interviewId));
  };

  const fromTextarea = () => {
    const el = textRef.current;
    if (!el || el.selectionStart === el.selectionEnd) return setSel(null);
    setSel({ start: el.selectionStart, end: el.selectionEnd });
  };

  const backHref = q.parentId ? paths.question(q.interviewId, q.parentId) : paths.interview(q.interviewId);

  return (
    <section class="col col-detail" aria-label="質問の詳細">
      <header class="col-head">
        <a class="btn back" href={paths.interview(iid)}>
          ← 質問一覧
        </a>
        <span class="grow muted crumb-company">{interview ? (interview.kind === 'common' ? '📌 共通' : interviewName(interview, '')) : ''}</span>
        <a class={`btn ${q.answer.trim() ? '' : 'disabled'}`} href={q.answer.trim() ? paths.karaoke(q.id) : undefined} aria-disabled={!q.answer.trim()}>
          🎤 カラオケ
        </a>
      </header>

      <div class="col-body detail-body">
        {fromQuestion && (
          <a class="from-chip" href={paths.question(fromQuestion.interviewId, fromQuestion.id)}>
            ↩ 「{fromQuestion.text || '(質問未入力)'}」に戻る
          </a>
        )}
        {ancestors.length > 0 && (
          <nav class="crumbs" aria-label="深掘りの経路">
            {ancestors.map((a, idx) => {
              const child = idx + 1 < ancestors.length ? ancestors[idx + 1] : q;
              return (
                <span class="crumb" key={a.id}>
                  <a href={paths.question(a.interviewId, a.id)}>{a.text || '(質問未入力)'}</a>
                  {child.anchor && <span class="crumb-quote">「{child.anchor.quote}」</span>}
                  <span class="muted"> ↳ </span>
                </span>
              );
            })}
          </nav>
        )}

        <AutoTextarea
          class="q-text"
          value={q.text}
          minRows={1}
          placeholder="質問を入力"
          aria-label="質問"
          onInput={(e) => patch({ text: (e.target as HTMLTextAreaElement).value })}
        />

        <div class="meta-row">
          <label class="inline">
            <StatusDot status={q.status} />
            <select
              aria-label="状態"
              value={q.status}
              onChange={(e) => patch({ status: (e.target as HTMLSelectElement).value as Question['status'] })}
            >
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option value={v} key={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <TagEditor tags={q.tags} suggestions={tags} onChange={(t) => patch({ tags: t })} />
        </div>

        <div class="section-head">
          <h3>回答</h3>
          <div class="seg">
            <button type="button" class={mode === 'view' ? 'on' : ''} onClick={() => setMode('view')}>
              選択して深掘り
            </button>
            <button type="button" class={mode === 'edit' ? 'on' : ''} onClick={() => (setSel(null), setMode('edit'))}>
              編集
            </button>
          </div>
        </div>

        {mode === 'edit' ? (
          <>
            <AutoTextarea
              class="answer-edit"
              minRows={6}
              value={q.answer}
              placeholder="回答を書く。書いたあと「選択して深掘り」に切り替え、文字を選ぶとそこから深掘り質問を作れます"
              aria-label="回答"
              onInput={(e) => (setSel(null), patch({ answer: (e.target as HTMLTextAreaElement).value }))}
              onSelect={(e) => {
                textRef.current = e.target as HTMLTextAreaElement;
                fromTextarea();
              }}
            />
            {q.answer.trim() && <p class="hint muted">{q.answer.length} 字 ・ 目安の話す時間 約 {Math.max(1, Math.round(q.answer.length / 5))} 秒</p>}
          </>
        ) : q.answer ? (
          <>
            <AnswerView
              text={q.answer}
              anchors={anchors}
              links={links}
              marks={q.marks.filter((m) => !m.broken)}
              containerRef={answerRef}
              onOpen={openTargets}
            />
            <p class="hint muted">
              文字をなぞって選ぶと、そこから深掘り質問を作ったり、既存の質問へリンクしたり、内容タグ（自己PR・志望動機など）を付けたりできます。色の塗りは内容タグ、黒い点線と「Q」は深掘り質問、青い下線と「→」はほかの質問へのリンクです（タップで移動）。
              
            </p>
          </>
        ) : (
          <p class="muted">回答がまだありません。「編集」から書き始めましょう。</p>
        )}

        {(q.links.length > 0 || backlinks.length > 0) && (
          <div class="links-block">
            {q.links.length > 0 && (
              <>
                <div class="section-head">
                  <h3>
                    リンク <span class="count">{q.links.length}</span>
                  </h3>
                  <span class="muted small">この回答から、ほかの質問へ</span>
                </div>
                <ul class="link-list">
                  {q.links.map((l) => {
                    const target = byId.get(l.targetId);
                    const ok = !!target && !l.broken;
                    return (
                      <li key={l.id}>
                        <span class="mark-quote">
                          「{l.quote.length > 40 ? `${l.quote.slice(0, 40)}…` : l.quote}」
                          {l.broken && <span class="warn">（回答から消えました）</span>}
                          {!target && <span class="warn">（リンク先の質問がありません）</span>}
                        </span>
                        {ok && target ? (
                          <a class="link-go" href={paths.question(target.interviewId, target.id, q.id)}>
                            <QuestionLine q={target} kind={target.parentId ? '深掘り' : 'トップ'} />
                          </a>
                        ) : (
                          <span class="muted small">移動できません</span>
                        )}
                        <button type="button" class="icon-btn" aria-label="このリンクを外す" onClick={() => removeLink(q.id, l.id)}>
                          ✕
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {backlinks.length > 0 && (
              <>
                <div class="section-head">
                  <h3>
                    この質問を参照している箇所 <span class="count">{backlinks.length}</span>
                  </h3>
                </div>
                <ul class="link-list">
                  {backlinks.map(({ question: src, link }) => (
                    <li key={link.id}>
                      <span class="mark-quote">「{link.quote.length > 40 ? `${link.quote.slice(0, 40)}…` : link.quote}」</span>
                      <a class="link-go" href={paths.question(src.interviewId, src.id)}>
                        <QuestionLine q={src} kind={src.parentId ? '深掘り' : 'トップ'} />
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {q.marks.length > 0 && (
          <div class="marks-list">
            <div class="section-head">
              <h3>内容タグ <span class="count">{q.marks.length}</span></h3>
              <a class="muted small" href={paths.stats(q.interviewId)}>
                質問ごとの一覧 →
              </a>
            </div>
            {share && (
              <div class="share-here">
                <p class="small muted">この回答の内訳（回答 {share.total.toLocaleString('ja-JP')} 字に対する割合）</p>
                <ShareBar share={share} />
              </div>
            )}
            <ul>
              {q.marks.map((m) => (
                <li key={m.id}>
                  <span class="chip tagchip" style={{ borderColor: tagLine(m.tag), background: tagTint(m.tag) }}>
                    #{m.tag}
                  </span>
                  <span class={`mark-quote ${m.broken ? 'broken' : ''}`}>
                    「{m.quote.length > 44 ? `${m.quote.slice(0, 44)}…` : m.quote}」{m.broken && '（回答から消えました）'}
                  </span>
                  <button type="button" class="icon-btn" aria-label={`${m.tag} のタグを外す`} onClick={() => removeMark(q.id, m.id)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div class="section-head">
          <h3>話す要点</h3>
          <span class="muted small">単語帳の裏面に出ます</span>
        </div>
        <AutoTextarea
          class="points-edit"
          minRows={3}
          value={q.keyPoints}
          placeholder={'1 行 1 項目。例:\n結論: 御社のAI事業に貢献したい\n理由: 大学で画像認識を研究\n具体例: ゼミ長として5人をまとめた'}
          aria-label="話す要点"
          onInput={(e) => patch({ keyPoints: (e.target as HTMLTextAreaElement).value })}
        />

        <div class="section-head">
          <h3>深掘り質問 {children.length > 0 && <span class="count">{children.length}</span>}</h3>
          <button
            type="button"
            class="btn"
            onClick={() => {
              const id = addQuestion(q.interviewId, { parentId: q.id });
              go(paths.question(q.interviewId, id));
            }}
          >
            ＋ 箇所を選ばず追加
          </button>
        </div>
        {children.length === 0 ? (
          <p class="muted">まだありません。</p>
        ) : (
          <ul class="children">
            {children.map((c) => (
              <li key={c.id}>
                <a class="row" href={paths.question(c.interviewId, c.id)}>
                  <StatusDot status={c.status} />
                  <span class="child-main">
                    {c.anchor && (
                      <span class={`quote ${c.anchor.broken ? 'broken' : ''}`}>
                        「{c.anchor.quote.length > 40 ? `${c.anchor.quote.slice(0, 40)}…` : c.anchor.quote}」
                        {c.anchor.broken && '（回答から消えました）'}
                      </span>
                    )}
                    <span>{c.text || '(質問未入力)'}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <div class="danger-zone">
          <a class="btn" href={backHref}>
            {q.parentId ? '↑ 親の質問へ' : '↑ 質問一覧へ'}
          </a>
          <button type="button" class="btn danger" onClick={remove}>
            この質問を削除
          </button>
        </div>
      </div>

      {anchor && (
        <SelectionBar
          quote={anchor.quote}
          currentId={q.id}
          tags={tagPool}
          barRef={barRef}
          onDive={createDeepDive}
          onLink={applyLink}
          onTag={applyTag}
          onCancel={() => (window.getSelection()?.removeAllRanges(), setSel(null))}
        />
      )}
      {picker && <TargetPicker targets={picker} onPick={openTarget} onClose={() => setPicker(null)} />}
      {notice && (
        <div class="toast" role="status">
          {notice}
        </div>
      )}
    </section>
  );
}
