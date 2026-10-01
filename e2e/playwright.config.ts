import { defineConfig, devices } from "@playwright/test";

// 画面は make e2e が起動した web-e2e(テスト用 DB につないだ API を従える)。開発用ログインとドライブの模擬で動く
export default defineConfig({
  testDir: "./tests",
  // 利用者の状態(再連携など)を変えるテストがあるので、1本ずつ順に流す
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", host: "0.0.0.0" }]],
  use: {
    baseURL: "http://web-e2e:5173",
    // 表示言語の既定はブラウザの言語設定に従う(design-spec 1.2)ので、日本語で流す
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
