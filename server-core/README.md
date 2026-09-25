# Server Core

> **注記:** このパッケージは [trustknots/vcknots](https://github.com/trustknots/vcknots) リポジトリの [`server/core`](https://github.com/trustknots/vcknots/tree/main/server/core) をベースに、このサンプルアプリ向けに調整したローカルコピーです。

サンプルアプリの共有サーバーコンポーネントです。

このパッケージは、`issuer-verifier` が利用する共有サーバーのブートストラップ・Hono アプリファクトリー・共有ルート・共有ユーティリティを含みます。

パッケージ名: `@trustknots/server-core`

## ビルド

リポジトリのルートディレクトリで実行します：

```bash
pnpm install
pnpm -F @trustknots/server-core build
```

## 補足

- `@trustknots/vcknots`・`hono`・`@hono/node-server` に依存しています。
