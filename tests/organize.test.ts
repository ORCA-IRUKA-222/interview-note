import { describe, expect, it } from 'vitest';
import {
  COMMON_ID,
  copySubtree,
  createInterview,
  createQuestion,
  emptyData,
  expandToParagraph,
  flattenTree,
  insertionOrder,
  moveQuestion,
  nudgeQuestion,
  remapMarks,
  tagHue,
} from '../src/lib/model';
import { parseData, serialize } from '../src/lib/merge';
import { computeShares, shareOfQuestion } from '../src/lib/stats';
import { toMarkdown } from '../src/lib/exporter';
import { search } from '../src/lib/search';
import type { Question } from '../src/types';

const q = (id: string, order: number, extra: Partial<Question> = {}) =>
  createQuestion('a', { id, order, text: id, createdAt: order, updatedAt: 1, ...extra });

const names = (qs: Question[], iid = 'a') => flattenTree(qs, iid).map((r) => `${'-'.repeat(r.depth)}${r.question.id}`);

describe('並べ替え・移動', () => {
  const base = () => [q('A', 10), q('B', 20), q('C', 30), q('A1', 5, { parentId: 'A' }), q('A2', 6, { parentId: 'A' })];

  it('order の順に並ぶ（深掘りも order）', () => {
    expect(names(base())).toEqual(['A', '-A1', '-A2', 'B', 'C']);
  });

  it('同じ親の中で前へ/後ろへ動かせる', () => {
    const moved = moveQuestion(base(), 'C', { interviewId: 'a', parentId: null, beforeId: 'A' })!;
    expect(names(moved)).toEqual(['C', 'A', '-A1', '-A2', 'B']);
    const toEnd = moveQuestion(base(), 'A', { interviewId: 'a', parentId: null, beforeId: null })!;
    expect(names(toEnd)).toEqual(['B', 'C', 'A', '-A1', '-A2']);
  });

  it('1 つ上/下へ（端では動かない）', () => {
    expect(names(nudgeQuestion(base(), 'B', -1)!)).toEqual(['B', 'A', '-A1', '-A2', 'C']);
    expect(names(nudgeQuestion(base(), 'B', 1)!)).toEqual(['A', '-A1', '-A2', 'C', 'B']);
    expect(nudgeQuestion(base(), 'A', -1)).toBeNull();
    expect(nudgeQuestion(base(), 'C', 1)).toBeNull();
  });

  it('子として入れる／ルートへ出す。親が変わると引用は外れ、子孫ごと動く', () => {
    const withAnchor = base().map((x) => (x.id === 'A1' ? { ...x, anchor: { start: 0, end: 2, quote: 'ab' } } : x));
    const asChild = moveQuestion(withAnchor, 'A', { interviewId: 'a', parentId: 'B' })!;
    expect(names(asChild)).toEqual(['B', '-A', '--A1', '--A2', 'C']);
    const out = moveQuestion(withAnchor, 'A1', { interviewId: 'a', parentId: null, beforeId: 'B' })!;
    expect(names(out)).toEqual(['A', '-A2', 'A1', 'B', 'C']);
    expect(out.find((x) => x.id === 'A1')!.anchor).toBeNull();
    // 同じ親の中の並べ替えでは引用を保つ
    const same = moveQuestion(withAnchor, 'A1', { interviewId: 'a', parentId: 'A', beforeId: null })!;
    expect(same.find((x) => x.id === 'A1')!.anchor).not.toBeNull();
  });

  it('自分の子孫の下へは動かせない', () => {
    expect(moveQuestion(base(), 'A', { interviewId: 'a', parentId: 'A1' })).toBeNull();
    expect(moveQuestion(base(), 'A', { interviewId: 'a', parentId: 'A' })).toBeNull();
    expect(moveQuestion(base(), 'A', { interviewId: 'a', parentId: null, beforeId: 'A2' })).toBeNull();
  });

  it('別の面接へ移動すると、子孫も interviewId が変わる', () => {
    const moved = moveQuestion(base(), 'A', { interviewId: COMMON_ID, parentId: null })!;
    expect(names(moved, COMMON_ID)).toEqual(['A', '-A1', '-A2']);
    expect(names(moved, 'a')).toEqual(['B', 'C']);
  });

  it('間隔が詰まっても順序が保たれる（振り直し）', () => {
    let list = [q('X', 1000), q('Y', 1000.0000001), q('Z', 2000)];
    list = moveQuestion(list, 'Z', { interviewId: 'a', parentId: null, beforeId: 'Y' })!;
    expect(names(list)).toEqual(['X', 'Z', 'Y']);
    // 何度も同じ場所へ差し込んでも順序は崩れない
    for (let i = 0; i < 60; i++) {
      const id = `N${i}`;
      list = [...list, q(id, 99999 + i)];
      list = moveQuestion(list, id, { interviewId: 'a', parentId: null, beforeId: 'Y' })!;
    }
    const order = names(list);
    expect(order.slice(0, 2)).toEqual(['X', 'Z']);
    expect(order.slice(2, 62)).toEqual(Array.from({ length: 60 }, (_, i) => `N${i}`));
    expect(order[62]).toBe('Y');
  });

  it('コピーは指定位置に入り、内容タグも複製される', () => {
    const src = [q('S', 1, { marks: [{ id: 'm', start: 0, end: 2, quote: 'ab', tag: '自己PR' }] }), q('T', 50), q('U', 60)];
    const order = insertionOrder(src, { interviewId: 'a', parentId: null, beforeId: 'U' });
    expect(order).toBeGreaterThan(50);
    expect(order).toBeLessThan(60);
    const { copies, rootId } = copySubtree(src, 'S', 'a', null, 1000, order);
    expect(copies[0].marks[0]).toMatchObject({ tag: '自己PR', quote: 'ab' });
    expect(copies[0].marks[0].id).not.toBe('m');
    expect(names([...src, ...copies])).toEqual(['S', 'T', rootId, 'U']);
  });
});

