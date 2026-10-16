# wallet

Go で実装した VC Knots デモ用ウォレットです。
Issuer からの VC 受け取りと Verifier への VP 提示を行います。

[`github.com/trustknots/vcknots/wallet`](https://pkg.go.dev/github.com/trustknots/vcknots/wallet) を使った利用サンプルです。

## 起動方法

リポジトリルートから実行します。

```bash
pnpm dev:wallet
```

## 設定

設定はすべて環境変数で行います（`.env` ファイルは使用しません）。

| 変数名 | デフォルト | 説明 |
| --- | --- | --- |
| `VCKNOTS_CERT_PATH` | `../issuer-verifier/config/keys/certificate_sample.pem` | Verifier の証明書パス |

### 証明書パスを変更する場合

デフォルトでは `issuer-verifier/config/keys/certificate_sample.pem` を参照します。
別の証明書を使いたい場合は、起動時に `VCKNOTS_CERT_PATH` を指定します。

```bash
# macOS / Linux
VCKNOTS_CERT_PATH=/path/to/certificate.pem pnpm dev:wallet

# Windows (PowerShell)
$env:VCKNOTS_CERT_PATH = "C:\path\to\certificate.pem"; pnpm dev:wallet
```

この変数は起動時にのみ読み込まれます。変更する場合は wallet の再起動が必要です。
