import type { Question } from '../types';

export interface TagRatio {
  tag: string;
  /** そのタグに数えた文字数（空白・改行を除く） */
  chars: number;
  /** その質問の回答の総文字数に対する割合 (0..1) */
  ratio: number;
}

/** 1 つの質問の回答について、内容がどのタグでどれだけを占めるか */
export interface QuestionShare {
  questionId: string;
  /** 回答の総文字数（空白・改行を除く） */
  total: number;
  /** どのタグにも当たらない文字数 */
  untagged: number;
  /** 割合の大きい順。tags の割合と untagged の割合を合わせると 100% */
  tags: TagRatio[];
}

const isSpace = (ch: string) => /\s/.test(ch);

/**
 * 1 つの質問の回答を、タグごとの占有率に分解する（分母はその質問の回答の文字数）。
 *
 * 1 文字は 1 つのタグにだけ数える。範囲が重なったら、範囲が短い（より細かく付けた）タグを優先し、
 * 同じ長さなら後から付けたタグを優先する。そのため、タグの割合と未分類の割合の合計は必ず 100% になる。
 * 回答が空（空白のみ含む）なら null。
 */
export function shareOfQuestion(q: Question): QuestionShare | null {
  const units = q.answer.split(''); // マーク位置は UTF-16 のオフセット
  const owner: (string | null)[] = new Array(units.length).fill(null);

  const marks = q.marks
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => !m.broken && m.end > m.start)
    // 長いものを先に塗り、短いもの・後から付けたものを上書きさせる
    .sort((a, b) => b.m.end - b.m.start - (a.m.end - a.m.start) || a.index - b.index);
  for (const { m } of marks) {
    for (let i = Math.max(0, m.start); i < Math.min(units.length, m.end); i++) owner[i] = m.tag;
  }

  let total = 0;
  let untagged = 0;
  const perTag = new Map<string, number>();
  for (let i = 0; i < units.length; i++) {
    if (isSpace(units[i])) continue;
    total++;
    const tag = owner[i];
    if (tag === null) untagged++;
    else perTag.set(tag, (perTag.get(tag) ?? 0) + 1);
  }
  if (total === 0) return null;

  const tags = [...perTag.entries()]
    .map(([tag, chars]) => ({ tag, chars, ratio: chars / total }))
    .sort((a, b) => b.chars - a.chars || a.tag.localeCompare(b.tag, 'ja'));
  return { questionId: q.id, total, untagged, tags };
}

/** 回答のある質問それぞれの占有率（入力の順を保つ） */
export function computeShares(questions: Question[]): QuestionShare[] {
  const out: QuestionShare[] = [];
  for (const q of questions) {
    const s = shareOfQuestion(q);
    if (s) out.push(s);
  }
  return out;
}
