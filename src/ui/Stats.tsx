import { useMemo, useState } from 'preact/hooks';
import { COMMON_ID, interviewName } from '../lib/model';
import { computeShare } from '../lib/stats';
import { useAppState } from '../lib/store';
import { tagLine } from './common';
import { paths, replace } from './router';

const pct = (r: number) => `${(r * 100).toFixed(r > 0 && r < 0.1 ? 1 : 0)}%`;

/** 回答の内容が、タグごとにどれだけを占めているか */
export function Stats({ iid }: { iid?: string }) {
  const { data } = useAppState();
  // 範囲の選択は画面の状態として持ち、URL にも反映する（replace なので履歴は増やさない）
  const [selected, setSelected] = useState(iid ?? '');
  const scoped = selected && data.interviews.some((i) => i.id === selected) ? selected : '';
  const questions = useMemo(
    () => (scoped ? data.questions.filter((q) => q.interviewId === scoped) : data.questions),
    [data.questions, scoped],
  );
  const r = useMemo(() => computeShare(questions), [questions]);
  const byId = new Map(data.questions.map((q) => [q.id, q]));
  const tagged = r.total - r.untagged;
  const interviews = [...data.interviews].sort((a, b) => (a.id === COMMON_ID ? -1 : b.id === COMMON_ID ? 1 : 0));

  return (
    <main class="page stats">
      <div class="page-head">
        <a class="btn back" href={paths.home}>
          ← ホーム
        </a>
        <h2 class="grow">内容の占有率</h2>
      </div>

      <label class="scope-select">
        集計する範囲
        <select value={scoped} onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value;
            setSelected(next);
            replace(paths.stats(next || undefined));
          }}>
          <option value="">すべての面接</option>
          {interviews.map((i) => (
            <option value={i.id} key={i.id}>
              {i.kind === 'common' ? '📌 共通' : interviewName(i, '(無題の面接)')}
            </option>
          ))}
        </select>
      </label>

      {r.total === 0 ? (
        <div class="empty">
          <p>集計できる回答がまだありません。</p>
          <p class="muted">回答を書いて、文章の一部を選び「タグを付ける」で内容（自己PR・志望動機など）を付けると、ここに割合が出ます。</p>
        </div>
      ) : (
        <>
          <p class="stats-summary">
            回答 <strong>{r.questions}</strong> 件・<strong>{r.total.toLocaleString('ja-JP')}</strong> 文字のうち、
            タグを付けた部分は <strong>{pct(tagged / r.total)}</strong> です。
          </p>

          {r.tags.length === 0 ? (
            <div class="empty">
              <p>まだタグが付いていません。</p>
              <p class="muted">質問の詳細で回答の文字を選び、「タグを付ける」を押してください。「段落に広げる」で段落ごと付けられます。</p>
            </div>
          ) : (
            <ul class="share-list">
              {r.tags.map((t) => (
                <li key={t.tag}>
                  <details>
                    <summary>
                      <span class="share-label">#{t.tag}</span>
                      <span class="share-bar" role="img" aria-label={`${t.tag} は ${pct(t.ratio)}`}>
                        <span style={{ width: `${Math.max(1, t.ratio * 100)}%`, background: tagLine(t.tag) }} />
                      </span>
                      <span class="share-val">
                        {pct(t.ratio)}
                        <small>{t.chars.toLocaleString('ja-JP')} 字</small>
                      </span>
                    </summary>
                    <ul class="passages">
                      {t.passages.map((p, i) => {
                        const q = byId.get(p.questionId);
                        return (
                          <li key={i}>
                            <span class="mark-quote">「{p.quote.length > 70 ? `${p.quote.slice(0, 70)}…` : p.quote}」</span>
                            {q && (
                              <a class="muted small" href={paths.question(q.interviewId, q.id)}>
                                {q.text || '(質問未入力)'}
                              </a>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                </li>
              ))}
              <li class="share-untagged">
                <div class="share-row">
                  <span class="share-label">未分類</span>
                  <span class="share-bar" role="img" aria-label={`未分類は ${pct(r.untagged / r.total)}`}>
                    <span style={{ width: `${Math.max(1, (r.untagged / r.total) * 100)}%` }} />
                  </span>
                  <span class="share-val">
                    {pct(r.untagged / r.total)}
                    <small>{r.untagged.toLocaleString('ja-JP')} 字</small>
                  </span>
                </div>
              </li>
            </ul>
          )}
          <p class="muted small">
            割合は、回答の総文字数（空白・改行を除く）に対するものです。同じ文に複数のタグを付けた場合はそれぞれに数えるので、合計が 100% を超えることがあります。
            タグの行をタップすると、該当する文章の一覧が開きます。
          </p>
        </>
      )}
    </main>
  );
}
