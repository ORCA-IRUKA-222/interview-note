import { describe, expect, it } from 'vitest';
import { altLabel, copySubtree, createInterview, createQuestion, emptyData, promoteAlternative } from '../src/lib/model';
import { parseData, serialize } from '../src/lib/merge';
import { search } from '../src/lib/search';
import { toMarkdown } from '../src/lib/exporter';
import {
  addAlternative,
  addLink,
  addMark,
  addQuestion,
  getState,
  promoteAlternative as promoteInStore,
  removeAlternative,
  updateAlternative,
  updateQuestion,
} from '../src/lib/store';

const alt = (id: string, text: string, label = '') => ({ id, label, text, createdAt: 1, updatedAt: 1 });

describe('サブの回答（別案）: データ', () => {
  it('なくてもよい（既定は空）。古いデータ（alternatives なし）も読める', () => {
    expect(createQuestion('i').alternatives).toEqual([]);
    const legacy = parseData({ interviews: [{ id: 'i' }], questions: [{ id: 'q', interviewId: 'i' }] });
    expect(legacy.questions[0].alternatives).toEqual([]);
  });

  it('保存・読込で保たれる', () => {
    const d = emptyData();
    d.interviews.push(createInterview({ id: 'i' }));
    d.questions.push(createQuestion('i', { id: 'q', alternatives: [alt('a1', '別の切り口の回答', '数字で語る版')] }));
    const back = parseData(JSON.parse(serialize(d)));
    expect(back.questions[0].alternatives).toEqual(d.questions[0].alternatives);
  });

  it('表示名: 名前があればそれ、なければ連番', () => {
    expect(altLabel(alt('a', 'x', '数字で語る版'), 0)).toBe('数字で語る版');
    expect(altLabel(alt('a', 'x', '  '), 1)).toBe('サブ 2');
  });

  it('メインと入れ替えると、いまのメインは同じ場所へサブとして移る', () => {
    const q = { answer: 'メインの回答', alternatives: [alt('a1', '別案その 1', '数字版'), alt('a2', '別案その 2')] };
    const r = promoteAlternative(q, 'a2', 100)!;
    expect(r.answer).toBe('別案その 2');
    expect(r.alternatives.map((a) => [a.id, a.text, a.label])).toEqual([
      ['a1', '別案その 1', '数字版'],
      ['a2', 'メインの回答', '元のメイン'],
    ]);
    expect(promoteAlternative(q, 'nope')).toBeNull();
  });

  it('コピーすると、サブの回答も複製される（id は新しくなる）', () => {
    const qs = [createQuestion('a', { id: 'p', alternatives: [alt('a1', '別案', 'X')] })];
    const { copies } = copySubtree(qs, 'p', 'b', null, 1000);
    expect(copies[0].alternatives).toHaveLength(1);
    expect(copies[0].alternatives[0]).toMatchObject({ text: '別案', label: 'X' });
    expect(copies[0].alternatives[0].id).not.toBe('a1');
  });

  it('検索にサブの回答の文も当たる', () => {
    const d = emptyData();
    d.interviews.push(createInterview({ id: 'i', company: 'ACME' }));
    d.questions.push(
      createQuestion('i', { id: 'q1', text: '自己PR', answer: '粘り強さです', alternatives: [alt('a', '数字で語るなら、退部率を 42.5% から 13% に下げました', '数字版')] }),
      createQuestion('i', { id: 'q2', text: '志望動機', answer: '企画が好きだから' }),
    );
    const hits = search(d, '退部率');
    expect(hits.map((h) => h.question.id)).toEqual(['q1']);
    expect(hits[0].field).toBe('alt');
    expect(search(d, '数字版').map((h) => h.question.id)).toEqual(['q1']); // 名前でも探せる
  });

  it('Markdown に、サブの回答が名前つきで出る（空のサブは出さない）', () => {
    const d = emptyData();
    d.interviews.push(createInterview({ id: 'i', company: 'ACME' }));
    d.questions.push(createQuestion('i', { id: 'q', text: '強みは？', answer: '粘り強さです', alternatives: [alt('a', '数字で語る別案です', '数字版'), alt('b', '   '), alt('c', '名前なしの別案')] }));
    const md = toMarkdown(d);
    expect(md).toContain('**サブの回答 1: 数字版**');
    expect(md).toContain('数字で語る別案です');
    expect(md).toContain('**サブの回答 2**');
    expect(md).toContain('名前なしの別案');
    expect(md.match(/\*\*サブの回答/g)).toHaveLength(2);
  });
});

describe('サブの回答（別案）: store', () => {
  it('追加・編集・削除。メインの回答には影響しない', () => {
    const iid = 'alt-1';
    const q = addQuestion(iid, { text: '強みは？' });
    updateQuestion(q, { answer: 'メインの回答' });
    const find = () => getState().data.questions.find((x) => x.id === q)!;

    const id = addAlternative(q, { label: '数字版' })!;
    expect(find().alternatives).toHaveLength(1);
    expect(find().alternatives[0]).toMatchObject({ id, label: '数字版', text: '' });
    updateAlternative(q, id, { text: '退部率を下げました' });
    expect(find().alternatives[0].text).toBe('退部率を下げました');
    updateAlternative(q, id, { label: '数字で語る版' });
    expect(find().alternatives[0]).toMatchObject({ label: '数字で語る版', text: '退部率を下げました' });
    expect(find().answer).toBe('メインの回答');

    // メインを複製して追加
    const copyId = addAlternative(q, { text: find().answer })!;
    expect(find().alternatives.find((a) => a.id === copyId)!.text).toBe('メインの回答');

    removeAlternative(q, id);
    expect(find().alternatives.map((a) => a.id)).toEqual([copyId]);
    expect(addAlternative('nope')).toBeNull();
  });

  it('メインと入れ替えると、メインの箇所（深掘り・リンク・タグ）は新しい文で見つからなければ外れた扱いになる', () => {
    const iid = 'alt-2';
    const q = addQuestion(iid, { text: '強みは？' });
    const other = addQuestion(iid, { text: '別の質問' });
    updateQuestion(q, { answer: '粘り強さが強みです。毎週の練習を続けました。' });
    const child = addQuestion(iid, { text: '深掘り', parentId: q, anchor: { start: 0, end: 5, quote: '粘り強さが' } });
    addLink(q, { start: 12, end: 16 }, other);
    addMark(q, { start: 12, end: 16 }, '強み');
    const alt = addAlternative(q, { label: '数字版', text: '退部率を 42.5% から 13% に下げた経験です。' })!;

    expect(promoteInStore(q, alt)).toBe(true);
    const nq = getState().data.questions.find((x) => x.id === q)!;
    expect(nq.answer).toBe('退部率を 42.5% から 13% に下げた経験です。');
    expect(nq.alternatives[0]).toMatchObject({ label: '元のメイン', text: '粘り強さが強みです。毎週の練習を続けました。' });
    // 箇所は外れた扱い（付け直せる）で、質問・リンク先・タグ名は残る
    expect(getState().data.questions.find((x) => x.id === child)!.anchor!.broken).toBe(true);
    expect(nq.links[0].broken).toBe(true);
    expect(nq.marks[0]).toMatchObject({ tag: '強み', broken: true });
    expect(promoteInStore(q, 'nope')).toBe(false);
  });
});
