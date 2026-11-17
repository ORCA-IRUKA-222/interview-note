import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyForbidden, GIST_FILE, GistError, pullGist } from '../src/lib/gist';
import { createInterview, createQuestion, emptyData } from '../src/lib/model';
import { mergeData, serialize } from '../src/lib/merge';

const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });

describe('GitHub の 403/429 の見分け', () => {
  it('短時間の連続した書き込みの制限: retry-after の秒数だけ待つ', () => {
    const e = classifyForbidden(403, headers({ 'retry-after': '90' }), 'You have exceeded a secondary rate limit.');
    expect(e.kind).toBe('rate');
    expect(e.retryAfterMs).toBe(90_000);
    expect(e.message).toContain('短時間の連続した書き込み');
  });

  it('1 時間あたりの回数制限: リセット時刻まで待つ', () => {
    const now = 1_700_000_000_000;
    const e = classifyForbidden(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), 'API rate limit exceeded', now);
    expect(e.kind).toBe('rate');
    expect(e.retryAfterMs).toBe(600_000);
    expect(e.message).toContain('1 時間あたり');
  });

  it('429 も制限。待ち時間の指定がなければ 1 分。短すぎる/長すぎる指定は丸める', () => {
    expect(classifyForbidden(429, headers({}), '').retryAfterMs).toBe(60_000);
    expect(classifyForbidden(403, headers({ 'retry-after': '1' }), 'secondary rate limit').retryAfterMs).toBe(30_000);
    expect(classifyForbidden(403, headers({ 'retry-after': '999999' }), 'secondary rate limit').retryAfterMs).toBe(3_600_000);
  });

  it('制限ではない 403 は、トークンの権限の問題として案内する（待っても直らない）', () => {
    const e = classifyForbidden(403, headers({ 'x-ratelimit-remaining': '4990' }), 'Resource not accessible by personal access token');
    expect(e.kind).toBe('permission');
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.message).toContain('gist');
  });

  it('fetch の応答（本文・ヘッダー）から読み取る', async () => {
    const f = (async () =>
      new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), { status: 403, headers: { 'retry-after': '45' } })) as unknown as typeof fetch;
    const err = await pullGist('t', 'g', f).catch((e) => e);
    expect(err).toBeInstanceOf(GistError);
    expect(err).toMatchObject({ kind: 'rate', retryAfterMs: 45_000, status: 403 });
    const denied = (async () => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 })) as unknown as typeof fetch;
    expect(await pullGist('t', 'g', denied).catch((e) => e)).toMatchObject({ kind: 'permission' });
  });
});

describe('統合は順序に依らない（送り合いを防ぐ）', () => {
  const data = (text: string, updatedAt: number) => {
    const d = emptyData();
    d.interviews.push(createInterview({ id: 'i', createdAt: 1, updatedAt: 1 }));
    d.questions.push(createQuestion('i', { id: 'q', text, order: 1, createdAt: 1, updatedAt }));
    return d;
  };

  it('同じ updatedAt で内容が違っても、どちらの端末で統合しても同じ結果になる', () => {
    const a = data('スマホの版', 100);
    const b = data('PC の版（長い内容にしてある）', 100);
    expect(serialize(mergeData(a, b))).toBe(serialize(mergeData(b, a)));
    // 内容が多い方が残る（古い版の端末が項目を落としていても、新しい項目を持つ版が勝つ）
    const rich = data('同じ', 100);
    rich.questions[0] = { ...rich.questions[0], keyPoints: '要点あり' };
    const poor = data('同じ', 100);
    expect(mergeData(poor, rich).questions[0].keyPoints).toBe('要点あり');
    expect(mergeData(rich, poor).questions[0].keyPoints).toBe('要点あり');
  });

  it('統合した結果は、どちらの入力とも「送り合い」にならない（もう一度統合しても変わらない）', () => {
    const a = data('A', 100);
    const b = data('B', 100);
    const m = mergeData(a, b);
    expect(serialize(mergeData(m, a))).toBe(serialize(m));
    expect(serialize(mergeData(m, b))).toBe(serialize(m));
  });
});

