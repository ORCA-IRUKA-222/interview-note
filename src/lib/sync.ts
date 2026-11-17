import { applyRemoteMerge, getState, markClean, setDataChangeHandler, setSyncState, updateSettings } from './store';
import { createGist, GistError, pullGist, pushGist } from './gist';
import { mergeData, serialize } from './merge';

let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
/** ローカルで編集した回数。同期の通信中に編集があったかを知るために使う */
let localEdits = 0;

/** 編集が止まってから、自動で送るまでの待ち */
export const AUTO_DELAY_MS = 8_000;
/** 自動で送る（書き込む）間隔の下限。GitHub の「短時間の連続した書き込み」の制限に当たらないようにする */
export const MIN_PUSH_GAP_MS = 30_000;

/** GitHub から「待って」と言われている間は、何も送らない。この時刻まで待つ */
let blockedUntil = 0;
/** 待っている理由（画面に出す文言） */
let blockedReason = 'GitHub の制限のため';
let lastPushAt = 0;

const clock = (ms: number) => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

function blockedMessage(): string {
  return `${blockedReason}。${clock(blockedUntil)}ごろに自動でやり直します。変更はこの端末に保存済みです`;
}

/**
 * Gist との同期（pull → 統合 → 差分があれば push）。
 * 端末間の競合は id 単位の updatedAt 比較で自動統合するので、選択ダイアログは出ない。
 *
 * GitHub から利用制限を受けている間は通信せず、解除の見込み時刻まで待つ（連打して制限を長引かせない）。
 * manual: 「今すぐ同期」ボタンからの呼び出し。送る間隔の下限は無視するが、GitHub の制限中は待つ。
 */
export function syncNow(opts: { manual?: boolean } = {}): Promise<void> {
  if (running) return running;
  const wait = blockedUntil - Date.now();
  if (wait > 0) {
    setSyncState({ status: 'error', message: blockedMessage() });
    scheduleSync(wait);
    return Promise.resolve();
  }
  running = doSync(!!opts.manual).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(manual: boolean) {
  clearTimeout(timer);
  const { token, gistId } = getState().settings;
  if (!token) return;

  setSyncState({ status: 'syncing', message: '' });
  const editsAtStart = localEdits;
  try {
    if (!gistId) {
      const id = await createGist(token, getState().data);
      lastPushAt = Date.now();
      updateSettings({ gistId: id });
    } else {
      const remote = await pullGist(token, gistId);
      if (remote) applyRemoteMerge(remote);
      const merged = getState().data;
      const needsPush = !remote || serialize(mergeData(merged, remote)) !== serialize(remote);
      if (needsPush) {
        // 直前に送ったばかりなら、間隔があくまで送るのを待つ（手動のときは待たない）
        const gap = lastPushAt + MIN_PUSH_GAP_MS - Date.now();
        if (!manual && gap > 0) {
          setSyncState({ status: 'pending', message: '' });
          scheduleSync(gap);
          return;
        }
        await pushGist(token, gistId, merged);
        lastPushAt = Date.now();
      }
    }
    // 通信中に編集があった場合は未送信のまま残し、もう一度同期する
    const editedDuringSync = localEdits !== editsAtStart;
    if (!editedDuringSync) markClean();
    setSyncState({ status: editedDuringSync ? 'pending' : 'idle', message: '', lastSyncedAt: Date.now() });
    if (editedDuringSync) scheduleSync();
  } catch (e) {
    if (e instanceof GistError && e.kind === 'rate') {
      blockedUntil = Date.now() + (e.retryAfterMs ?? 60_000);
      blockedReason = e.message;
      setSyncState({ status: 'error', message: blockedMessage() });
      scheduleSync(blockedUntil - Date.now());
      return;
    }
    setSyncState({ status: 'error', message: e instanceof GistError ? e.message : '同期に失敗しました' });
  }
}

/** 自動同期を予約する。delay を省くと、編集が止まってから AUTO_DELAY_MS 後。制限中・送信間隔の待ちも考慮する */
export function scheduleSync(delay: number = AUTO_DELAY_MS) {
  const { token, autoSync } = getState().settings;
  if (!token || !autoSync) return;
  clearTimeout(timer);
  const untilUnblocked = blockedUntil - Date.now();
  timer = setTimeout(() => void syncNow(), Math.max(delay, untilUnblocked, 0));
}

export function initSync() {
  setDataChangeHandler(() => {
    localEdits++;
    scheduleSync();
  });
  const kick = () => {
    const { token, autoSync } = getState().settings;
    if (token && autoSync) void syncNow();
  };
  // 起動時・タブやアプリに戻ったとき・回線が復帰したときに同期する
  kick();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kick();
  });
  window.addEventListener('online', kick);
  // 開きっぱなしのタブでも、別端末の編集が 2 分ほどで届くようにする
  setInterval(() => {
    if (document.visibilityState === 'visible') kick();
  }, 120_000);
}
