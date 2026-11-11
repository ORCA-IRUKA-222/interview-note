import type { Question } from '../types';

export interface TagShare {
  tag: string;
  /** そのタグが付いた文字数（空白・改行を除く。重なりは 1 回だけ数える） */
  chars: number;
  /** 全体の文字数に対する割合 (0..1) */
  ratio: number;
  passages: { questionId: string; quote: string }[];
}

export interface ShareResult {
  /** 集計した回答の総文字数（空白・改行を除く） */
  total: number;
  /** どのタグも付いていない文字数 */
  untagged: number;
  tags: TagShare[];
  questions: number;
}

const isSpace = (ch: string) => /\s/.test(ch);

/**
 * 回答のうち、どの内容がどれだけを占めるかを集計する。
 * 割合の分母は「回答の総文字数」。1 つの文に複数のタグを付けた場合は、それぞれのタグに数えるので、
 * タグの割合の合計が 100% を超えることがある（未分類は、どのタグも付いていない分）。
 */
export function computeShare(questions: Question[]): ShareResult {
  let total = 0;
  let untagged = 0;
  let counted = 0;
  const perTag = new Map<string, { chars: number; passages: TagShare['passages'] }>();

  for (const q of questions) {
    const text = q.answer;
    if (!text.trim()) continue;
    counted++;
    // マーク位置は UTF-16 のオフセットなので、コードユニット単位で数える
    const units = text.split('');
    const covered = new Uint8Array(units.length);
    const byTag = new Map<string, Uint8Array>();

    for (const m of q.marks) {
      if (m.broken) continue;
      const mask = byTag.get(m.tag) ?? new Uint8Array(units.length);
      for (let i = Math.max(0, m.start); i < Math.min(units.length, m.end); i++) {
        mask[i] = 1;
        covered[i] = 1;
      }
      byTag.set(m.tag, mask);
      const entry = perTag.get(m.tag) ?? { chars: 0, passages: [] };
      entry.passages.push({ questionId: q.id, quote: m.quote });
      perTag.set(m.tag, entry);
    }

    for (let i = 0; i < units.length; i++) {
      if (isSpace(units[i])) continue;
      total++;
      if (!covered[i]) untagged++;
    }
    for (const [tag, mask] of byTag) {
      let n = 0;
      for (let i = 0; i < units.length; i++) if (mask[i] && !isSpace(units[i])) n++;
      perTag.get(tag)!.chars += n;
    }
  }

  const tags = [...perTag.entries()]
    .map(([tag, v]) => ({ tag, chars: v.chars, ratio: total ? v.chars / total : 0, passages: v.passages }))
    .sort((a, b) => b.chars - a.chars || a.tag.localeCompare(b.tag, 'ja'));
  return { total, untagged, tags, questions: counted };
}
