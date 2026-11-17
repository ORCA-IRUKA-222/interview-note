import type { Data } from '../types';
import { parseData, serialize } from './merge';

const API = 'https://api.github.com';
export const GIST_FILE = 'interview-qa.json';

export type GistErrorKind = 'network' | 'auth' | 'permission' | 'rate' | 'notfound' | 'other';

export class GistError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: GistErrorKind = 'other',
    /** kind が 'rate' のとき: この時間（ミリ秒）は GitHub に送らずに待つ */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;

const DEFAULT_RATE_WAIT_MS = 60_000;

/**
 * GitHub の 403 / 429 を、原因ごとに見分ける。
 *  - 1 時間あたりの回数の上限（x-ratelimit-remaining が 0）… リセット時刻まで待つ
 *  - 短時間の連続した書き込みの制限（secondary rate limit。retry-after が付く）… 指定の秒数だけ待つ
 *  - それ以外の 403 … トークンに gist の権限がない、など。待っても直らない
 */
export function classifyForbidden(status: number, headers: { get(name: string): string | null }, message: string, now = Date.now()): GistError {
  const retryAfter = Number(headers.get('retry-after'));
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = Number(headers.get('x-ratelimit-reset'));
  const primary = remaining === '0';
  const secondary = /secondary rate limit|abuse detection/i.test(message) || (retryAfter > 0 && !primary);
  const rate = status === 429 || primary || secondary || /rate limit/i.test(message);

  if (!rate) {
    return new GistError(
      'GitHub がこのトークンでの操作を許可していません。トークンに「gist」の権限があるか確認してください（作り直すときに gist にチェック）',
      status,
      'permission',
    );
  }
  let waitMs = DEFAULT_RATE_WAIT_MS;
  if (retryAfter > 0) waitMs = retryAfter * 1000;
  else if (primary && reset > 0) waitMs = Math.max(0, reset * 1000 - now);
  // 待ち時間が極端なときも、短すぎず長すぎないように丸める
  waitMs = Math.min(Math.max(waitMs, 30_000), 60 * 60_000);
  const kindText = primary ? 'GitHub の 1 時間あたりの回数制限に達しました' : 'GitHub が短時間の連続した書き込みを制限しています';
  return new GistError(kindText, status, 'rate', waitMs);
}

async function request(f: Fetch, token: string, path: string, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await f(`${API}${path}`, {
      ...init,
      // GitHub は GET を 60 秒キャッシュさせるため、別端末の更新を見逃さないよう無効化する
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new GistError('ネットワークに接続できません', undefined, 'network');
  }
  if (res.ok) return res;
  if (res.status === 401) throw new GistError('トークンが無効です（再発行して設定し直してください）', 401, 'auth');
  if (res.status === 403 || res.status === 429) {
    let message = '';
    try {
      const text = await res.text();
      try {
        message = String(JSON.parse(text)?.message ?? '');
      } catch {
        message = text;
      }
    } catch {
      /* 本文が読めなくても、ヘッダーから判断する */
    }
    throw classifyForbidden(res.status, res.headers, message);
  }
  if (res.status === 404) throw new GistError('Gist が見つかりません（ID またはトークンの gist 権限を確認）', 404, 'notfound');
  throw new GistError(`GitHub API エラー (${res.status})`, res.status);
}

/** Gist のデータを取得する。Gist にファイルがまだ無い場合は null */
export async function pullGist(token: string, id: string, f: Fetch = fetch): Promise<Data | null> {
  const res = await request(f, token, `/gists/${encodeURIComponent(id)}`);
  const gist = await res.json();
  const file = gist?.files?.[GIST_FILE];
  if (!file) return null;
  let content: string = file.content ?? '';
  if (file.truncated && file.raw_url) {
    const raw = await f(file.raw_url, { cache: 'no-store' });
    if (!raw.ok) throw new GistError(`Gist の本文を取得できません (${raw.status})`, raw.status);
    content = await raw.text();
  }
  try {
    return parseData(JSON.parse(content));
  } catch (e) {
    throw new GistError(`Gist の内容が読めません: ${(e as Error).message}`);
  }
}

export async function createGist(token: string, data: Data, f: Fetch = fetch): Promise<string> {
  const res = await request(f, token, '/gists', {
    method: 'POST',
    body: JSON.stringify({
      description: '面接ノート (interview-note) のデータ',
      public: false,
      files: { [GIST_FILE]: { content: serialize(data) } },
    }),
  });
  const gist = await res.json();
  if (!gist?.id) throw new GistError('Gist の作成に失敗しました');
  return gist.id as string;
}

export async function pushGist(token: string, id: string, data: Data, f: Fetch = fetch): Promise<void> {
  await request(f, token, `/gists/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ files: { [GIST_FILE]: { content: serialize(data) } } }),
  });
}
