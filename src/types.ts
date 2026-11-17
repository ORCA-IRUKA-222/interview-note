/** 回答テキスト内の選択範囲（UTF-16 のオフセット）。深掘り質問の「根っこ」を表す */
export interface Anchor {
  start: number;
  end: number;
  /** 作成時点の引用テキスト。回答を編集して位置がずれたときの再探索に使う */
  quote: string;
  /** 回答の編集で引用が見つからなくなったら true */
  broken?: boolean;
}

/** 回答の一部(段落・選択範囲)に付けた内容タグ。全体での占有率の集計に使う */
export interface Mark {
  id: string;
  start: number;
  end: number;
  quote: string;
  tag: string;
  broken?: boolean;
}

/**
 * 回答の一部から、別の質問（トップの質問でも深掘りでも、別の面接のものでも）へ張るリンク。
 * 深掘り（親子の関係）とは別の、参照の関係。同じ質問を何か所から参照してもよい。
 */
export interface Link {
  id: string;
  start: number;
  end: number;
  quote: string;
  /** リンク先の質問 */
  targetId: string;
  broken?: boolean;
}

export type Status = 'todo' | 'draft' | 'done';

/** 単語帳（フラッシュカード）の学習状態 */
export interface CardState {
  /** 0..4 のライトナー箱 */
  box: number;
  /** 次回出題日 (YYYY-MM-DD)。null は未学習 */
  due: string | null;
  seen: number;
}

export interface Question {
  id: string;
  interviewId: string;
  /** 深掘り元の質問。ルート質問は null */
  parentId: string | null;
  /** 深掘り元の回答のどこから派生したか */
  anchor: Anchor | null;
  text: string;
  answer: string;
  /** 話す内容の要点（単語帳の裏面に出る。1 行 1 項目） */
  keyPoints: string;
  tags: string[];
  /** 回答の中身に付けた内容タグ */
  marks: Mark[];
  /** 回答の中から他の質問へのリンク */
  links: Link[];
  status: Status;
  order: number;
  card: CardState;
  createdAt: number;
  updatedAt: number;
}

export type Stage = 'preparing' | 'done';

export interface Interview {
  id: string;
  /** 'common' は全面接から参照できる「共通」の親。会社ごとの面接はその下に並ぶ */
  kind?: 'common';
  title: string;
  company: string;
  /** YYYY-MM-DD または空 */
  date: string;
  stage: Stage;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** Gist に保存する全データ */
export interface Data {
  version: 1;
  interviews: Interview[];
  questions: Question[];
  /** 削除の墓標 (id → 削除時刻)。端末間で削除を伝えるために保持する */
  deleted: Record<string, number>;
}

export type Sensitivity = 0 | 1 | 2;

export interface Settings {
  token: string;
  gistId: string;
  autoSync: boolean;
  karaoke: {
    sensitivity: Sensitivity;
    fontSize: number;
    lang: string;
    autoScroll: boolean;
    /** タイマー進行の速さ（1 秒あたりの文字数） */
    speed: number;
  };
}
