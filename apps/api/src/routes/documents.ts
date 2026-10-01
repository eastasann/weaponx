import { LIMITS } from "@weaponx/shared";
import { Elysia, t } from "elysia";
import { authenticated } from "../auth/session";
import { requireDocumentAccess } from "../domain/access";
import {
  deleteDocument,
  registerDocument,
  registerVersion,
  updateDocument,
} from "../domain/documents";
import { documentDriveAccess } from "../domain/drive";
import { copyDocument, copyVersion, createDocument } from "../domain/drive-create";
import { refreshMetadata } from "../domain/metadata";
import { requireProjectRole } from "../domain/projects";
import { listReferenceCandidates, listTagCandidates, searchDocuments } from "../domain/search";
import { getSeriesDetail, listSeriesRows } from "../domain/series";
import type { AppDeps } from "../lib/deps";
import { isUuid } from "../lib/errors";
import { FieldCollector } from "../lib/fields";

const Kind = t.Union([
  t.Literal("google_doc"),
  t.Literal("google_slides"),
  t.Literal("google_sheets"),
  t.Literal("pdf"),
  t.Literal("other"),
]);
const Nullable = <T extends ReturnType<typeof t.String>>(schema: T) => t.Union([schema, t.Null()]);

const ProjectParams = t.Object({ projectId: t.String() });
const SeriesParams = t.Object({ seriesId: t.String() });
const DocumentParams = t.Object({ documentId: t.String() });

const RegisterBody = t.Object({
  url: t.String(),
  name: t.Optional(t.String()),
  kind: Kind,
  sourceModifiedAt: t.Optional(Nullable(t.String())),
  referenceIds: t.Optional(t.Array(t.String())),
});
const VersionBody = t.Composite([
  RegisterBody,
  t.Object({
    changeNote: t.Optional(Nullable(t.String())),
    hiddenReferenceIds: t.Optional(t.Array(t.String())),
  }),
]);
const NewDocumentBody = t.Object({
  kind: t.String(),
  name: t.String(),
  referenceIds: t.Optional(t.Array(t.String())),
});
const CopyVersionBody = t.Object({
  sourceDocumentId: t.String(),
  name: t.String(),
  changeNote: t.Optional(Nullable(t.String())),
});
const CopyDocumentBody = t.Object({ targetProjectId: t.String(), name: t.String() });
const UpdateBody = t.Object({
  url: t.Optional(t.String()),
  kind: t.Optional(Kind),
  name: t.Optional(t.String()),
  sourceModifiedAt: t.Optional(Nullable(t.String())),
  changeNote: t.Optional(Nullable(t.String())),
  tags: t.Optional(t.Array(t.String())),
  referenceIds: t.Optional(t.Array(t.String())),
  hiddenReferenceIds: t.Optional(t.Array(t.String())),
});

/** 検索語と候補の語(入力の検証は認可の後。02-01 7章の判定の順) */
function searchTerm(raw: string | undefined, required: boolean): string {
  const fields = new FieldCollector();
  const q = fields.text("q", raw ?? "", { max: LIMITS.searchQuery, required });
  fields.done();
  return q;
}

/** 資料(系列と版)・検索・候補(02-01 5.5・5.6) */
export function documentRoutes(deps: AppDeps) {
  const { db } = deps;
  return new Elysia()
    .use(authenticated(deps))
    .get(
      "/projects/:projectId/series",
      async ({ auth, params }) => {
        await requireProjectRole(db, auth.user.id, params.projectId, "viewer");
        return { series: await listSeriesRows(db, params.projectId) };
      },
      { params: ProjectParams },
    )
    .get(
      "/projects/:projectId/tags",
      async ({ auth, params, query }) => {
        await requireProjectRole(db, auth.user.id, params.projectId, "viewer");
        return {
          tags: await listTagCandidates(
            db,
            auth.user.id,
            params.projectId,
            searchTerm(query.q, false),
          ),
        };
      },
      { params: ProjectParams, query: t.Object({ q: t.Optional(t.String()) }) },
    )
    .post(
      "/projects/:projectId/documents",
      async ({ auth, params, body, set }) => {
        const result = await registerDocument(deps, auth.user.id, params.projectId, body);
        set.status = 201;
        return result;
      },
      { params: ProjectParams, body: RegisterBody },
    )
    .post(
      "/projects/:projectId/documents/new",
      async ({ auth, params, body, set }) => {
        const result = await createDocument(deps, auth.user.id, params.projectId, body);
        set.status = 201;
        return result;
      },
      { params: ProjectParams, body: NewDocumentBody },
    )
    .post(
      "/projects/:projectId/metadata-refresh",
      async ({ auth, params }) => refreshMetadata(deps, auth.user.id, params.projectId),
      { params: ProjectParams },
    )
    .get(
      "/series/:seriesId",
      async ({ auth, params, query }) =>
        getSeriesDetail(db, auth.user.id, params.seriesId, query.documentId),
      { params: SeriesParams, query: t.Object({ documentId: t.Optional(t.String()) }) },
    )
    .post(
      "/series/:seriesId/versions",
      async ({ auth, params, body, set }) => {
        const result = await registerVersion(deps, auth.user.id, params.seriesId, body);
        set.status = 201;
        return result;
      },
      { params: SeriesParams, body: VersionBody },
    )
    .post(
      "/series/:seriesId/versions/copy",
      async ({ auth, params, body, set }) => {
        const result = await copyVersion(deps, auth.user.id, params.seriesId, body);
        set.status = 201;
        return result;
      },
      { params: SeriesParams, body: CopyVersionBody },
    )
    .post(
      "/documents/:documentId/copies",
      async ({ auth, params, body, set }) => {
        const result = await copyDocument(deps, auth.user.id, params.documentId, body);
        set.status = 201;
        return result;
      },
      { params: DocumentParams, body: CopyDocumentBody },
    )
    .get(
      "/documents/:documentId/drive-access",
      async ({ auth, params }) => {
        const access = await requireDocumentAccess(db, auth.user.id, params.documentId, "editor");
        return documentDriveAccess(deps, auth.user.id, access.documentId);
      },
      { params: DocumentParams },
    )
    .patch(
      "/documents/:documentId",
      async ({ auth, params, body }) => updateDocument(deps, auth.user.id, params.documentId, body),
      { params: DocumentParams, body: UpdateBody },
    )
    .delete(
      "/documents/:documentId",
      async ({ auth, params }) => deleteDocument(db, auth.user.id, params.documentId),
      { params: DocumentParams },
    )
    .get(
      "/search",
      async ({ auth, query }) => searchDocuments(db, auth.user.id, searchTerm(query.q, true)),
      { query: t.Object({ q: t.String() }) },
    )
    .get(
      "/reference-candidates",
      async ({ auth, query }) => {
        const q = searchTerm(query.q, false);
        const fields = new FieldCollector();
        if (query.excludeSeriesId !== undefined && !isUuid(query.excludeSeriesId)) {
          fields.reject("excludeSeriesId", "invalid_format");
        }
        fields.done();
        return {
          candidates: await listReferenceCandidates(db, auth.user.id, q, query.excludeSeriesId),
        };
      },
      { query: t.Object({ q: t.Optional(t.String()), excludeSeriesId: t.Optional(t.String()) }) },
    );
}
