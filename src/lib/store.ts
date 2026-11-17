import { useEffect, useState } from 'preact/hooks';
import type { Anchor, Data, Interview, Question, Settings } from '../types';
import {
  COMMON_ID,
  copySubtree,
  createInterview,
  createQuestion,
  descendantIds,
  emptyData,
  insertionOrder,
  makeAnchor,
  moveQuestion as planMove,
  newId,
  nudgeQuestion as planNudge,
  remapChildAnchors,
  remapLinks,
  remapMarks,
  stripLinksTo,
  type MoveTarget,
} from './model';
import { mergeData, parseData } from './merge';
import { gradeCard } from './srs';

const DATA_KEY = 'iqa.data.v1';
const SETTINGS_KEY = 'iqa.settings.v1';
const META_KEY = 'iqa.meta.v1';

export type SyncStatus = 'off' | 'idle' | 'pending' | 'syncing' | 'error';
export interface SyncState {
  status: SyncStatus;
  message: string;
  lastSyncedAt: number | null;
}

export interface AppState {
  data: Data;
  settings: Settings;
  sync: SyncState;
  /** データが変更されるたびに増える。同期中の編集検知に使う */
  rev: number;
  /** 質問のコピー/切り取り（貼り付け待ち）。保存はしない */
  clipboard: Clipboard | null;
}

export interface Clipboard {
  id: string;
  mode: 'copy' | 'cut';
}

export const DEFAULT_SETTINGS: Settings = {
  token: '',
  gistId: '',
  autoSync: true,
  karaoke: { sensitivity: 1, fontSize: 26, lang: 'ja-JP', autoScroll: true, speed: 5 },
};

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* プライベートモードや容量超過では保存を諦める（画面上の操作は続けられる） */
  }
}

function loadData(): Data {
  try {
    const raw = read<unknown>(DATA_KEY);
    return raw ? parseData(raw) : emptyData();
  } catch {
    return emptyData();
  }
}

function loadSettings(): Settings {
  const saved = read<Partial<Settings>>(SETTINGS_KEY) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    karaoke: { ...DEFAULT_SETTINGS.karaoke, ...(saved.karaoke ?? {}) },
  };
}

const meta = read<{ lastSyncedAt?: number; dirty?: boolean }>(META_KEY) ?? {};
const initialSettings = loadSettings();

let state: AppState = {
  data: loadData(),
  settings: initialSettings,
  sync: {
    status: initialSettings.token ? (meta.dirty ? 'pending' : 'idle') : 'off',
    message: '',
    lastSyncedAt: meta.lastSyncedAt ?? null,
  },
  rev: 0,
  clipboard: null,
};

/**
 * 「共通」を必ず 1 つ持たせる。updatedAt を 0 にしておくので、すでに別端末で作られた
 * 本物(編集済み)があれば統合時に必ずそちらが勝ち、無駄な同期差分も生まない。
 */
function withCommon(data: Data): Data {
  if (data.interviews.some((i) => i.id === COMMON_ID)) return data;
  const common = createInterview({ id: COMMON_ID, kind: 'common', title: '共通', company: '', createdAt: 0, updatedAt: 0 });
  return { ...data, interviews: [common, ...data.interviews] };
}
state = { ...state, data: withCommon(state.data) };

const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** 変更が Gist に未送信か。同期完了まで true */
let dirty = !!meta.dirty;
let onDataChanged: (() => void) | undefined;

export function getState(): AppState {
  return state;
}

function emit() {
  for (const l of listeners) l();
}

function persistData() {
  write(DATA_KEY, state.data);
  write(META_KEY, { lastSyncedAt: state.sync.lastSyncedAt, dirty });
}

export function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  persistData();
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 300);
}

/** sync.ts が「データが変わった」通知を受け取るための登録 */
export function setDataChangeHandler(fn: () => void) {
  onDataChanged = fn;
}

export function isDirty() {
  return dirty;
}

export function markClean() {
  dirty = false;
  write(META_KEY, { lastSyncedAt: state.sync.lastSyncedAt, dirty });
}

function setData(data: Data, opts: { local: boolean }) {
  state = { ...state, data, rev: state.rev + 1 };
  if (opts.local) {
    dirty = true;
    if (state.settings.token && state.sync.status !== 'syncing') {
      state = { ...state, sync: { ...state.sync, status: 'pending' } };
    }
  }
  schedulePersist();
  emit();
  if (opts.local) onDataChanged?.();
}

export function setSyncState(patch: Partial<SyncState>) {
  state = { ...state, sync: { ...state.sync, ...patch } };
  write(META_KEY, { lastSyncedAt: state.sync.lastSyncedAt, dirty });
  emit();
}

/** 同期結果（統合済みデータ）を取り込む。local=false なので未送信扱いにはしない */
export function applyRemoteMerge(remote: Data) {
  const merged = withCommon(mergeData(state.data, remote));
  setData(merged, { local: false });
}

