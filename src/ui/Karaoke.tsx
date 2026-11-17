import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ALIGNER_PRESETS, ScriptAligner } from '../lib/text/aligner';
import { boundaries, previousBoundary, sentenceEnd, sentenceStart } from '../lib/text/sentences';
import { SpeechBuffer } from '../lib/text/speechBuffer';
import { ContinuousRecognizer, speechSupported } from '../lib/speech';
import { altLabel } from '../lib/model';
import { updateSettings, useAppState } from '../lib/store';
import type { Sensitivity } from '../types';
import { caretOffset } from './common';
import { paths } from './router';

/** 読み上げる文: メインの回答 / 要点 / サブの回答（'alt:<id>'） */
type Source = 'answer' | 'keyPoints' | `alt:${string}`;

export function Karaoke({ qid, src }: { qid: string; src?: string }) {
  const { data, settings } = useAppState();
  const q = data.questions.find((x) => x.id === qid);
  const [source, setSource] = useState<Source>(src === 'keyPoints' || (src && src.startsWith('alt:')) ? (src as Source) : 'answer');
  const [running, setRunning] = useState(false);
  const [boundary, setBoundary] = useState(0);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState<string>('');
  const [mode, setMode] = useState<'voice' | 'timer'>('voice');
  const [brave, setBrave] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const supported = speechSupported();

  // Brave は音声認識に使う Google のサーバーへの通信を標準で止めており、シールドを切っても使えない。
  // 分かった時点で理由を伝え、最初からタイマーモードにする
  useEffect(() => {
    const b = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    b?.isBrave?.().then((yes) => {
      if (!yes) return;
      setBrave(true);
      setMode('timer');
    });
  }, []);

  const altIn = q && source.startsWith('alt:') ? q.alternatives.find((a) => a.id === source.slice(4)) : undefined;
  const text = q ? (source === 'keyPoints' ? q.keyPoints : altIn ? altIn.text : source.startsWith('alt:') ? '' : q.answer) : '';
  const cfg = settings.karaoke;

  const aligner = useRef<ScriptAligner | undefined>(undefined);
  const buffer = useRef(new SpeechBuffer());
  const recognizer = useRef<ContinuousRecognizer | undefined>(undefined);
  const lastSentence = useRef(-1);

  // 原稿・感度が変わったら作り直す（位置は元テキスト上の位置で引き継ぐ）
  useMemo(() => {
    const previous = aligner.current?.readBoundaryInSource() ?? 0;
    const a = new ScriptAligner(text, ALIGNER_PRESETS[cfg.sensitivity]);
    if (previous > 0 && aligner.current?.scriptText === text) a.seekToSource(previous);
    aligner.current = a;
    return a;
  }, [text, cfg.sensitivity]);

  const sync = () => setBoundary(aligner.current?.readBoundaryInSource() ?? 0);

  // 原稿を切り替えたときは、新しい aligner の位置に表示を合わせる
  useEffect(sync, [text, cfg.sensitivity]);

  useEffect(() => {
    recognizer.current = new ContinuousRecognizer(cfg.lang, {
      onPartial: (t) => {
        buffer.current.updatePartial(t);
        const a = aligner.current;
        if (a?.consume(buffer.current.current())) sync();
        setHeard(buffer.current.current().slice(-60));
      },
      onFinal: (t) => {
        buffer.current.commit(t);
        const a = aligner.current;
        if (a?.consume(buffer.current.current())) sync();
        setHeard(buffer.current.current().slice(-60));
      },
      onRunning: setRunning,
      onError: (message, code) => {
        setError(message);
        setErrorCode(code ?? '');
      },
    });
    return () => recognizer.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    recognizer.current?.setLang(cfg.lang);
  }, [cfg.lang]);

  // タイマーモード: 設定した速さ（1 秒あたりの文字数）で一定に進める。音声認識が使えない環境の代わり
  useEffect(() => {
    if (!running || mode !== 'timer') return;
    let acc = 0;
    const id = setInterval(() => {
      const a = aligner.current;
      if (!a || a.isFinished) {
        setRunning(false);
        return;
      }
      acc += cfg.speed * 0.1;
      const steps = Math.floor(acc);
      if (steps < 1) return;
      acc -= steps;
      a.cursor = Math.min(a.totalUnits, a.cursor + steps);
      sync();
      if (a.isFinished) setRunning(false);
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, mode, cfg.speed]);

  // 発表中に画面が消えないようにする
  useEffect(() => {
    if (!running) return;
    let lock: { release(): Promise<void> } | undefined;
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => void lock?.release().catch(() => undefined);
  }, [running]);

  const sentences = useMemo(() => boundaries(text), [text]);
  const finished = text.length > 0 && boundary >= text.length;
  const curStart = finished ? -1 : sentenceStart(sentences, boundary);
  const curEnd = finished ? -1 : sentenceEnd(sentences, boundary);

  useEffect(() => {
    if (!cfg.autoScroll || curStart === lastSentence.current) return;
    lastSentence.current = curStart;
    textRef.current?.querySelector('.k-cur')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [curStart, cfg.autoScroll]);

  const parts = useMemo(() => {
    const cuts = [...new Set([0, boundary, curStart, curEnd, text.length].filter((x) => x >= 0 && x <= text.length))].sort(
      (a, b) => a - b,
    );
    const out: { from: number; to: number; cls: string }[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      const read = to <= boundary;
      const cur = from >= curStart && to <= curEnd && curStart >= 0;
      out.push({ from, to, cls: `${read ? 'k-read' : 'k-unread'}${cur ? ' k-cur' : ''}` });
    }
    return out;
  }, [text, boundary, curStart, curEnd]);

  if (!q) {
    return (
      <main class="page">
        <div class="empty">質問が見つかりません。</div>
      </main>
    );
  }

  const seek = (sourceIndex: number) => {
    aligner.current?.seekToSource(sourceIndex);
    buffer.current.clear();
    setHeard('');
    lastSentence.current = -1;
    sync();
  };

  const toggle = () => {
    setError('');
    setErrorCode('');
    if (mode === 'timer') {
      setRunning(!running);
      return;
    }
    if (running) recognizer.current?.stop();
    else {
      buffer.current.clear();
      recognizer.current?.start();
    }
  };

  const switchMode = (next: 'voice' | 'timer') => {
    if (next === mode) return;
    recognizer.current?.stop();
    setRunning(false);
    setError('');
    setErrorCode('');
    setMode(next);
  };

  const progress = Math.round((aligner.current?.progress() ?? 0) * 100);
  const hasPoints = q.keyPoints.trim().length > 0;
  // 読み上げる文の選択肢: メインの回答、書いてあるサブの回答、要点
  const sources: { key: Source; label: string }[] = [
    { key: 'answer', label: '回答' },
    ...q.alternatives.flatMap((a, i) => (a.text.trim() ? [{ key: `alt:${a.id}` as Source, label: altLabel(a, i) }] : [])),
    ...(hasPoints ? [{ key: 'keyPoints' as Source, label: '要点' }] : []),
  ];

  return (
    <main class="page karaoke">
      <div class="page-head">
        <a class="btn back" href={paths.question(q.interviewId, q.id)}>
          ← 戻る
        </a>
        <h2 class="grow k-title">{q.text || '(質問未入力)'}</h2>
      </div>

      <div class="k-tools">
        <div class="seg" role="group" aria-label="進め方">
          <button type="button" class={mode === 'voice' ? 'on' : ''} onClick={() => switchMode('voice')}>
            🎤 音声で進める
          </button>
          <button type="button" class={mode === 'timer' ? 'on' : ''} onClick={() => switchMode('timer')}>
            ⏱ タイマーで進める
          </button>
        </div>
        {sources.length > 1 && (
          <div class="seg seg-wrap" role="group" aria-label="読み上げる文">
            {sources.map((s) => (
              <button type="button" key={s.key} class={source === s.key ? 'on' : ''} onClick={() => (setSource(s.key), seek(0))}>
                {s.label}
              </button>
            ))}
          </div>
        )}
        <label class="inline">
          感度
          <select
            value={cfg.sensitivity}
            onChange={(e) =>
              updateSettings({ karaoke: { ...cfg, sensitivity: Number((e.target as HTMLSelectElement).value) as Sensitivity } })
            }
          >
            <option value={0}>慎重</option>
            <option value={1}>標準</option>
            <option value={2}>敏感</option>
          </select>
        </label>
        <div class="inline">
          <button type="button" class="btn" aria-label="文字を小さく" onClick={() => updateSettings({ karaoke: { ...cfg, fontSize: Math.max(14, cfg.fontSize - 2) } })}>
            A−
          </button>
          <button type="button" class="btn" aria-label="文字を大きく" onClick={() => updateSettings({ karaoke: { ...cfg, fontSize: Math.min(56, cfg.fontSize + 2) } })}>
            A＋
          </button>
        </div>
        <label class="check">
          <input type="checkbox" checked={cfg.autoScroll} onChange={(e) => updateSettings({ karaoke: { ...cfg, autoScroll: (e.target as HTMLInputElement).checked } })} />
          自動スクロール
        </label>
      </div>

      {brave && (
        <div class="notice">
          <p>
            <strong>お使いの Brave では、音声で進める機能は使えません。</strong>
            Brave は、音声認識に使う Google のサーバーへの通信を標準で止めています（シールドをオフにしても同じです）。
            音声で進めたいときは <strong>Chrome か Edge</strong> で開いてください。このままでも「タイマーで進める」は使えます。
          </p>
          <div class="form-actions">
            {/Android/i.test(navigator.userAgent) && (
              <a
                class="btn"
                href={`intent://${location.host}${location.pathname}?r=${encodeURIComponent(location.hash.replace(/^#/, ''))}#Intent;scheme=https;package=com.android.chrome;end`}
              >
                Chrome で開く
              </a>
            )}
            <button
              type="button"
              class="btn"
              onClick={() => void navigator.clipboard?.writeText(location.href).catch(() => undefined)}
            >
              この画面の URL をコピー
            </button>
          </div>
        </div>
      )}
      {mode === 'voice' && !supported && (
        <p class="notice">
          このブラウザは音声認識に対応していません。Chrome / Edge（PC・Android）でお試しいただくか、「タイマーで進める」を使ってください。
        </p>
      )}
      {mode === 'timer' && (
        <div class="k-speed">
          <span class="small">速さ</span>
          <button type="button" class="btn" aria-label="遅くする" onClick={() => updateSettings({ karaoke: { ...cfg, speed: Math.max(2, cfg.speed - 1) } })}>
            −
          </button>
          <strong>{cfg.speed} 文字/秒</strong>
          <button type="button" class="btn" aria-label="速くする" onClick={() => updateSettings({ karaoke: { ...cfg, speed: Math.min(14, cfg.speed + 1) } })}>
            ＋
          </button>
          <span class="muted small">（約 {cfg.speed * 60} 文字/分。ゆっくり話すなら 4〜5、早口なら 7 以上）</span>
        </div>
      )}
      {error && mode === 'voice' && (
        <div class="notice error">
          <p>{error}</p>
          {errorCode === 'network' && (
            <>
              <p class="small">
                音声認識は、ブラウザが Google の音声認識サーバーに音声を送って行います。届かない主な原因は次のとおりです。
              </p>
              <ul class="small">
                <li>通信が不安定、または VPN・プライベート DNS・広告ブロックなどで Google への通信が止められている（Wi-Fi とモバイル回線を切り替えて試す）</li>
                <li>Android: 設定 → アプリ →「Google」を開き、マイクの権限と更新を確認する。Gboard の音声入力が動くかも目安になる</li>
                <li>Chrome / Edge 以外のブラウザ（Brave・Firefox・アプリ内ブラウザなど）は、音声認識が使えないことがある</li>
              </ul>
            </>
          )}
          <button type="button" class="btn" onClick={() => switchMode('timer')}>
            ⏱ 音声を使わず、タイマーで進める
          </button>
        </div>
      )}

      {text.trim() ? (
        <div
          class="k-text"
          ref={textRef}
          style={{ fontSize: `${cfg.fontSize}px` }}
          onClick={() => {
            const offset = textRef.current ? caretOffset(textRef.current) : null;
            if (offset !== null) seek(offset);
          }}
        >
          {parts.map((p) => (
            <span key={p.from} class={p.cls}>
              {text.slice(p.from, p.to)}
            </span>
          ))}
        </div>
      ) : (
        <div class="empty">読み上げる{source === 'keyPoints' ? '要点' : source.startsWith('alt:') ? 'サブの回答' : '回答'}がありません。</div>
      )}

      <div class="k-dock">
        <div class="k-progress">
          <span class="bar">
            <span style={{ width: `${progress}%` }} />
          </span>
          <span class="small">{finished ? '読み終わり 🎉' : `${progress}%`}</span>
          {running && mode === 'voice' && heard && <span class="heard muted small">🎙 {heard}</span>}
        </div>
        <div class="k-controls">
          <button type="button" class="btn" aria-label="1 文戻る" onClick={() => seek(previousBoundary(sentences, boundary))}>
            ◀ 文
          </button>
          <button type="button" class={`btn big ${running ? 'danger' : 'primary'}`} disabled={(mode === 'voice' && !supported) || !text.trim()} onClick={toggle}>
            {running ? '■ 一時停止' : mode === 'timer' ? '▶ 開始' : '🎤 開始'}
          </button>
          <button type="button" class="btn" aria-label="1 文進む" onClick={() => seek(sentenceEnd(sentences, boundary))}>
            文 ▶
          </button>
          <button type="button" class="btn" aria-label="最初に戻す" onClick={() => seek(0)}>
            ↺
          </button>
        </div>
        <p class="muted small center">読み始めたい位置をタップすると、そこまで読んだことになります。</p>
      </div>
    </main>
  );
}
