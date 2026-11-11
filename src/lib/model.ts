import type { Anchor, Data, Interview, Mark, Question } from '../types';

export function newId(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** 共通フォルダの固定 id。端末ごとに別々に作られても同じものとして統合される */
export const COMMON_ID = 'common';

export function interviewName(i: Pick<Interview, 'kind' | 'company' | 'title'>, fallback = '(無題の面接)'): string {
  if (i.kind === 'common') return '共通';
  return i.company || i.title || fallback;
}

export function emptyData(): Data {
  return { version: 1, interviews: [], questions: [], deleted: {} };
}

export function createInterview(init: Partial<Interview> = {}, now = Date.now()): Interview {
  return {
    id: newId(),
    title: '',
    company: '',
    date: '',
    stage: 'preparing',
    note: '',
    createdAt: now,
    updatedAt: now,
    ...init,
  };
}

export function createQuestion(
  interviewId: string,
  init: Partial<Question> = {},
  now = Date.now(),
): Question {
  return {
    id: newId(),
    interviewId,
    parentId: null,
    anchor: null,
    text: '',
    answer: '',
    keyPoints: '',
    tags: [],
    marks: [],
    status: 'todo',
    order: now,
    card: { box: 0, due: null, seen: 0 },
    createdAt: now,
    updatedAt: now,
    ...init,
  };
}

/**
 * 質問とその深掘り(子孫)を別の面接へ複製する。引用(anchor)は子孫ではそのまま保つ。
 * 学習状態は引き継がない。戻り値の rootId が複製した最上位の質問。
 */
export function copySubtree(
  questions: Question[],
  sourceId: string,
  targetInterviewId: string,
  parentId: string | null = null,
  now = Date.now(),
  rootOrder?: number,
): { copies: Question[]; rootId: string } {
  const ids = descendantIds(questions, sourceId);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const idMap = new Map(ids.map((id) => [id, newId()]));
  const copies = ids.map((id, index): Question => {
    const q = byId.get(id)!;
    const isRoot = id === sourceId;
    return {
      ...q,
      id: idMap.get(id)!,
      interviewId: targetInterviewId,
      parentId: isRoot ? parentId : (idMap.get(q.parentId ?? '') ?? null),
      anchor: isRoot ? null : q.anchor,
      tags: [...q.tags],
      marks: q.marks.map((m) => ({ ...m, id: newId() })),
      card: { box: 0, due: null, seen: 0 },
      order: isRoot && rootOrder !== undefined ? rootOrder : now + index,
      createdAt: now,
      updatedAt: now,
    };
  });
  return { copies, rootId: idMap.get(sourceId)! };
}

export function childrenOf(questions: Question[], interviewId: string, parentId: string | null) {
  return questions
    .filter((q) => q.interviewId === interviewId && q.parentId === parentId)
    .sort(compareQuestions);
}

/** 同じ親の下では order（手動で並べ替えた順。初期は作成順）で並べる */
export function compareQuestions(a: Question, b: Question): number {
  return a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);
}

export interface TreeRow {
  question: Question;
  depth: number;
}

