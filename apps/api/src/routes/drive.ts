import { isDriveFileId, parseDriveLink, validateUrl } from "@weaponx/shared";
import { Elysia, t } from "elysia";
import { authenticated } from "../auth/session";
import { getDriveFile } from "../domain/drive";
import type { AppDeps } from "../lib/deps";
import { validationFailed } from "../lib/errors";

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
  return new Elysia({ prefix: "/drive" }).use(authenticated(deps)).post(
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
  );
}
