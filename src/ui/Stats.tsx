import { useMemo, useState } from 'preact/hooks';
import { COMMON_ID, flattenTree, interviewName } from '../lib/model';
import { shareOfQuestion, type QuestionShare } from '../lib/stats';
import { useAppState } from '../lib/store';
import type { Interview, Question } from '../types';
import { ShareBar } from './common';
import { paths, replace } from './router';

interface Item {
  question: Question;
  interview: Interview;
  share: QuestionShare;
}

/** 質問ごとに、回答の内容がタグ別にどれだけを占めるか（分母はその質問の回答） */
export function Stats({ iid }: { iid?: string }) {
  const { data } = useAppState();
  const [selected, setSelected] = useState(iid ?? '');
  const [tag, setTag] = useState('');
  const [onlyTagged, setOnlyTagged] = useState(true);
  const scoped = selected && data.interviews.some((i) => i.id === selected) ? selected : '';

  const interviews = useMemo(
    () => [...data.interviews].sort((a, b) => (a.id === COMMON_ID ? -1 : b.id === COMMON_ID ? 1 : 0)),
    [data.interviews],
  );

  // 面接の中の並び順（ツリーの順）で、回答のある質問の占有率を求める
  const all = useMemo(() => {
    const items: Item[] = [];
    for (const interview of interviews) {
      if (scoped && interview.id !== scoped) continue;
      for (const { question } of flattenTree(data.questions, interview.id)) {
        const share = shareOfQuestion(question);
        if (share) items.push({ question, interview, share });
      }
    }
    return items;
  }, [interviews, data.questions, scoped]);

  const taggedCount = all.filter((i) => i.share.tags.length > 0).length;
  const tagNames = useMemo(() => [...new Set(all.flatMap((i) => i.share.tags.map((t) => t.tag)))].sort((a, b) => a.localeCompare(b, 'ja')), [all]);
  const activeTag = tagNames.includes(tag) ? tag : '';

  let items = onlyTagged ? all.filter((i) => i.share.tags.length > 0) : all;
  if (activeTag) {
    // 選んだタグの割合が高い質問から並べる
    const ratioOf = (i: Item) => i.share.tags.find((t) => t.tag === activeTag)?.ratio ?? 0;
    items = items.filter((i) => ratioOf(i) > 0).sort((a, b) => ratioOf(b) - ratioOf(a));
  }

  const groups: { interview: Interview; items: Item[] }[] = [];
  if (activeTag) groups.push({ interview: interviews[0], items });
  else for (const interview of interviews) {
    const own = items.filter((i) => i.interview.id === interview.id);
    if (own.length) groups.push({ interview, items: own });
  }

  return (
    <main class="page stats">
      <div class="page-head">
        <a class="btn back" href={paths.home}>
          ← ホーム
        </a>
        <h2 class="grow">質問ごとの内容の占有率</h2>
      </div>

      <div class="filters">
        <label>
          範囲
          <select
            value={scoped}
            onChange={(e) => {
              const next = (e.target as HTMLSelectElement).value;
              setSelected(next);
              replace(paths.stats(next || undefined));
            }}
          >
            <option value="">すべての面接</option>
            {interviews.map((i) => (
              <option value={i.id} key={i.id}>
                {i.kind === 'common' ? '📌 共通' : interviewName(i, '(無題の面接)')}
              </option>
            ))}
          </select>
        </label>
        <label>
          このタグが多い順に並べる
          <select value={activeTag} onChange={(e) => setTag((e.target as HTMLSelectElement).value)}>
            <option value="">指定しない（質問の順）</option>
            {tagNames.map((t) => (
              <option value={t} key={t}>
                #{t}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={onlyTagged} onChange={(e) => setOnlyTagged((e.target as HTMLInputElement).checked)} />
          タグを付けた質問だけ
        </label>
      </div>

      {all.length === 0 ? (
        <div class="empty">
          <p>集計できる回答がまだありません。</p>
          <p class="muted">回答を書いて、文章の一部を選び「タグを付ける」で内容（自己PR・志望動機など）を付けると、質問ごとの割合が出ます。</p>
        </div>
      ) : (
        <>
          <p class="stats-summary">
            回答のある質問 <strong>{all.length}</strong> 件のうち、タグを付けた質問は <strong>{taggedCount}</strong> 件です。
          </p>
          {groups.length === 0 ? (
            <div class="empty">
              <p>表示する質問がありません。</p>
              <p class="muted">「タグを付けた質問だけ」を外すか、質問の詳細で回答の文字を選んで「タグを付ける」を押してください。</p>
            </div>
          ) : (
            groups.map(({ interview, items: list }) => (
              <section class="stats-group" key={interview.id + (activeTag ? '-tag' : '')}>
                {!activeTag && (
                  <h3 class="group-title">{interview.kind === 'common' ? '📌 共通' : interviewName(interview, '(無題の面接)')}</h3>
                )}
                <ul class="q-share-list">
                  {list.map(({ question, interview: iv, share }) => (
                    <li key={question.id}>
                      <a class="q-share-title" href={paths.question(question.interviewId, question.id)}>
                        {question.parentId && <span class="branch" aria-hidden="true">↳ </span>}
                        {question.text || '(質問未入力)'}
                        {activeTag && <span class="muted small"> — {iv.kind === 'common' ? '共通' : interviewName(iv, '')}</span>}
                      </a>
                      <ShareBar share={share} highlight={activeTag || undefined} />
                      <p class="small muted">回答 {share.total.toLocaleString('ja-JP')} 字</p>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          <p class="muted small">
            割合は、その質問の回答の文字数（空白・改行を除く）に対するものです。同じ文字に複数のタグが重なったときは、範囲が短い（細かく付けた）タグを優先して 1 つにだけ数えるので、タグと未分類の合計は 100% になります。
          </p>
        </>
      )}
    </main>
  );
}
