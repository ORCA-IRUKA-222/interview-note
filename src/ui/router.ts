import { useEffect, useState } from 'preact/hooks';

export type Route =
  | { name: 'home' }
  | { name: 'interview'; iid: string }
  | { name: 'question'; iid: string; qid: string; from?: string }
  | { name: 'study'; iid?: string; tag?: string }
  | { name: 'karaoke'; qid: string; src?: string }
  | { name: 'search'; q: string; tag?: string }
  | { name: 'stats'; iid?: string }
  | { name: 'settings' };

export const paths = {
  home: '#/',
  interview: (iid: string) => `#/i/${iid}`,
  /** from: リンクをたどって来たときの、元の質問の id（戻る印を出すため） */
  question: (iid: string, qid: string, from?: string) => `#/i/${iid}/q/${qid}${from ? `?from=${from}` : ''}`,
  study: (opts: { iid?: string; tag?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.iid) p.set('i', opts.iid);
    if (opts.tag) p.set('tag', opts.tag);
    const s = p.toString();
    return `#/study${s ? `?${s}` : ''}`;
  },
  /** src: 読み上げる文（'answer' / 'keyPoints' / 'alt:<サブの回答の id>'）。省略はメインの回答 */
  karaoke: (qid: string, src?: string) => `#/karaoke/${qid}${src ? `?src=${encodeURIComponent(src)}` : ''}`,
  search: (q = '', tag?: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (tag) p.set('tag', tag);
    const s = p.toString();
    return `#/search${s ? `?${s}` : ''}`;
  },
  settings: '#/settings',
  stats: (iid?: string) => (iid ? `#/stats?i=${iid}` : '#/stats'),
};

export function parseRoute(hash: string): Route {
  const [pathPart, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  const seg = pathPart.split('/').filter(Boolean);
  if (seg[0] === 'i' && seg[1]) {
    if (seg[2] === 'q' && seg[3]) return { name: 'question', iid: seg[1], qid: seg[3], from: params.get('from') ?? undefined };
    return { name: 'interview', iid: seg[1] };
  }
  if (seg[0] === 'study') return { name: 'study', iid: params.get('i') ?? undefined, tag: params.get('tag') ?? undefined };
  if (seg[0] === 'karaoke' && seg[1]) return { name: 'karaoke', qid: seg[1], src: params.get('src') ?? undefined };
  if (seg[0] === 'search') return { name: 'search', q: params.get('q') ?? '', tag: params.get('tag') ?? undefined };
  if (seg[0] === 'stats') return { name: 'stats', iid: params.get('i') ?? undefined };
  if (seg[0] === 'settings') return { name: 'settings' };
  return { name: 'home' };
}

export function go(path: string) {
  location.hash = path;
}

export function replace(path: string) {
  history.replaceState(null, '', path);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
