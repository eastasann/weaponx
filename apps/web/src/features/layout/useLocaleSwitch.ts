import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNotify } from "../../components/Toast";
import { client, unwrap } from "../../lib/api";
import { toApiError } from "../../lib/errors";
import { setLocale } from "../../lib/i18n";
import type { Locale } from "../../lib/locale";
import type { Me } from "../../lib/queries";

/** ログイン後の表示言語の切り替え。ブラウザと利用者の設定の両方に保存する(design-spec 1.2) */
export function useLocaleSwitch() {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: async (locale: Locale) => {
      await setLocale(locale);
      return unwrap(client.api.me.patch({ locale }));
    },
    onSuccess: ({ user }) => {
      queryClient.setQueryData<Me>(["me"], (me) => (me ? { ...me, user } : me));
    },
    onError: (error) =>
      notify({
        kind: "error",
        message: t("notice.locale"),
        requestId: toApiError(error).requestId,
      }),
  });
}
