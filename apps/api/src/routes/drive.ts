import { isDriveFileId, parseDriveLink, validateUrl } from "@weaponx/shared";
import { Elysia, t } from "elysia";
import { authenticated } from "../auth/session";
import { getDriveFile, issuePickerToken } from "../domain/drive";
import { isMockDrive, type MockDrive } from "../drive";
import type { AppDeps } from "../lib/deps";
import { AppError, validationFailed } from "../lib/errors";

function fileIdFromUrl(raw: string): string {
  const checked = validateUrl(raw);
  if (!checked.ok) throw validationFailed({ url: checked.error });
  const link = parseDriveLink(checked.value);
  // ドライブの資料でない URL からは、ファイル ID を取り出せない
  if (!link) throw validationFailed({ url: "invalid_url" });
  return link.googleFileId;
}

function fileIdFromBody(fileId: string): string {
  if (!isDriveFileId(fileId)) throw validationFailed({ fileId: "invalid_format" });
  return fileId;
}

/** ドライブの情報取得(02-01 5.7) */
export function driveRoutes(deps: AppDeps) {
  return new Elysia({ prefix: "/drive" })
    .use(authenticated(deps))
    .post(
      "/file-info",
      async ({ auth, body }) => {
        const { url, fileId: givenFileId } = body;
        if ((url === undefined) === (givenFileId === undefined)) {
          throw validationFailed({ [url === undefined ? "url" : "fileId"]: "invalid_format" });
        }
        const fileId = url !== undefined ? fileIdFromUrl(url) : fileIdFromBody(givenFileId ?? "");
        const file = await getDriveFile(deps, auth.user.id, fileId);
        return {
          fileId: file.fileId,
          url: file.url,
          name: file.name,
          kind: file.kind,
          modifiedAt: file.modifiedAt.toISOString(),
        };
      },
      { body: t.Object({ url: t.Optional(t.String()), fileId: t.Optional(t.String()) }) },
    )
    .post("/picker-token", async ({ auth, set }) => {
      // 短命でも認可の道具なので、どこにも保存させない(02-01 7章)
      set.headers["cache-control"] = "no-store";
      return issuePickerToken(deps, auth.user.id);
    });
}

function grantRoutes(mock: MockDrive, deps: AppDeps) {
  return new Elysia({ prefix: "/dev/drive" })
    .use(authenticated(deps))
    .get("/files", async () => ({ files: await mock.listFiles() }))
    .post(
      "/grant",
      async ({ auth, body, set }) => {
        if (!isDriveFileId(body.fileId)) throw validationFailed({ fileId: "invalid_format" });
        // 模擬が値を返せるのは、その版がある(取得済みの)ファイルだけ
        if (!(await mock.hasFile(body.fileId))) throw new AppError("NOT_FOUND");
        mock.grant(auth.user.id, body.fileId);
        set.status = 204;
      },
      { body: t.Object({ fileId: t.String() }) },
    );
}

/**
 * ドライブの模擬のファイル選択画面で選んだことにする(02-01 5.10)。`DRIVE_MODE=mock` のときだけ
 * ルートを登録する。画面の Eden が型を得られるよう、型は常に含め、無効なときは空のプラグインを返す。
 */
export function devDriveRoutes(deps: AppDeps) {
  const { drive, config } = deps;
  if (config.driveMode === "mock" && isMockDrive(drive)) return grantRoutes(drive, deps);
  return new Elysia({ prefix: "/dev/drive" }) as unknown as ReturnType<typeof grantRoutes>;
}
