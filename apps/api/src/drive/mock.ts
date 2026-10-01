import { randomUUID } from "node:crypto";
import type { DocumentKind } from "@weaponx/shared";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as t from "../db/schema";
import { type Drive, DriveError, type DriveFile, driveFileUrl } from "./types";

/** ドライブの模擬(`DRIVE_MODE=mock`)。開発と E2E 専用で、本番では起動しない(02-01 5.10) */
export type MockDrive = Drive & {
  readonly mode: "mock";
  /** そのファイルを持つ版があるか(`grant` できるのは、そのようなファイルだけ。02-01 5.10) */
  hasFile(fileId: string): Promise<boolean>;
  /** ファイル選択画面で選んだことにして、そのファイルを `userId` が使えるようにする */
  grant(userId: string, fileId: string): void;
  /** 選んで使えるようにしたファイルをすべて忘れる(シードし直したとき) */
  reset(): void;
};

/**
 * 模擬のドライブ。ファイルの中身は DB の版から決める: Drive から資料名を取得できた版
 * (`metadata_fetched_at` がある)の資料名・種別・更新日時が、そのファイルのドライブでの値になる。
 * その版を登録した人は、そのファイルをアプリで使える(登録のときに Drive を読めたので)。
 * ほかの人が使えるのは、`grant` したファイルだけ。要再連携の利用者には認可エラーを返す。
 *
 * 使えるファイルを DB から導くので、シードし直しても API の再起動は要らない。
 * メモリに持つのは `grant` の分だけ(ADR-013 の例外。1台で動かす前提)。
 */
export function createMockDrive(db: Db): MockDrive {
  const granted = new Map<string, Set<string>>();

  /** 要再連携の利用者には認可エラーを返す(本物が返す 401 / `invalid_grant` と同じ扱い) */
  async function requireActive(userId: string): Promise<void> {
    const [connection] = await db
      .select({ status: t.driveConnections.status })
      .from(t.driveConnections)
      .where(eq(t.driveConnections.userId, userId));
    if (connection?.status !== "active") throw new DriveError("reauth");
  }

  /** そのファイルを Drive から取得できた版(新しく更新された順) */
  function fetchedVersions(fileId: string) {
    return db
      .select({
        name: t.documents.name,
        kind: t.documents.kind,
        sourceModifiedAt: t.documents.sourceModifiedAt,
        createdAt: t.documents.createdAt,
        registeredBy: t.documents.registeredBy,
      })
      .from(t.documents)
      .where(and(eq(t.documents.googleFileId, fileId), isNotNull(t.documents.metadataFetchedAt)))
      .orderBy(desc(t.documents.updatedAt), t.documents.id);
  }

  async function getFile(userId: string, fileId: string): Promise<DriveFile> {
    await requireActive(userId);
    const versions = await fetchedVersions(fileId);
    const file = versions[0];
    const usable =
      granted.get(userId)?.has(fileId) || versions.some((v) => v.registeredBy === userId);
    if (!file || !usable) throw new DriveError("not_accessible");
    return {
      fileId,
      name: file.name,
      kind: file.kind,
      modifiedAt: file.sourceModifiedAt ?? file.createdAt,
      url: driveFileUrl(fileId, file.kind),
    };
  }

  /** 作ったファイルは、登録された版から `getFile` が導く。ダミーのファイル ID は版ごとに新しい */
  function newFile(kind: DocumentKind, name: string): DriveFile {
    const fileId = `mock-${randomUUID().replaceAll("-", "")}`;
    return { fileId, name, kind, modifiedAt: new Date(), url: driveFileUrl(fileId, kind) };
  }

  return {
    mode: "mock",
    async hasFile(fileId) {
      return (await fetchedVersions(fileId).limit(1)).length > 0;
    },
    grant(userId, fileId) {
      const files = granted.get(userId) ?? new Set<string>();
      files.add(fileId);
      granted.set(userId, files);
    },
    reset() {
      granted.clear();
    },
    getFile,
    async createFile(userId, kind, name) {
      await requireActive(userId);
      return newFile(kind, name);
    },
    async copyFile(userId, sourceFileId, name) {
      const source = await getFile(userId, sourceFileId);
      return newFile(source.kind, name);
    },
    async issuePickerToken(userId) {
      await requireActive(userId);
      return { accessToken: "mock-picker-token", expiresAt: new Date(Date.now() + 60 * 60 * 1000) };
    },
  };
}

export function isMockDrive(drive: Drive): drive is MockDrive {
  return (drive as Partial<MockDrive>).mode === "mock";
}
