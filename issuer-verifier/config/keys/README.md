# Verifier 鍵ファイル

鍵ファイルは **git 管理対象外** です。サーバー起動前にローカルで生成してください。

```sh
pnpm gen-keys
```

`private_key_sample.pem` と `certificate_sample.pem`（ES256、自己署名、有効期限10年）が生成されます。
既にファイルが存在する場合はスキップされます。

デフォルトの SAN は `localhost,127.0.0.1` です。変更する場合は `.env` に以下を追加してから実行してください。

```sh
VCKNOTS_SAN=your.host,192.168.1.1
```

鍵ファイルのパスは環境変数で上書き可能です。

- `VERIFIER_PRIVATE_KEY_PATH`
- `VERIFIER_CERTIFICATE_PATH`
