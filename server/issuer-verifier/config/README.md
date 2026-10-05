# Issuer/Verifier 実行時設定

TypeScript ソースとは別に管理する実行時設定ファイルを置くディレクトリです。

- `metadata/` — Issuer・認可サーバー・Verifier の各メタデータ JSON
- `keys/` — Verifier のローカル秘密鍵と証明書ファイル

環境変数 `ISSUER_VERIFIER_CONFIG_DIR` を設定すると、別のディレクトリを参照させることができます。
