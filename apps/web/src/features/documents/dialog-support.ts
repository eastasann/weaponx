import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNotify } from "../../components/Toast";
import { describeError, toApiError } from "../../lib/errors";
import type { RelatedItem } from "../../lib/queries";
import { applyDriveStatus, closesDialog, unavailableReferenceIds } from "./failure";
import type { ReferenceChip } from "./ReferencePicker";

/** 種別・日付の選択欄の見た目 */
export const SELECT =
  "typography-body h-[var(--size-control)] rounded-[var(--radius-control)] border border-border-strong bg-surface px-[var(--space-inline-gap)] text-text disabled:opacity-60";

/** 今日の日付(ブラウザのタイムゾーン)。未来の日付を選べなくする上限 */
export function today(): string {
  return toDateInput(new Date());
}

function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 日付ピッカーの値を、ブラウザのタイムゾーンの0時として UTC の日時にする(design-spec 6.2) */
export function dateToIso(date: string): string | null {
  return date ? new Date(`${date}T00:00:00`).toISOString() : null;
}

/** 保存済みの更新日時を日付ピッカーの値(ブラウザのタイムゾーンの日付)にする */
export function isoToDate(iso: string | null): string {
  return iso ? toDateInput(new Date(iso)) : "";
}

/** 参考資料の一覧(`RelatedItem`)を、ダイアログのチップにする */
export function chipsFromRelated(items: RelatedItem[]): ReferenceChip[] {
  return items.map((item, index): ReferenceChip => {
    if (item.visibility === "visible") {
      return {
        key: item.documentId,
        visibility: "visible",
        documentId: item.documentId,
        name: item.name,
        kind: item.kind,
        projectName: item.projectName,
      };
    }
    return {
      key: `hidden:${item.referenceId ?? index}`,
      visibility: item.visibility,
      ...(item.referenceId ? { referenceId: item.referenceId } : {}),
    };
  });
}

/** 案件の表と横パネルを取り直す */
export function useReload() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ["projects"] });
    await queryClient.invalidateQueries({ queryKey: ["series"] });
  };
}

/** 失敗を見て、ダイアログを閉じるべきなら閉じて一覧を読み込み直す(design-spec 6.0.2) */
export function useCloseOnFailure(onClose: () => void) {
  const reload = useReload();
  const notify = useNotify();
  const { t } = useTranslation();
  return async (error: unknown): Promise<boolean> => {
    if (!closesDialog(error)) return false;
    onClose();
    await reload();
    const { code, messageKey } = describeError(error);
    if (code !== "PROJECT_NOT_FOUND") {
      notify({ kind: "error", message: t(messageKey), requestId: toApiError(error).requestId });
    }
    return true;
  };
}

/**
 * 登録・作成・編集が終わったあとの共通の動き: 連携の状態を反映し、一覧を取り直してダイアログを閉じる。
 * 新しい行を選ぶ呼び出し側は、これが終わってから選ぶ(まだ表に無い系列を選ぶと「見つからない」になる)
 */
export function useFinish(onClose: () => void) {
  const queryClient = useQueryClient();
  const reload = useReload();
  return async (driveStatus?: "active" | "needs_reauth") => {
    if (driveStatus) applyDriveStatus(queryClient, driveStatus);
    await reload();
    onClose();
  };
}

/** ダイアログの参考資料のチップと、その検証エラー(design-spec 6.0.3) */
export function useReferences(initial: ReferenceChip[]) {
  const { t } = useTranslation();
  const [references, setReferences] = useState<ReferenceChip[]>(initial);
  const [error, setError] = useState<string | undefined>();

  const referenceIds = references.flatMap((chip) =>
    chip.visibility === "visible" ? [chip.documentId] : [],
  );
  const hiddenReferenceIds = references.flatMap((chip) =>
    chip.visibility !== "visible" && chip.referenceId ? [chip.referenceId] : [],
  );

  /** `REFERENCE_UNAVAILABLE` なら該当のチップを外して理由を出す。外したら true */
  const removeUnavailable = (failure: unknown) => {
    const gone = unavailableReferenceIds(failure);
    if (gone.length === 0) return false;
    const names = references.flatMap((chip) =>
      chip.visibility === "visible" && gone.includes(chip.documentId) ? [chip.name] : [],
    );
    setReferences((current) =>
      current.filter((chip) => chip.visibility !== "visible" || !gone.includes(chip.documentId)),
    );
    setError(
      names.map((name) => t("errors.REFERENCE_UNAVAILABLE", { name })).join(" ") || undefined,
    );
    return true;
  };

  return {
    references,
    onReferences: (next: ReferenceChip[]) => {
      setReferences(next);
      setError(undefined);
    },
    referenceError: error,
    setReferenceError: setError,
    referenceIds,
    hiddenReferenceIds,
    removeUnavailable,
  };
}
