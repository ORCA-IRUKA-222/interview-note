import { useEffect, useRef } from 'preact/hooks';
import { altLabel } from '../lib/model';
import { addAlternative, promoteAlternative, removeAlternative, updateAlternative } from '../lib/store';
import type { Question } from '../types';
import { AutoTextarea } from './common';
import { paths } from './router';

/**
 * サブの回答（別案）。任意の項目なので、1 つもないときは小さな「＋ 追加」ボタンだけを出す。
 * 追加すると、名前（任意）と本文をいくつでも持てる。メインと入れ替えたり、複製して書き換えたりできる。
 */
export function Alternatives({ q, onNotice }: { q: Question; onNotice(message: string): void }) {
  const alts = q.alternatives;
  const count = useRef(alts.length);
  const box = useRef<HTMLDivElement | null>(null);

  // 追加した直後は、その本文の欄にカーソルを置く
  useEffect(() => {
    if (alts.length > count.current) {
      const fields = box.current?.querySelectorAll<HTMLTextAreaElement>('.alt-text');
      const last = fields?.[fields.length - 1];
      last?.focus();
      last?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    count.current = alts.length;
  }, [alts.length]);

  const hasMain = q.answer.trim().length > 0;

  if (alts.length === 0) {
    return (
      <div class="alt-empty">
        <button type="button" class="btn small" onClick={() => addAlternative(q.id)}>
          ＋ サブの回答を追加（任意）
        </button>
        <span class="muted small">同じ案ばかりにならないよう、別の切り口の回答も用意できます</span>
      </div>
    );
  }

  const promote = (id: string) => {
    const hasMarks = q.marks.length + q.links.length > 0;
    const msg =
      'このサブの回答をメインにします。いまのメインの回答は、サブへ移ります。' +
      (hasMarks || q.alternatives.length ? '\n\nメインに付けた深掘り・リンク・内容タグの箇所は、新しいメインの文の中で見つからないものが「外れた」扱いになります（あとから付け直せます）。' : '');
    if (!confirm(msg)) return;
    if (promoteAlternative(q.id, id)) onNotice('メインの回答と入れ替えました');
  };

  return (
    <section class="alts" ref={box} aria-label="サブの回答">
      <div class="section-head">
        <h3>
          サブの回答 <span class="count">{alts.length}</span>
        </h3>
        <span class="muted small">別の切り口の案（任意）</span>
      </div>

      {alts.map((a, i) => (
        <div class="alt-card" key={a.id}>
          <div class="alt-head">
            <input
              class="alt-label"
              value={a.label}
              placeholder={`名前（例: 数字で語る版）。空なら「サブ ${i + 1}」`}
              aria-label={`${altLabel(a, i)} の名前`}
              onInput={(e) => updateAlternative(q.id, a.id, { label: (e.target as HTMLInputElement).value })}
            />
            <span class="muted small alt-count">
              {a.text.length} 字{a.text.trim() && ` ・ 約 ${Math.max(1, Math.round(a.text.length / 5))} 秒`}
            </span>
          </div>
          <AutoTextarea
            class="alt-text"
            minRows={4}
            value={a.text}
            placeholder="別の切り口で回答を書く（例: 数字で語る・エピソードから入る・結論を先に言う）"
            aria-label={`${altLabel(a, i)} の本文`}
            onInput={(e) => updateAlternative(q.id, a.id, { text: (e.target as HTMLTextAreaElement).value })}
          />
          <div class="alt-actions">
            <button type="button" class="btn small" disabled={!a.text.trim()} onClick={() => promote(a.id)} title="このサブの回答をメインにして、いまのメインをサブへ移す">
              メインと入れ替える
            </button>
            <button type="button" class="btn small" disabled={!a.text.trim()} onClick={() => addAlternative(q.id, { label: a.label ? `${a.label}（複製）` : '', text: a.text })}>
              複製
            </button>
            <a class={`btn small ${a.text.trim() ? '' : 'disabled'}`} href={a.text.trim() ? paths.karaoke(q.id, `alt:${a.id}`) : undefined} aria-disabled={!a.text.trim()}>
              🎤 カラオケ
            </a>
            <button
              type="button"
              class="btn small danger"
              onClick={() => {
                if (a.text.trim() && !confirm(`「${altLabel(a, i)}」を削除しますか？`)) return;
                removeAlternative(q.id, a.id);
              }}
            >
              削除
            </button>
          </div>
        </div>
      ))}

      <div class="alt-add">
        <button type="button" class="btn small" onClick={() => addAlternative(q.id)}>
          ＋ サブの回答を追加
        </button>
        <button type="button" class="btn small" disabled={!hasMain} onClick={() => addAlternative(q.id, { label: 'メインの複製', text: q.answer })} title="いまのメインの回答を複製して、書き換えて別案にする">
          ＋ メインを複製して追加
        </button>
      </div>
    </section>
  );
}