describe('内容タグ', () => {
  it('回答を書き換えても位置が追従し、消えたら broken、戻れば復活', () => {
    const marks = [{ id: '1', start: 2, end: 5, quote: '登山部', tag: 'ガクチカ' }];
    expect(remapMarks('私は登山部で…', marks)).toBe(marks);
    const shifted = remapMarks('【追記】私は登山部で…', marks);
    expect(shifted[0]).toMatchObject({ start: 6, end: 9 });
    const gone = remapMarks('全部書き換え', marks);
    expect(gone[0].broken).toBe(true);
    expect(remapMarks('登山部', gone)[0].broken).toBeUndefined();
  });

  it('段落（改行区切り）まで広げる', () => {
    const t = '一行目です。\n二行目の中ほど。\n三行目。';
    const s = t.indexOf('中ほど');
    expect(expandToParagraph(t, s, s + 3)).toEqual({ start: 7, end: 15 });
    expect(t.slice(7, 15)).toBe('二行目の中ほど。');
    expect(expandToParagraph(t, 0, 2)).toEqual({ start: 0, end: 6 });
  });

  it('色相は名前で決まり、保存・読込でタグが保たれる', () => {
    expect(tagHue('自己PR')).toBe(tagHue('自己PR'));
    expect(tagHue('自己PR')).not.toBe(tagHue('志望動機'));
    const d = emptyData();
    d.interviews.push(createInterview({ id: 'a' }));
    d.questions.push(q('Q', 1, { answer: 'あいうえお', marks: [{ id: 'm', start: 0, end: 2, quote: 'あい', tag: 'T' }] }));
    const back = parseData(JSON.parse(serialize(d)));
    expect(back.questions[0].marks).toEqual(d.questions[0].marks);
    // 古いデータ（marks なし）も読める
    const legacy = parseData({ interviews: [{ id: 'a' }], questions: [{ id: 'Q', interviewId: 'a' }] });
    expect(legacy.questions[0].marks).toEqual([]);
  });
});

