# server

サーバーサイドのパッケージ群です。

## 構成

```
server/
├── issuer-verifier/   # Issuer / Verifier の Web アプリ
└── server-core/       # vcknots server/core ベースの共有サーバーコンポーネント
```

### issuer-verifier

TypeScript (Hono) で実装した Issuer・Verifier の Web アプリです。
VC の発行フロー (Issuance) と検証フロー (Verification) のエンドポイントを提供します。
`server-core` をローカル依存として利用します。

### server-core

[trustknots/vcknots](https://github.com/trustknots/vcknots) リポジトリの `server/core` をベースに、このサンプルアプリ向けに調整したローカルコピーです。
サーバーのブートストラップ・Hono アプリファクトリー・共有ルート・共有ユーティリティを提供します。
