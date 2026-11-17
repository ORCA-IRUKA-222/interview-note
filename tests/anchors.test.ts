import { describe, expect, it } from 'vitest';
import { createQuestion, diffEdit, mapThroughEdit, remapChildAnchors, remapLinks, remapMarks } from '../src/lib/model';
import { addLink, addMark, addQuestion, getState, reanchorChild, reanchorLink, reanchorMark, updateQuestion } from '../src/lib/store';

const TEXT = '私は大学で画像認識を研究しました。ゼミ長として五人のチームをまとめました。';
const range = (needle: string, text = TEXT) => ({ start: text.indexOf(needle), end: text.indexOf(needle) + needle.length, quote: needle });

describe('編集の差分', () => {
  it('先頭と末尾の同じ部分を除いた、真ん中の置き換えとして表す', () => {
    expect(diffEdit('abc', 'abc')).toBeNull();
    expect(diffEdit('abcdef', 'abXYef')).toEqual({ p: 2, oldLen: 2, newLen: 2 });
    expect(diffEdit('abcdef', 'abef')).toEqual({ p: 2, oldLen: 2, newLen: 0 }); // 削除
    expect(diffEdit('abef', 'abcdef')).toEqual({ p: 2, oldLen: 0, newLen: 2 }); // 挿入
    expect(diffEdit('', 'abc')).toEqual({ p: 0, oldLen: 0, newLen: 3 });
  });
});

describe('範囲を編集に合わせて動かす', () => {
  it('範囲より前の編集は、位置をずらすだけ', () => {
    const r = { start: 10, end: 15 };
    expect(mapThroughEdit(r, { p: 2, oldLen: 0, newLen: 4 })).toEqual({ start: 14, end: 19 }); // 前に挿入
    expect(mapThroughEdit(r, { p: 2, oldLen: 3, newLen: 0 })).toEqual({ start: 7, end: 12 }); // 前を削除
  });

  it('範囲より後の編集は、何も変えない', () => {
    expect(mapThroughEdit({ start: 10, end: 15 }, { p: 20, oldLen: 2, newLen: 9 })).toEqual({ start: 10, end: 15 });
  });

  it('範囲の左端・右端に文字を足しても範囲の外。内側に足せば範囲が伸びる', () => {
    const r = { start: 10, end: 15 };
    expect(mapThroughEdit(r, { p: 10, oldLen: 0, newLen: 3 })).toEqual({ start: 13, end: 18 }); // 左端: 範囲ごと右へ
    expect(mapThroughEdit(r, { p: 15, oldLen: 0, newLen: 3 })).toEqual({ start: 10, end: 15 }); // 右端: 範囲の外
    expect(mapThroughEdit(r, { p: 12, oldLen: 0, newLen: 3 })).toEqual({ start: 10, end: 18 }); // 内側
  });

  it('範囲の一部を直す・消すと、範囲は残る', () => {
    const r = { start: 10, end: 20 };
    expect(mapThroughEdit(r, { p: 12, oldLen: 1, newLen: 1 })).toEqual({ start: 10, end: 20 }); // 1 文字直す
    expect(mapThroughEdit(r, { p: 12, oldLen: 3, newLen: 0 })).toEqual({ start: 10, end: 17 }); // 一部を削除
    expect(mapThroughEdit(r, { p: 8, oldLen: 4, newLen: 2 })).toEqual({ start: 8, end: 18 }); // 左にはみ出す置き換え
    expect(mapThroughEdit(r, { p: 18, oldLen: 5, newLen: 2 })).toEqual({ start: 10, end: 20 }); // 右にはみ出す置き換え
  });

  it('範囲を丸ごと消したら外れる。丸ごと置き換えは、近い長さなら追従・ずっと長ければ外れる', () => {
    expect(mapThroughEdit({ start: 10, end: 15 }, { p: 10, oldLen: 5, newLen: 0 })).toBeNull();
    expect(mapThroughEdit({ start: 10, end: 15 }, { p: 8, oldLen: 9, newLen: 0 })).toBeNull();
    expect(mapThroughEdit({ start: 10, end: 15 }, { p: 10, oldLen: 5, newLen: 7 })).toEqual({ start: 10, end: 17 }); // 言い換え
    expect(mapThroughEdit({ start: 10, end: 15 }, { p: 0, oldLen: 40, newLen: 300 })).toBeNull(); // 回答全体の貼り替え
  });
});