export function updateSettings(patch: Partial<Settings>) {
  const next = { ...state.settings, ...patch };
  state = { ...state, settings: next };
  write(SETTINGS_KEY, next);
  if (!next.token) state = { ...state, sync: { ...state.sync, status: 'off', message: '' } };
  else if (state.sync.status === 'off') state = { ...state, sync: { ...state.sync, status: dirty ? 'pending' : 'idle' } };
  emit();
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useAppState(): AppState {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  return state;
}

// ---- 変更操作 ---------------------------------------------------------------

const touch = <T extends { updatedAt: number }>(item: T, patch: Partial<T>, now = Date.now()): T => ({
  ...item,
  ...patch,
  updatedAt: now,
});

export function addInterview(init: Partial<Interview> = {}): string {
  const interview = createInterview(init);
  setData({ ...state.data, interviews: [...state.data.interviews, interview] }, { local: true });
  return interview.id;
}

export function updateInterview(id: string, patch: Partial<Interview>) {
  const { data } = state;
  setData(
    { ...data, interviews: data.interviews.map((i) => (i.id === id ? touch(i, patch) : i)) },
    { local: true },
  );
}

export function deleteInterview(id: string) {
  if (id === COMMON_ID) return; // 共通は消せない
  const { data } = state;
  const now = Date.now();
  const deleted = { ...data.deleted, [id]: now };
  const removed = new Set<string>();
  let questions = data.questions.filter((q) => {
    if (q.interviewId !== id) return true;
    deleted[q.id] = now;
    removed.add(q.id);
    return false;
  });
  questions = stripLinksTo(questions, removed, now);
  setData({ ...data, interviews: data.interviews.filter((i) => i.id !== id), questions, deleted }, { local: true });
}

export function addQuestion(
  interviewId: string,
  init: { text?: string; parentId?: string | null; anchor?: Anchor | null } = {},
): string {
  const q = createQuestion(interviewId, {
    text: init.text ?? '',
    parentId: init.parentId ?? null,
    anchor: init.anchor ?? null,
  });
  setData({ ...state.data, questions: [...state.data.questions, q] }, { local: true });
  return q.id;
}

export function updateQuestion(id: string, patch: Partial<Question>) {
  const { data } = state;
  const now = Date.now();
  let questions = data.questions.map((q) => {
    if (q.id !== id) return q;
    // 回答を書き換えたら、内容タグとリンクの位置も追従させる
    let p = patch;
    if (typeof patch.answer === 'string') {
      if (q.marks.length) p = { ...p, marks: remapMarks(patch.answer, q.marks, q.answer) };
      if (q.links.length) p = { ...p, links: remapLinks(patch.answer, q.links, q.answer) };
    }
    return touch(q, p, now);
  });
  if (typeof patch.answer === 'string') {
    questions = remapChildAnchors(questions, id, patch.answer, now, data.questions.find((x) => x.id === id)?.answer);
  }
  setData({ ...data, questions }, { local: true });
}

/** 質問とその深掘り（子孫）をまとめて削除する */
export function deleteQuestion(id: string) {
  const { data } = state;
  const ids = new Set(descendantIds(data.questions, id));
  const now = Date.now();
  const deleted = { ...data.deleted };
  for (const x of ids) deleted[x] = now;
  const questions = stripLinksTo(data.questions.filter((q) => !ids.has(q.id)), ids, now);
  setData({ ...data, questions, deleted }, { local: true });
}

/** 質問(と深掘り)を別の面接へコピーする。共通の質問を会社ごとの面接に取り込むのに使う */
export function copyQuestionTree(
  sourceId: string,
  targetInterviewId: string,
  parentId: string | null = null,
  beforeId: string | null = null,
): string {
  const { data } = state;
  const rootOrder = insertionOrder(data.questions, { interviewId: targetInterviewId, parentId, beforeId });
  const { copies, rootId } = copySubtree(data.questions, sourceId, targetInterviewId, parentId, Date.now(), rootOrder);
  setData({ ...data, questions: [...data.questions, ...copies] }, { local: true });
  return rootId;
}

export function gradeQuestion(id: string, known: boolean) {
  const { data } = state;
  const now = Date.now();
  setData(
    {
      ...data,
      questions: data.questions.map((q) => (q.id === id ? touch(q, { card: gradeCard(q.card, known) }, now) : q)),
    },
    { local: true },
  );
}

/** JSON の取り込み。既存データとは id 単位で統合する */
export function importData(raw: unknown) {
  const incoming = parseData(raw);
  setData(withCommon(mergeData(state.data, incoming)), { local: true });
}

export function clearLocalData() {
  setData(withCommon(emptyData()), { local: false });
  dirty = false;
  flushSave();
}

/** 質問（と深掘り）を別の位置・別の面接へ動かす。動かせない指定（自分の子孫の下など）は false */
export function moveQuestion(id: string, target: MoveTarget): boolean {
  const next = planMove(state.data.questions, id, target);
  if (!next) return false;
  setData({ ...state.data, questions: next }, { local: true });
  return true;
}

/** 同じ親の中で 1 つ上(-1)/下(1)へ */
export function nudgeQuestion(id: string, dir: -1 | 1): boolean {
  const next = planNudge(state.data.questions, id, dir);
  if (!next) return false;
  setData({ ...state.data, questions: next }, { local: true });
  return true;
}

export function setClipboard(clipboard: Clipboard | null) {
  state = { ...state, clipboard };
  emit();
}

/**
 * コピー/切り取り中の質問を、指定の位置へ貼り付ける。切り取りは移動、コピーは複製。
 * 戻り値は貼り付けた質問の id（できなければ null）。
 */
export function pasteClipboard(target: MoveTarget): string | null {
  const clip = state.clipboard;
  if (!clip || !state.data.questions.some((q) => q.id === clip.id)) {
    setClipboard(null);
    return null;
  }
  if (clip.mode === 'cut') {
    if (!moveQuestion(clip.id, target)) return null;
    setClipboard(null);
    return clip.id;
  }
  return copyQuestionTree(clip.id, target.interviewId, target.parentId, target.beforeId ?? null);
}

// ---- 内容タグ ---------------------------------------------------------------

/** 回答の範囲に内容タグを付ける。前後の空白は削り、同じ範囲・同じタグの重複は作らない */
export function addMark(questionId: string, range: { start: number; end: number }, tag: string): boolean {
  const q = state.data.questions.find((x) => x.id === questionId);
  const a = q && makeAnchor(q.answer, range.start, range.end);
  if (!q || !a || !tag) return false;
  if (q.marks.some((m) => m.tag === tag && m.start === a.start && m.end === a.end)) return false;
  updateQuestion(questionId, { marks: [...q.marks, { id: newId(), start: a.start, end: a.end, quote: a.quote, tag }] });
  return true;
}

export function removeMark(questionId: string, markId: string) {
  const q = state.data.questions.find((x) => x.id === questionId);
  if (q) updateQuestion(questionId, { marks: q.marks.filter((m) => m.id !== markId) });
}

// ---- 質問へのリンク ---------------------------------------------------------

/** 回答の範囲から、既存の質問へリンクを張る。自分自身・存在しない質問・同じ範囲への重複は張らない */
export function addLink(questionId: string, range: { start: number; end: number }, targetId: string): boolean {
  const { questions } = state.data;
  const q = questions.find((x) => x.id === questionId);
  const a = q && makeAnchor(q.answer, range.start, range.end);
  if (!q || !a || questionId === targetId || !questions.some((x) => x.id === targetId)) return false;
  if (q.links.some((l) => l.targetId === targetId && l.start === a.start && l.end === a.end)) return false;
  updateQuestion(questionId, { links: [...q.links, { id: newId(), start: a.start, end: a.end, quote: a.quote, targetId }] });
  return true;
}

export function removeLink(questionId: string, linkId: string) {
  const q = state.data.questions.find((x) => x.id === questionId);
  if (q) updateQuestion(questionId, { links: q.links.filter((l) => l.id !== linkId) });
}

// ---- 範囲の付け直し -----------------------------------------------------------
// 回答を大きく書き換えて範囲が見つからなくなった（broken）ときや、範囲を変えたいときに、新しい範囲を指定し直す。

/** 深掘り質問の引用（親の回答の範囲）を付け直す。range を null にすると箇所を外し、質問だけ残す */
export function reanchorChild(childId: string, range: { start: number; end: number } | null): boolean {
  const { questions } = state.data;
  const child = questions.find((x) => x.id === childId);
  const parent = child?.parentId ? questions.find((x) => x.id === child.parentId) : undefined;
  if (!child || !parent) return false;
  if (range === null) {
    updateQuestion(childId, { anchor: null });
    return true;
  }
  const a = makeAnchor(parent.answer, range.start, range.end);
  if (!a) return false;
  updateQuestion(childId, { anchor: a });
  return true;
}

/** リンクの範囲を付け直す（リンク先はそのまま） */
export function reanchorLink(questionId: string, linkId: string, range: { start: number; end: number }): boolean {
  const q = state.data.questions.find((x) => x.id === questionId);
  const a = q && makeAnchor(q.answer, range.start, range.end);
  if (!q || !a || !q.links.some((l) => l.id === linkId)) return false;
  updateQuestion(questionId, {
    links: q.links.map((l) => (l.id === linkId ? { id: l.id, targetId: l.targetId, start: a.start, end: a.end, quote: a.quote } : l)),
  });
  return true;
}

/** 内容タグの範囲を付け直す（タグ名はそのまま） */
export function reanchorMark(questionId: string, markId: string, range: { start: number; end: number }): boolean {
  const q = state.data.questions.find((x) => x.id === questionId);
  const a = q && makeAnchor(q.answer, range.start, range.end);
  if (!q || !a || !q.marks.some((m) => m.id === markId)) return false;
  updateQuestion(questionId, {
    marks: q.marks.map((m) => (m.id === markId ? { id: m.id, tag: m.tag, start: a.start, end: a.end, quote: a.quote } : m)),
  });
  return true;
}