/** 面接内の質問を深さ優先で平らにした行リスト */
export function flattenTree(questions: Question[], interviewId: string): TreeRow[] {
  const byParent = new Map<string | null, Question[]>();
  for (const q of questions) {
    if (q.interviewId !== interviewId) continue;
    const list = byParent.get(q.parentId) ?? [];
    list.push(q);
    byParent.set(q.parentId, list);
  }
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    const list = (byParent.get(parentId) ?? []).sort(compareQuestions);
    for (const q of list) {
      if (seen.has(q.id)) continue;
      seen.add(q.id);
      rows.push({ question: q, depth });
      walk(q.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** id とその子孫すべての id */
export function descendantIds(questions: Question[], rootId: string): string[] {
  const result = [rootId];
  const queue = [rootId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const q of questions) {
      if (q.parentId === current && !result.includes(q.id)) {
        result.push(q.id);
        queue.push(q.id);
      }
    }
  }
  return result;
}

export function ancestorsOf(questions: Question[], id: string): Question[] {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const chain: Question[] = [];
  let current = byId.get(id)?.parentId ?? null;
  while (current && !chain.some((c) => c.id === current)) {
    const parent = byId.get(current);
    if (!parent) break;
    chain.unshift(parent);
    current = parent.parentId;
  }
  return chain;
}

/** 選択範囲の前後の空白を削って Anchor にする。空なら null */
export function makeAnchor(text: string, start: number, end: number): Anchor | null {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(text.length, Math.max(start, end));
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  if (e <= s) return null;
  return { start: s, end: e, quote: text.slice(s, e) };
}

/**
 * 回答が編集されたあと、引用の位置を追従させる。
 *  - 位置がそのまま合っていればそのまま
 *  - ずれていれば、引用と同じ文字列を新しい本文から探し、元の位置に最も近いものを採用
 *  - 見つからなければ broken にする（引用テキストは残す）
 */
export function remapAnchor(newText: string, anchor: Anchor): Anchor {
  if (newText.slice(anchor.start, anchor.end) === anchor.quote) {
    return anchor.broken ? { ...anchor, broken: undefined } : anchor;
  }
  let best = -1;
  let bestDistance = Infinity;
  let from = 0;
  while (anchor.quote.length > 0) {
    const index = newText.indexOf(anchor.quote, from);
    if (index < 0) break;
    const distance = Math.abs(index - anchor.start);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    from = index + 1;
  }
  if (best < 0) return { ...anchor, broken: true };
  return { start: best, end: best + anchor.quote.length, quote: anchor.quote };
}

/** 質問の answer が変わったとき、その子の anchor を更新した質問配列を返す */
export function remapChildAnchors(questions: Question[], parentId: string, newAnswer: string, now = Date.now()) {
  let changed = false;
  const next = questions.map((q) => {
    if (q.parentId !== parentId || !q.anchor) return q;
    const remapped = remapAnchor(newAnswer, q.anchor);
    if (
      remapped.start === q.anchor.start &&
      remapped.end === q.anchor.end &&
      !!remapped.broken === !!q.anchor.broken
    ) {
      return q;
    }
    changed = true;
    return { ...q, anchor: remapped, updatedAt: now };
  });
  return changed ? next : questions;
}

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').replace(/\s+/g, '');
}

export function allTags(questions: Question[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const q of questions) for (const t of q.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ja'));
}

/** キーポイント（1 行 1 項目）を配列にする。行頭の記号は除く */
export function keyPointLines(keyPoints: string): string[] {
  return keyPoints
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*([-*・●•]|\d+[.)、])\s*/, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 並べ替え・移動
// ---------------------------------------------------------------------------

export interface MoveTarget {
  interviewId: string;
  /** 移動先の親。null なら面接の直下（ルート） */
  parentId: string | null;
  /** この質問の直前に入れる。null/未指定なら末尾 */
  beforeId?: string | null;
}

function orderBetween(prev: number | undefined, next: number | undefined, now: number): number {
  if (prev === undefined && next === undefined) return now;
  if (prev === undefined) return next! - 1000;
  if (next === undefined) return prev + 1000;
  return (prev + next) / 2;
}

function siblingsOf(questions: Question[], t: MoveTarget, exclude: Set<string>): Question[] {
  return questions
    .filter((q) => q.interviewId === t.interviewId && q.parentId === t.parentId && !exclude.has(q.id))
    .sort(compareQuestions);
}

/** 新しく差し込む質問の order（t の位置に入れたとき、前後の間に収まる値） */
export function insertionOrder(questions: Question[], t: MoveTarget, exclude: string[] = [], now = Date.now()): number {
  const sibs = siblingsOf(questions, t, new Set(exclude));
  let idx = t.beforeId ? sibs.findIndex((s) => s.id === t.beforeId) : sibs.length;
  if (idx < 0) idx = sibs.length;
  return orderBetween(sibs[idx - 1]?.order, sibs[idx]?.order, now);
}

/**
 * 質問（と子孫）を別の位置へ動かす。同じ親の中での並べ替え、親の付け替え、
 * 別の面接への移動をまとめて扱う。自分の子孫の下へは動かせない（null を返す）。
 * 親が変わるときは、元の回答への引用(anchor)が意味を失うので外す。
 */
export function moveQuestion(questions: Question[], id: string, t: MoveTarget, now = Date.now()): Question[] | null {
  const moved = questions.find((q) => q.id === id);
  if (!moved) return null;
  const subtree = descendantIds(questions, id);
  const subtreeSet = new Set(subtree);
  if (t.parentId && subtreeSet.has(t.parentId)) return null;
  if (t.beforeId && subtreeSet.has(t.beforeId)) return null;

  const sibs = siblingsOf(questions, t, subtreeSet);
  let idx = t.beforeId ? sibs.findIndex((s) => s.id === t.beforeId) : sibs.length;
  if (idx < 0) idx = sibs.length;

  const prev = sibs[idx - 1]?.order;
  const next = sibs[idx]?.order;
  const orders = new Map<string, number>();
  let order: number;
  if (prev !== undefined && next !== undefined && next - prev < 1e-6) {
    // 間隔が詰まりすぎたら、きょうだい全員を等間隔に振り直す
    sibs.forEach((s, i) => orders.set(s.id, (i < idx ? i + 1 : i + 2) * 1000));
    order = (idx + 1) * 1000;
  } else {
    order = orderBetween(prev, next, now);
  }

  const parentChanged = moved.parentId !== t.parentId || moved.interviewId !== t.interviewId;
  return questions.map((q) => {
    if (q.id === id) {
      return { ...q, interviewId: t.interviewId, parentId: t.parentId, anchor: parentChanged ? null : q.anchor, order, updatedAt: now };
    }
    if (subtreeSet.has(q.id)) {
      return q.interviewId === t.interviewId ? q : { ...q, interviewId: t.interviewId, updatedAt: now };
    }
    const renumbered = orders.get(q.id);
    return renumbered === undefined ? q : { ...q, order: renumbered, updatedAt: now };
  });
}

/** 質問を同じ親の中で 1 つ上/下へ動かす。動かせなければ null */
export function nudgeQuestion(questions: Question[], id: string, dir: -1 | 1, now = Date.now()): Question[] | null {
  const q = questions.find((x) => x.id === id);
  if (!q) return null;
  const sibs = siblingsOf(questions, { interviewId: q.interviewId, parentId: q.parentId }, new Set());
  const i = sibs.findIndex((s) => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= sibs.length) return null;
  // 上へ: 1 つ上の兄の直前 / 下へ: 1 つ下の弟の、さらに次の直前
  const beforeId = dir < 0 ? sibs[j].id : (sibs[j + 1]?.id ?? null);
  return moveQuestion(questions, id, { interviewId: q.interviewId, parentId: q.parentId, beforeId }, now);
}

// ---------------------------------------------------------------------------
// 内容タグ（回答の一部に付けるタグ）
// ---------------------------------------------------------------------------

/** 内容タグを追従させる。remapAnchor と同じ規則（位置が合えばそのまま／引用を探し直す／消えたら broken） */
export function remapMarks(newText: string, marks: Mark[]): Mark[] {
  let changed = false;
  const next = marks.map((m) => {
    const r = remapAnchor(newText, { start: m.start, end: m.end, quote: m.quote, broken: m.broken });
    if (r.start === m.start && r.end === m.end && !!r.broken === !!m.broken) return m;
    changed = true;
    return { ...m, start: r.start, end: r.end, broken: r.broken };
  });
  return changed ? next : marks;
}

/** 範囲を段落（改行区切り）の境界まで広げる */
export function expandToParagraph(text: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  while (s > 0 && text[s - 1] !== '\n') s--;
  let e = end;
  while (e < text.length && text[e] !== '\n') e++;
  return { start: s, end: e };
}

/** タグの色相（名前から決まる。同じタグはどの画面でも同じ色） */
export function tagHue(tag: string): number {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
