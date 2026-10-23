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
│   │   ├── routes.ts     # アプリ固有の発行ルート
│   │   └── verification-result.ts # 検証済みデータからの表示情報抽出
│   ├── routes/
│   │   ├── authz.ts      # /token, /.well-known/oauth-authorization-server
│   │   ├── issue.ts      # /credentials, /configurations/:id/offer, /.well-known/openid-credential-issuer 等
│   │   └── verify.ts     # /request, /callback, /request-object 等
│   └── utils/
│       ├── error-handler.ts
│       ├── www-authenticate.ts
│       ├── issuance-session-store.ts
│       └── verification-session-store.ts
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

## 検証状態の保存期間

通常の要求 URL と Request Object は、同じ状態ストアとコールバック処理を使用します。
検証待ちの有効期限はライブラリの取引期限に従います。検証済みのユーザー名と VC は
結果表示用に5分間保持した後に破棄します。期限切れの状態は30秒ごとにも回収し、
画面は状態が失効すると待機を終了して、新しい要求を作成できるようになります。

## 発行対象の紐付け

`POST /configurations/VCKnotsUserMedal/offer` の JSON 本文に `username` を渡します。
ユーザー名はOfferのPre-Authorized Codeに紐付き、`/token` の発行成功時に
アクセストークンへ紐付けを引き継ぎます。`/credentials` は認可済みトークンに
対応するユーザー名からVCを発行します。従来の `POST /api/setup` は廃止しました。

Offerの紐付けは10分間、トークンの紐付けはトークン応答の有効期間まで保持します。
対応情報がない場合や期限切れの場合は発行を拒否し、古い情報は定期的に回収します。
紐付けはメモリ内で管理するため、サーバー再起動後は新しいOfferの作成が必要です。

## テスト

リポジトリルートで `pnpm test` を実行すると、ビルド後に画面の回帰テストと
Issuer/Verifierのフローテストを実行します。鍵はテスト中にメモリ内で生成し、
通常のWallet起動や保存済みデータの削除は行いません。
