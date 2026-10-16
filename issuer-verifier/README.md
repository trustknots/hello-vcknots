# issuer-verifier

TypeScript (Hono) で実装した Issuer・Verifier の Web アプリです。
VC の発行フロー (Issuance) と検証フロー (Verification) のエンドポイントを提供します。

[`@trustknots/vcknots`](https://www.npmjs.com/package/@trustknots/vcknots) を使った利用サンプルです。

## 構成

```text
issuer-verifier/
├── src/
│   ├── index.ts          # エントリーポイント・サーバー起動
│   ├── app/
│   │   └── routes.ts     # アプリ固有のルート（発行・検証カスタムロジック）
│   ├── routes/
│   │   ├── authz.ts      # /token, /.well-known/oauth-authorization-server
│   │   ├── issue.ts      # /credentials, /configurations/:id/offer, /.well-known/openid-credential-issuer 等
│   │   └── verify.ts     # /request, /callback, /request-object 等
│   └── utils/
│       ├── error-handler.ts
│       ├── www-authenticate.ts
│       └── direct-post-vp-aud-transaction-store.ts
├── config/
│   ├── metadata/         # Issuer・認可サーバー・Verifier のメタデータ JSON
│   └── keys/             # Verifier の秘密鍵・証明書
└── public/               # 静的ファイル（issuer.html / verifier.html）
```

## 起動方法

リポジトリルートから実行します。

```bash
pnpm install
pnpm dev:server
```

## 環境変数

`.env.example` をコピーして `.env` を作成します。

```bash
# macOS / Linux
cp issuer-verifier/.env.example issuer-verifier/.env

# Windows
copy issuer-verifier\.env.example issuer-verifier\.env
```

主な設定項目:

| 変数名 | デフォルト | 説明 |
| --- | --- | --- |
| `ISSUER_BASE_URL` | `http://localhost:8080` | Issuer の公開 URL |
| `ISSUER_PORT` | `8080` | Issuer のリッスンポート |
| `VERIFIER_BASE_URL` | `ISSUER_BASE_URL` と同じ | Verifier の公開 URL |
| `VERIFIER_PORT` | `ISSUER_PORT` と同じ | Verifier のリッスンポート |
| `ISSUER_VERIFIER_CONFIG_DIR` | `config/` | メタデータ・鍵ファイルのベースディレクトリ |

`VERIFIER_BASE_URL` / `VERIFIER_PORT` を Issuer と別の値に設定すると、Issuer と Verifier が別ポートで起動します。