describe('占有率（質問ごと）', () => {
  const answer = 'ABCDE FGHIJ\nKLMNO PQRST'; // 空白・改行を除くと 20 文字

  it('分母はその質問の回答。割合と未分類の合計は 100%', () => {
    const s = shareOfQuestion(
      q('1', 1, {
        answer,
        marks: [
          { id: 'a', start: 0, end: 5, quote: 'ABCDE', tag: '自己PR' }, // 5
          { id: 'b', start: 6, end: 11, quote: 'FGHIJ', tag: '志望動機' }, // 5
        ],
      }),
    )!;
    expect(s.total).toBe(20);
    expect(s.untagged).toBe(10);
    // 同じ割合のときは五十音順
    expect(s.tags).toEqual([
      { tag: '志望動機', chars: 5, ratio: 0.25 },
      { tag: '自己PR', chars: 5, ratio: 0.25 },
    ]);
    const sum = s.tags.reduce((n, t) => n + t.ratio, 0) + s.untagged / s.total;
    expect(sum).toBeCloseTo(1, 10);
  });

  it('重なったら範囲の短い（細かい）タグが優先され、二重に数えない', () => {
    const s = shareOfQuestion(
      q('1', 1, {
        answer,
        marks: [
          { id: 'wide', start: 0, end: 11, quote: 'ABCDE FGHIJ', tag: '全体' }, // 空白を除いて 10 文字
          { id: 'inner', start: 0, end: 3, quote: 'ABC', tag: '細部' }, // 3 文字（全体の中）
        ],
      }),
    )!;
    const get = (t: string) => s.tags.find((x) => x.tag === t)!;
    expect(get('細部').chars).toBe(3);
    expect(get('全体').chars).toBe(7); // 10 - 3
    expect(s.untagged).toBe(10);
    // 同じ範囲を二重に付けても、同じタグなら増えない
    const dup = shareOfQuestion(
      q('1', 1, {
        answer,
        marks: [
          { id: 'a', start: 0, end: 3, quote: 'ABC', tag: 'X' },
          { id: 'b', start: 0, end: 3, quote: 'ABC', tag: 'X' },
        ],
      }),
    )!;
    expect(dup.tags).toEqual([{ tag: 'X', chars: 3, ratio: 3 / 20 }]);
  });

  it('同じ長さで重なれば、後から付けたタグが優先される', () => {
    const s = shareOfQuestion(
      q('1', 1, {
        answer,
        marks: [
          { id: 'a', start: 0, end: 5, quote: 'ABCDE', tag: '先' },
          { id: 'b', start: 0, end: 5, quote: 'ABCDE', tag: '後' },
        ],
      }),
    )!;
    expect(s.tags.map((t) => t.tag)).toEqual(['後']);
  });

  it('broken な内容タグは数えない。回答のない質問は対象外', () => {
    const s = shareOfQuestion(q('1', 1, { answer: 'あいう', marks: [{ id: 'a', start: 0, end: 2, quote: 'あい', tag: 'X', broken: true }] }))!;
    expect(s.tags).toEqual([]);
    expect(s.untagged).toBe(3);
    expect(shareOfQuestion(q('2', 2, { answer: '  \n ' }))).toBeNull();
    expect(computeShares([q('3', 3, { answer: '' }), q('4', 4, { answer: 'あ' })]).map((x) => x.questionId)).toEqual(['4']);
  });
});

describe('内容タグの書き出しと検索', () => {
  const d = (() => {
    const x = emptyData();
    x.interviews.push(createInterview({ id: 'a', company: 'ACME' }));
    x.questions.push(q('1', 1, { answer: '登山部で部長をしました。', marks: [{ id: 'm', start: 0, end: 3, quote: '登山部', tag: 'ガクチカ' }] }));
    return x;
  })();

  it('Markdown に内容タグが出る', () => {
    expect(toMarkdown(d)).toContain('- #ガクチカ 「登山部」');
  });

  it('内容タグ名でも検索できる', () => {
    expect(search(d, 'ガクチカ').map((h) => h.question.id)).toEqual(['1']);
  });
});
