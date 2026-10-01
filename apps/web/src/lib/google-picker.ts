/** Google Picker の使う部分だけの型。公式の型パッケージは入れない */
type PickerDoc = { id: string };
type PickerResponse = { action: string; docs?: PickerDoc[] };
type PickerApi = {
  Action: { PICKED: string; CANCEL: string };
  ViewId: { DOCS: string };
  DocsView: new (
    viewId: string,
  ) => {
    setMimeTypes(types: string): unknown;
    setFileIds(ids: string): unknown;
    setIncludeFolders(include: boolean): unknown;
  };
  PickerBuilder: new () => {
    addView(view: unknown): unknown;
    setOAuthToken(token: string): unknown;
    setDeveloperKey(key: string): unknown;
    setAppId(id: string): unknown;
    setCallback(callback: (response: PickerResponse) => void): unknown;
    build(): { setVisible(visible: boolean): void };
  };
};
type Gapi = { load(api: string, options: { callback: () => void; onerror: () => void }): void };

declare global {
  interface Window {
    gapi?: Gapi;
    google?: { picker?: PickerApi };
  }
}

const SCRIPT_URL = "https://apis.google.com/js/api.js";
// 選べるのはドキュメント・スライド・スプレッドシート・PDF(design-spec 6.2)
const MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
  "application/pdf",
].join(",");

let loading: Promise<PickerApi> | null = null;

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.gapi) return resolve();
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Google Picker のスクリプトを読み込めません"));
    document.head.appendChild(script);
  });
}

/** Picker のライブラリを1回だけ読み込む。失敗したときは次の呼び出しでやり直せるよう覚えない */
function loadPicker(): Promise<PickerApi> {
  loading ??= loadScript()
    .then(
      () =>
        new Promise<PickerApi>((resolve, reject) => {
          const gapi = window.gapi;
          if (!gapi) return reject(new Error("gapi がありません"));
          gapi.load("picker", {
            callback: () => {
              const api = window.google?.picker;
              if (api) resolve(api);
              else reject(new Error("Google Picker を初期化できません"));
            },
            onerror: () => reject(new Error("Google Picker を読み込めません")),
          });
        }),
    )
    .catch((error) => {
      loading = null;
      throw error;
    });
  return loading;
}

export type GooglePickerOptions = {
  apiKey: string;
  appId: string;
  accessToken: string;
  /** 指定すると、そのファイルだけを見せた状態で開く(design-spec 6.0.9) */
  fileId?: string | undefined;
};

/** Google のファイル選択画面を開き、選んだファイルの ID を返す。選ばずに閉じたら null */
export async function openGooglePicker(options: GooglePickerOptions): Promise<string | null> {
  const picker = await loadPicker();
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS);
    view.setMimeTypes(MIME_TYPES);
    view.setIncludeFolders(false);
    if (options.fileId) view.setFileIds(options.fileId);
    const built = new picker.PickerBuilder();
    built.addView(view);
    built.setOAuthToken(options.accessToken);
    built.setDeveloperKey(options.apiKey);
    built.setAppId(options.appId);
    built.setCallback((response) => {
      if (response.action === picker.Action.PICKED) resolve(response.docs?.[0]?.id ?? null);
      else if (response.action === picker.Action.CANCEL) resolve(null);
    });
    built.build().setVisible(true);
  });
}
