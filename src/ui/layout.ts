import { useEffect, useState } from 'preact/hooks';

/**
 * PC の 3 列表示（面接 / 質問 / 詳細）の「どの列を閉じているか」。端末ごとに覚えておく。
 * スマホは 1 画面ずつ切り替える作りなので、この設定は使わない（CSS 側で PC 幅のときだけ効かせる）。
 */
export interface LayoutState {
  /** 左端の「面接」の列を閉じている */
  list: boolean;
  /** 真ん中の「質問」の列を閉じている */
  tree: boolean;
}

const KEY = 'iqa.layout.v1';

function load(): LayoutState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<LayoutState>;
    return { list: !!raw.list, tree: !!raw.tree };
  } catch {
    return { list: false, tree: false };
  }
}

let state: LayoutState = load();
const listeners = new Set<() => void>();

function set(next: LayoutState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 覚えられなくても動く */
  }
  listeners.forEach((l) => l());
}

const wide = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px)') : null;
const NONE: LayoutState = { list: false, tree: false };

/**
 * 今の「閉じている列」。画面が狭いとき（スマホなど、1 画面ずつ切り替える表示）は、
 * 保存してある設定にかかわらず何も閉じていないものとして扱う（列が空白にならないように）。
 */
export function useLayout(): LayoutState {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    wide?.addEventListener('change', l);
    return () => {
      listeners.delete(l);
      wide?.removeEventListener('change', l);
    };
  }, []);
  return !wide || wide.matches ? state : NONE;
}

export function toggleColumn(which: keyof LayoutState) {
  set({ ...state, [which]: !state[which] });
}

/** 左の 2 列をまとめて閉じる／開く。どちらかが開いていれば両方閉じ、両方閉じていれば両方開く */
export function toggleBothColumns() {
  const close = !(state.list && state.tree);
  set({ list: close, tree: close });
}
