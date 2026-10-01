import type { DocumentKind } from "@weaponx/shared";

/** ドライブから取れる、ファイル1つの情報 */
export type DriveFile = {
  fileId: string;
  name: string;
  kind: DocumentKind;
  modifiedAt: Date;
  /** ファイルを開く URL(Google の形式) */
  url: string;
};

/**
 * ドライブの呼び出しの失敗の区分(02-01 8章「Drive の応答の分け方」)。
 * - `reauth`: 認可エラー(認可情報が無効・取り消された・範囲不足)。連携を要再連携にする
 * - `not_accessible`: アプリがまだ使えない・見る権限が無いファイル。2つは見分けられない
 * - `unavailable`: レート制限・5xx を再試行してもだめだった。要再連携にしない
 */
export type DriveFailure = "reauth" | "not_accessible" | "unavailable";

export class DriveError extends Error {
  constructor(
    readonly reason: DriveFailure,
    options?: { cause?: unknown },
  ) {
    super(`Drive request failed: ${reason}`, options);
  }
}

/**
 * ドライブへの呼び出し。本物(Google)と模擬が同じインターフェースを実装する(02-01 5.10)。
 * 利用者の連携の状態の判定と、失敗をエラーコードにする処理は `domain/drive.ts` が持つ。
 */
export interface Drive {
  /** `userId` のアプリが使えるファイルの情報を返す。失敗は `DriveError` */
  getFile(userId: string, fileId: string): Promise<DriveFile>;
  /** `userId` のマイドライブ直下に空のドキュメント・スライドを作る。失敗は `DriveError` */
  createFile(userId: string, kind: CreatableKind, name: string): Promise<DriveFile>;
  /**
   * `sourceFileId` を `userId` のマイドライブ直下にコピーする。元のファイルをアプリが使えない・
   * 見つからないときは `not_accessible`。失敗は `DriveError`
   */
  copyFile(userId: string, sourceFileId: string, name: string): Promise<DriveFile>;
  /** Picker 用の短命のアクセストークン(範囲は `drive.file` だけ)。失敗は `DriveError` */
  issuePickerToken(userId: string): Promise<PickerToken>;
}

/** アプリが Drive で新しく作れる種別(design-spec 6.2) */
export type CreatableKind = Extract<DocumentKind, "google_doc" | "google_slides">;

export type PickerToken = { accessToken: string; expiresAt: Date };

/** Google の形式でファイルを開く URL。ドキュメント・スライド・スプレッドシート以外は drive.google.com */
export function driveFileUrl(fileId: string, kind: DocumentKind): string {
  switch (kind) {
    case "google_doc":
      return `https://docs.google.com/document/d/${fileId}/edit`;
    case "google_slides":
      return `https://docs.google.com/presentation/d/${fileId}/edit`;
    case "google_sheets":
      return `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
    default:
      return `https://drive.google.com/file/d/${fileId}/view`;
  }
}
