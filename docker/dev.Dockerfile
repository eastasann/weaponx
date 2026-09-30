# api / web / tools 共通の開発用イメージ。Bun の版は package.json の packageManager と合わせる。
# ビルド中に外へ出る処理は無いので、EXTRA_CA_CERT は実行時(compose.yaml)にだけ渡す
FROM oven/bun:1.4.2

WORKDIR /workspace
