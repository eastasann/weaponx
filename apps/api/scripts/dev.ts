/**
 * API の開発サーバー。通常は `bun --watch` で動かし、WATCH_POLLING=true のときは
 * ファイルの変更をポーリングで検知して再起動する(bun --watch にポーリングの設定が無いため。
 * バインドマウントがイベントを伝えない環境向け。docs/03_dev-setup.md 11章)。
 */
import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const apiRoot = resolve(import.meta.dir, "..");

if (process.env.WATCH_POLLING !== "true") {
  const child = Bun.spawn(["bun", "--watch", "src/index.ts"], {
    cwd: apiRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.on("SIGTERM", () => child.kill());
  process.on("SIGINT", () => child.kill());
  process.exit(await child.exited);
}

const watched = [resolve(apiRoot, "src"), resolve(apiRoot, "../../packages/shared/src")];

function snapshot(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else parts.push(`${path}:${statSync(path).mtimeMs}`);
    }
  };
  for (const dir of watched) walk(dir);
  return parts.join("\n");
}

let child = start();
let last = snapshot();

function start() {
  return Bun.spawn(["bun", "src/index.ts"], {
    cwd: apiRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    child.kill();
    process.exit(0);
  });
}

setInterval(async () => {
  const now = snapshot();
  if (now === last) return;
  last = now;
  child.kill();
  await child.exited;
  child = start();
}, 300);
