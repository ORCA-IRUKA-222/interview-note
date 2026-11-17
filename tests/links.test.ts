import { describe, expect, it } from 'vitest';
import {
  backlinksTo,
  copySubtree,
  createInterview,
  createQuestion,
  emptyData,
  questionTrail,
  remapLinks,
  stripLinksTo,
  suggestLinkTargets,
} from '../src/lib/model';
import { parseData, serialize } from '../src/lib/merge';
import { toMarkdown } from '../src/lib/exporter';
import { addLink, addQuestion, deleteQuestion, getState, removeLink, updateQuestion } from '../src/lib/store';
import type { Data, Question } from '../src/types';

const INTRO =
  '東京理科大学の小林です。理由は、小学5年生の頃からお祭りを企画してきたからです。' +
  '現在はスキーサークルの会長として新入生の退部率を42.5%から13%に下げ、人が辞めない作りを設計しています。';
const QUOTE = 'スキーサークルの会長として新入生の退部率を42.5%から13%に下げ';

const scenario = (): Data => {
  const d = emptyData();
  d.interviews.push(createInterview({ id: 'acme', company: 'ACME' }));
  d.questions.push(
    createQuestion('acme', { id: 'intro', text: '自己紹介をしてください', answer: INTRO, order: 1 }),
    createQuestion('acme', { id: 'gakuchika', text: '学生時代に力を入れたことは？', answer: 'スキーサークルの運営です。', order: 2 }),
    createQuestion('acme', {
      id: 'why',
      parentId: 'gakuchika',
      text: '退部率を下げるために、具体的に何に取り組みましたか？',
      answer: 'スキーサークルの新入生が辞める理由を聞き取り、退部率を42.5%から13%に下げる仕組みを作りました。',
      order: 3,
    }),
    createQuestion('acme', { id: 'motive', text: '志望動機は？', answer: '御社の企画に魅力を感じました。', order: 4 }),
  );
  return d;
};

describe('おすすめのリンク先', () => {
  it('選んだ文に近い質問が上に来る（自分自身は出さない）', () => {
    const got = suggestLinkTargets(scenario(), QUOTE, 'intro').map((q) => q.id);
    expect(got[0]).toBe('why'); // 退部率・42.5%→13% を書いたガクチカの深掘り
    expect(got).toContain('gakuchika');
    expect(got).not.toContain('intro');
    expect(got).not.toContain('motive');
  });

  it('かな/カナ・全角半角の違いがあっても近いと分かる', () => {
    const d = scenario();
    expect(suggestLinkTargets(d, 'ｽｷｰサークルの たいぶりつ', 'intro', 3).map((q) => q.id)).toEqual(expect.arrayContaining(['why']));
  });

  it('近いものがなければ空。短すぎる選択も空', () => {
    expect(suggestLinkTargets(scenario(), 'zzzzzzzz', 'intro')).toEqual([]);
    expect(suggestLinkTargets(scenario(), 'あ', 'intro')).toEqual([]);
  });

  it('所在（面接名 ▸ 親の質問）を返す', () => {
    const d = scenario();
    expect(questionTrail(d, d.questions.find((q) => q.id === 'why')!)).toEqual(['ACME', '学生時代に力を入れたことは？']);
    expect(questionTrail(d, d.questions.find((q) => q.id === 'motive')!)).toEqual(['ACME']);
  });
});