describe('同期の制御（制限中の待機・送る間隔）', () => {
  type Sync = typeof import('../src/lib/sync');
  type Store = typeof import('../src/lib/store');
  let sync: Sync;
  let store: Store;
  let calls: { method: string }[];
  let remote: string | null;
  let respond: (method: string) => Response;

  const ok = (body: unknown = {}) => new Response(JSON.stringify(body), { status: 200 });
  const gistBody = () => ({ files: remote ? { [GIST_FILE]: { content: remote } } : {} });

  beforeEach(async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    vi.resetModules();
    calls = [];
    remote = null;
    respond = (method) => {
      if (method === 'PATCH') return ok();
      return ok(gistBody());
    };
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      calls.push({ method });
      const res = respond(method);
      if (method === 'PATCH' && res.ok) remote = JSON.parse(String(init.body)).files[GIST_FILE].content;
      return res;
    });
    store = await import('../src/lib/store');
    sync = await import('../src/lib/sync');
    store.updateSettings({ token: 'tok', gistId: 'gist1', autoSync: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('制限を受けたら、その間は GitHub に送らず、解除の頃に自動でやり直す', async () => {
    let limited = true;
    respond = (method) =>
      limited
        ? new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), { status: 403, headers: { 'retry-after': '90' } })
        : method === 'PATCH'
          ? ok()
          : ok(gistBody());

    await sync.syncNow();
    expect(calls).toHaveLength(1);
    const st = store.getState().sync;
    expect(st.status).toBe('error');
    expect(st.message).toContain('短時間の連続した書き込み');
    expect(st.message).toContain('自動でやり直します');
    expect(st.message).toContain('この端末に保存済み');

    // 連打しても（手動でも）通信しない
    await sync.syncNow();
    await sync.syncNow({ manual: true });
    expect(calls).toHaveLength(1);

    // 解除の時刻を過ぎると、自動でやり直して成功する
    limited = false;
    await vi.advanceTimersByTimeAsync(91_000);
    expect(calls.length).toBeGreaterThan(1);
    expect(store.getState().sync.status).toBe('idle');
  });

  it('権限の問題（制限ではない 403）は待たずに、原因を案内する', async () => {
    respond = () => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 });
    await sync.syncNow();
    expect(store.getState().sync.message).toContain('gist');
    expect(store.getState().sync.message).not.toContain('自動でやり直します');
    const before = calls.length;
    await sync.syncNow({ manual: true }); // 待つ必要はないので、すぐ再試行できる
    expect(calls.length).toBeGreaterThan(before);
  });

  it('送ったばかりのときは、間隔があくまで次を送らない（手動なら送る）', async () => {
    // 1 回目: リモートが空なので送る
    await sync.syncNow();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(store.getState().sync.status).toBe('idle');

    // すぐにまた変更 → 自動の同期は、取得だけして送るのは待つ
    store.addQuestion('x', { text: '新しい質問' });
    await sync.syncNow();
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(store.getState().sync.status).toBe('pending');

    // 間隔（30 秒）が過ぎると、自動で送られる
    await vi.advanceTimersByTimeAsync(sync.MIN_PUSH_GAP_MS + 1_000);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
    expect(store.getState().sync.status).toBe('idle');

    // 手動の同期は、間隔を待たずに送る
    store.addQuestion('x', { text: 'もう 1 つ' });
    await sync.syncNow({ manual: true });
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3);
  });

  it('編集が続いても、編集が止まるまで自動では送らない（予約をやり直す）', async () => {
    sync.scheduleSync();
    await vi.advanceTimersByTimeAsync(sync.AUTO_DELAY_MS - 1_000);
    sync.scheduleSync(); // 編集が続いた
    await vi.advanceTimersByTimeAsync(sync.AUTO_DELAY_MS - 1_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.length).toBeGreaterThan(0);
  });
});