describe('内容タグ・リンク・深掘りの引用が、編集で外れない', () => {
  const mark = (needle: string) => ({ id: 'm', tag: 'T', ...range(needle) });

  it('引用の内側を直しても外れず、引用は新しい文に更新される', () => {
    const edited = TEXT.replace('画像認識', '画像処理');
    const [m] = remapMarks(edited, [mark('画像認識を研究しました')], TEXT);
    expect(m.broken).toBeUndefined();
    expect(edited.slice(m.start, m.end)).toBe('画像処理を研究しました');
    expect(m.quote).toBe('画像処理を研究しました');
  });

  it('前に文を足しても、後ろを直しても、範囲は動くだけ', () => {
    const before = '【追記】' + TEXT;
    const [a] = remapMarks(before, [mark('ゼミ長として')], TEXT);
    expect(before.slice(a.start, a.end)).toBe('ゼミ長として');
    const after = TEXT.replace('まとめました', 'まとめあげました');
    const [b] = remapMarks(after, [mark('画像認識')], TEXT);
    expect(after.slice(b.start, b.end)).toBe('画像認識');
  });

  it('引用の一部を消しても、残った部分に付いたまま', () => {
    const edited = TEXT.replace('を研究しました', 'を');
    const [m] = remapMarks(edited, [mark('画像認識を研究しました')], TEXT);
    expect(m.broken).toBeUndefined();
    expect(edited.slice(m.start, m.end)).toBe('画像認識を');
  });

  it('引用を丸ごと消すと外れる（引用は残す）。同じ文を打ち直すと戻る', () => {
    const gone = TEXT.replace('画像認識を研究しました。', '');
    const [m] = remapMarks(gone, [mark('画像認識を研究しました')], TEXT);
    expect(m.broken).toBe(true);
    expect(m.quote).toBe('画像認識を研究しました');
    const back = remapMarks(TEXT, [m], gone); // 打ち直した（元の文に戻った）
    expect(back[0].broken).toBeUndefined();
    expect(TEXT.slice(back[0].start, back[0].end)).toBe('画像認識を研究しました');
  });

  it('文を切り取って別の場所へ貼り付けても、引用を探し直して付いていく', () => {
    const moved = 'ゼミ長として五人のチームをまとめました。私は大学で画像認識を研究しました。';
    const [m] = remapMarks(moved, [mark('画像認識を研究しました')], TEXT);
    expect(m.broken).toBeUndefined();
    expect(moved.slice(m.start, m.end)).toBe('画像認識を研究しました');
  });

  it('回答の全体を貼り替えたら、小さな範囲は外れる（範囲が回答全体に広がってしまわない）', () => {
    const replaced = '全く別の回答をここに貼り付けました。'.repeat(8);
    const [m] = remapMarks(replaced, [mark('画像認識を研究しました')], TEXT);
    expect(m.broken).toBe(true);
  });

  it('回答を丸ごと書き換えたとき、末尾がたまたま同じでも、小さな範囲が回答全体に広がらない', () => {
    const old = '【追記】私は大学で画像処理を研究しました。新しい文を足しました。';
    const next = '全く別の回答に書き換えました。'; // 末尾「ました。」が同じ
    const m = { id: 'm', tag: 'T', start: old.indexOf('足しました'), end: old.indexOf('足しました') + 5, quote: '足しました' };
    const [r] = remapMarks(next, [m], old);
    expect(r.broken).toBe(true); // 外れる（範囲は [0, 全体) に広がらない）
    expect(r.quote).toBe('足しました');
  });

  it('リンクも同じように追従する', () => {
    const edited = TEXT.replace('五人', '六人');
    const [l] = remapLinks(edited, [{ id: 'l', targetId: 'x', ...range('五人のチーム') }], TEXT);
    expect(l.broken).toBeUndefined();
    expect(edited.slice(l.start, l.end)).toBe('六人のチーム');
  });

  it('深掘りの引用（親の回答の範囲）も、内側を直しても外れず、引用が更新される', () => {
    const parent = createQuestion('i', { id: 'p', answer: TEXT });
    const child = createQuestion('i', { id: 'c', parentId: 'p', anchor: range('画像認識を研究しました') });
    const edited = TEXT.replace('研究しました', '研究してきました');
    const next = remapChildAnchors([parent, child], 'p', edited, 1000, TEXT);
    const a = next.find((q) => q.id === 'c')!.anchor!;
    expect(a.broken).toBeUndefined();
    expect(edited.slice(a.start, a.end)).toBe('画像認識を研究してきました');
    expect(a.quote).toBe('画像認識を研究してきました');
    // 変わらないときは同じ配列を返す
    expect(remapChildAnchors(next, 'p', edited, 1000, edited)).toBe(next);
  });
});