describe('リンクの追従・リンク元・削除', () => {
  const link = (id: string, targetId: string, start: number, end: number, quote: string, broken?: boolean) => ({ id, targetId, start, end, quote, ...(broken ? { broken } : {}) });

  it('回答を書き換えてもリンクの位置が追従し、消えたら broken、戻れば復活', () => {
    const links = [link('l1', 'why', 2, 5, '登山部')];
    expect(remapLinks('私は登山部で…', links)).toBe(links);
    expect(remapLinks('【追記】私は登山部で…', links)[0]).toMatchObject({ start: 6, end: 9 });
    const gone = remapLinks('全部書き換え', links);
    expect(gone[0].broken).toBe(true);
    expect(remapLinks('登山部', gone)[0].broken).toBeUndefined();
  });

  it('リンク元の一覧（壊れたリンクと自分自身は除く）', () => {
    const d = scenario();
    d.questions[0] = { ...d.questions[0], links: [link('l1', 'why', 0, 4, 'abcd')] };
    d.questions[3] = { ...d.questions[3], links: [link('l2', 'why', 0, 2, 'ab'), link('l3', 'why', 3, 5, 'cd', true)] };
    expect(backlinksTo(d.questions, 'why').map((b) => [b.question.id, b.link.id])).toEqual([['intro', 'l1'], ['motive', 'l2']]);
    expect(backlinksTo(d.questions, 'intro')).toEqual([]);
  });

  it('消えた質問へのリンクをほかの質問から外す', () => {
    const d = scenario();
    d.questions[0] = { ...d.questions[0], links: [link('l1', 'why', 0, 4, 'abcd'), link('l2', 'motive', 5, 8, 'efg')], updatedAt: 1 };
    const next = stripLinksTo(d.questions, new Set(['why']), 99);
    expect(next[0].links.map((l) => l.id)).toEqual(['l2']);
    expect(next[0].updatedAt).toBe(99);
    expect(next[1]).toBe(d.questions[1]); // 関係ない質問は触らない
    expect(stripLinksTo(d.questions, new Set(['nobody']), 99)).toBe(d.questions);
  });

  it('コピーすると、コピー範囲の中へのリンクはコピー側へ付け替え、外へのリンクはそのまま', () => {
    const qs: Question[] = [
      createQuestion('a', { id: 'p', text: 'P', order: 1, links: [link('l1', 'c', 0, 1, 'x'), link('l2', 'outside', 2, 3, 'y')] }),
      createQuestion('a', { id: 'c', parentId: 'p', text: 'C', order: 2 }),
    ];
    const { copies } = copySubtree(qs, 'p', 'b', null, 1000);
    const [p2, c2] = copies;
    expect(p2.links.find((l) => l.quote === 'x')!.targetId).toBe(c2.id);
    expect(p2.links.find((l) => l.quote === 'y')!.targetId).toBe('outside');
    expect(p2.links.map((l) => l.id)).not.toContain('l1');
  });

  it('保存・読込でリンクが保たれ、古いデータ（links なし）も読める', () => {
    const d = scenario();
    d.questions[0] = { ...d.questions[0], links: [link('l1', 'why', 0, 4, 'abcd')] };
    // 保存時は id 順に並ぶので、質問は id で探す
    expect(parseData(JSON.parse(serialize(d))).questions.find((q) => q.id === 'intro')!.links).toEqual(d.questions[0].links);
    expect(parseData({ interviews: [{ id: 'a' }], questions: [{ id: 'Q', interviewId: 'a' }] }).questions[0].links).toEqual([]);
  });
});

describe('store: リンクの作成と削除', () => {
  it('張れるのは存在する別の質問だけ。重複は張らない。範囲の前後の空白は削る', () => {
    const iid = 'link-test';
    const a = addQuestion(iid, { text: 'A' });
    const b = addQuestion(iid, { text: 'B' });
    updateQuestion(a, { answer: '  退部率を下げた話  ' });
    expect(addLink(a, { start: 0, end: 12 }, b)).toBe(true);
    const link = getState().data.questions.find((q) => q.id === a)!.links[0];
    expect(link).toMatchObject({ targetId: b, quote: '退部率を下げた話' });
    expect(addLink(a, { start: 0, end: 12 }, b)).toBe(false); // 重複
    expect(addLink(a, { start: 0, end: 12 }, a)).toBe(false); // 自分自身
    expect(addLink(a, { start: 0, end: 12 }, 'ghost')).toBe(false); // 存在しない
    expect(addLink(a, { start: 3, end: 3 }, b)).toBe(false); // 空の範囲
    removeLink(a, link.id);
    expect(getState().data.questions.find((q) => q.id === a)!.links).toEqual([]);
  });

  it('リンク先を削除すると、リンク元からリンクが外れる', () => {
    const iid = 'link-test-2';
    const a = addQuestion(iid, { text: 'A' });
    const b = addQuestion(iid, { text: 'B' });
    updateQuestion(a, { answer: 'あいうえお' });
    addLink(a, { start: 0, end: 3 }, b);
    expect(getState().data.questions.find((q) => q.id === a)!.links).toHaveLength(1);
    deleteQuestion(b);
    expect(getState().data.questions.find((q) => q.id === a)!.links).toEqual([]);
  });
});

describe('書き出し', () => {
  it('Markdown にリンクが出る（壊れたリンク・存在しない先は出さない）', () => {
    const d = scenario();
    d.questions[0] = {
      ...d.questions[0],
      links: [
        { id: 'l1', targetId: 'why', start: 0, end: 4, quote: QUOTE },
        { id: 'l2', targetId: 'ghost', start: 0, end: 2, quote: 'xx' },
        { id: 'l3', targetId: 'motive', start: 0, end: 2, quote: 'yy', broken: true },
      ],
    };
    const md = toMarkdown(d);
    expect(md).toContain('**リンク**');
    expect(md).toContain(`- 「${QUOTE}」→ 退部率を下げるために、具体的に何に取り組みましたか？`);
    expect(md).not.toContain('xx');
    expect(md).not.toContain('yy');
  });
});