describe('キーを 1 回ずつ打っていく編集でも、外れない（store）', () => {
  it('引用の中で文字を打ち足し・消す → 深掘りの箇所が付いたまま。全部消すと外れ、打ち直すと戻る', () => {
    const iid = 'anchor-e2e';
    const parentId = addQuestion(iid, { text: '親' });
    updateQuestion(parentId, { answer: 'AAA BBB CCC DDD' });
    const childId = addQuestion(iid, { text: '深掘り', parentId, anchor: { start: 4, end: 7, quote: 'BBB' } });
    const anchor = () => getState().data.questions.find((q) => q.id === childId)!.anchor!;
    const type = (text: string) => updateQuestion(parentId, { answer: text });

    // BBB の中に 1 文字ずつ打ち足す: BBxB → BBxyB
    type('AAA BBxB CCC DDD');
    expect(anchor()).toMatchObject({ start: 4, end: 8, quote: 'BBxB' });
    type('AAA BBxyB CCC DDD');
    expect(anchor()).toMatchObject({ start: 4, end: 9, quote: 'BBxyB' });
    // 前の文を伸ばす
    type('ZZ AAA BBxyB CCC DDD');
    expect(anchor()).toMatchObject({ start: 7, end: 12, quote: 'BBxyB' });
    // 1 文字ずつ消していく: 途中までは付いている
    type('ZZ AAA BxyB CCC DDD');
    expect(anchor().broken).toBeUndefined();
    type('ZZ AAA  CCC DDD'); // 全部消えた
    expect(anchor().broken).toBe(true);
    expect(anchor().quote).toBe('BxyB'); // 消える直前の引用が残る
    // 同じ文を打ち直す → 戻る
    type('ZZ AAA BxyB CCC DDD');
    expect(anchor().broken).toBeUndefined();
    expect(anchor().start).toBe(7);
  });
});

describe('外れた箇所の付け直し（store）', () => {
  const setup = (iid: string) => {
    const parent = addQuestion(iid, { text: '親' });
    const other = addQuestion(iid, { text: '別の質問' });
    updateQuestion(parent, { answer: 'AAA BBB CCC DDD EEE' });
    const child = addQuestion(iid, { text: '深掘り', parentId: parent, anchor: { start: 4, end: 7, quote: 'BBB' } });
    addLink(parent, { start: 8, end: 11 }, other); // CCC
    addMark(parent, { start: 12, end: 15 }, '強み'); // DDD
    const q = () => getState().data.questions.find((x) => x.id === parent)!;
    const c = () => getState().data.questions.find((x) => x.id === child)!;
    return { parent, child, other, q, c };
  };

  it('回答を書き換えて外れても、新しい範囲を選んで付け直せる（深掘り・リンク・内容タグ）', () => {
    const { parent, child, q, c } = setup('reattach-1');
    const NEW = '全部書き換えました。新しい文です。';
    const at = (needle: string) => ({ start: NEW.indexOf(needle), end: NEW.indexOf(needle) + needle.length });
    updateQuestion(parent, { answer: NEW }); // 全部の範囲が外れる
    expect(c().anchor!.broken).toBe(true);
    expect(q().links[0].broken).toBe(true);
    expect(q().marks[0].broken).toBe(true);
    // 外れても、元の引用は残っている
    expect(c().anchor!.quote).toBe('BBB');

    expect(reanchorChild(child, at('全部書き換え'))).toBe(true);
    expect(c().anchor).toMatchObject({ ...at('全部書き換え'), quote: '全部書き換え' });
    expect(c().anchor!.broken).toBeUndefined();

    expect(reanchorLink(parent, q().links[0].id, at('新しい文'))).toBe(true);
    expect(q().links[0]).toMatchObject({ ...at('新しい文'), quote: '新しい文' });
    expect(q().links[0].broken).toBeUndefined();
    expect(q().links[0].targetId).toBeTruthy(); // リンク先はそのまま

    expect(reanchorMark(parent, q().marks[0].id, at('文です'))).toBe(true);
    expect(q().marks[0]).toMatchObject({ tag: '強み', ...at('文です') });
    expect(q().marks[0].broken).toBeUndefined();
  });

  it('範囲の前後の空白は削る。空の範囲・存在しない項目は付け直せない', () => {
    const { parent, child, q } = setup('reattach-2');
    expect(reanchorChild(child, { start: 3, end: 8 })).toBe(true); // " BBB " → "BBB"
    expect(getState().data.questions.find((x) => x.id === child)!.anchor).toMatchObject({ start: 4, end: 7, quote: 'BBB' });
    expect(reanchorChild(child, { start: 5, end: 5 })).toBe(false);
    expect(reanchorLink(parent, 'nope', { start: 0, end: 3 })).toBe(false);
    expect(reanchorMark(parent, 'nope', { start: 0, end: 3 })).toBe(false);
    expect(reanchorChild('nope', { start: 0, end: 3 })).toBe(false);
    expect(q().links).toHaveLength(1);
  });

  it('箇所を外す（null）と、深掘り質問は残り、引用だけなくなる。箇所なしの深掘りにも箇所を指定できる', () => {
    const { parent, child, c } = setup('reattach-3');
    updateQuestion(parent, { answer: '別の回答' });
    expect(c().anchor!.broken).toBe(true);
    expect(reanchorChild(child, null)).toBe(true);
    expect(c().anchor).toBeNull();
    expect(c().text).toBe('深掘り');
    expect(reanchorChild(child, { start: 0, end: 2 })).toBe(true);
    expect(c().anchor).toMatchObject({ start: 0, end: 2, quote: '別の' });
  });
});
