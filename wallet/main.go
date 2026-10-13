package main

import (
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/trustknots/vcknots/wallet"
	"github.com/trustknots/vcknots/wallet/credstore"
	"github.com/trustknots/vcknots/wallet/credstore/plugins/local"
	"github.com/trustknots/vcknots/wallet/env"
	"github.com/trustknots/vcknots/wallet/examples/common"
	"github.com/trustknots/vcknots/wallet/idprof"
	"github.com/trustknots/vcknots/wallet/presenter"
	"github.com/trustknots/vcknots/wallet/presenter/plugins/oid4vp"
	"github.com/trustknots/vcknots/wallet/receiver"
	receiverTypes "github.com/trustknots/vcknots/wallet/receiver/types"
	"github.com/trustknots/vcknots/wallet/serializer"
	"github.com/trustknots/vcknots/wallet/verifier"
)

var (
	appWallet *wallet.Wallet
	mockKey   *common.MockKeyEntry
)

type ReceiveRequest struct {
	OfferURL string `json:"offer_url"`
}

type PresentRequest struct {
	RequestURL string `json:"request_url"`
}

type CredentialUIResponse struct {
	ID         string                 `json:"id"`
	Raw        string                 `json:"raw"`
	ReceivedAt string                 `json:"received_at"`
	MimeType   string                 `json:"mime_type"`
	Claims     map[string]interface{} `json:"claims"`
}

// newWallet builds a wallet without client authentication for the hello-vcknots demo.
// The hello-vcknots issuer uses pre-authorized code grant with anonymous access,
// so no OAuth client registration is required.
func newWallet(certPath string, credentialStorePath string) (*wallet.Wallet, error) {
	localCredentialStore, err := local.NewLocalCredentialStorage(credentialStorePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create local credential store: %w", err)
	}

	credStore, err := credstore.NewCredStoreDispatcher(credstore.WithPlugin(local.Local, localCredentialStore))
	if err != nil {
		return nil, fmt.Errorf("failed to create cred store: %w", err)
	}

	receiverDispatcher, err := receiver.NewReceivingDispatcher(receiver.WithDefaultConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create receiver: %w", err)
	}

	serializerDispatcher, err := serializer.NewSerializationDispatcher(serializer.WithDefaultConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create serializer: %w", err)
	}

	verifierDispatcher, err := verifier.NewVerificationDispatcher(verifier.WithDefaultConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create verifier: %w", err)
	}

	certFile, err := os.ReadFile(certPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read certificate %s: %w", certPath, err)
	}

	certPool := x509.NewCertPool()
	if !certPool.AppendCertsFromPEM(certFile) {
		return nil, fmt.Errorf("failed to parse certificate")
	}

	oid4vpPresenter := &oid4vp.Oid4vpPresenter{X509TrustChainRoots: certPool}
	presenterDispatcher, err := presenter.NewPresentationDispatcher(
		presenter.WithPlugin(presenter.Oid4vp, oid4vpPresenter),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create presenter: %w", err)
	}

	idProf, err := idprof.NewIdentityProfileDispatcher(idprof.WithDefaultConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create identity profiler: %w", err)
	}

	return wallet.NewWalletWithConfig(wallet.Config{
		CredStore:  credStore,
		IDProfiler: idProf,
		Receiver:   receiverDispatcher,
		Serializer: serializerDispatcher,
		Verifier:   verifierDispatcher,
		Presenter:  presenterDispatcher,
	})
}


func main() {
	// ローカル HTTP 通信を許可する
	env.SetHTTPAllowed(true)

	dataRoot, err := filepath.Abs(filepath.Join(".", ".data"))
	if err != nil {
		log.Fatalf("Failed to resolve wallet data directory: %v", err)
	}
	credentialStorePath := filepath.Join(dataRoot, "vcknots", "wallet", ".local_credstore.db")
	if err := os.MkdirAll(filepath.Dir(credentialStorePath), 0700); err != nil {
		log.Fatalf("Failed to create wallet data directory: %v", err)
	}
	if err := os.Setenv("APPDATA", dataRoot); err != nil {
		log.Fatalf("Failed to set wallet data directory: %v", err)
	}

	// E2E テストで古いデータの干渉を防ぐため、起動時にローカルDBをクリーンアップする
	if _, err := os.Stat(credentialStorePath); err == nil {
		log.Printf("[wallet] Cleaning up old local database at %s...", credentialStorePath)
		if err := os.Remove(credentialStorePath); err != nil {
			log.Printf("[wallet] Warning: failed to delete old local database: %v", err)
		} else {
			log.Printf("[wallet] Successfully cleaned up old database.")
		}
	}

	// 証明書パスの設定
	certPath := os.Getenv("VCKNOTS_CERT_PATH")
	if certPath == "" {
		certPath = filepath.Join("..", "issuer-verifier", "config", "keys", "certificate_sample.pem")
	}
	absCertPath, err := filepath.Abs(certPath)
	if err != nil {
		log.Fatalf("Failed to resolve certificate path: %v", err)
	}
	log.Printf("Using certificate path: %s", absCertPath)

	appWallet, err = newWallet(absCertPath, credentialStorePath)
	if err != nil {
		log.Fatalf("Failed to initialize wallet: %v", err)
	}
	mockKey = common.NewMockKeyEntry()

	// --- 静的ファイルの配信 ---
	fs := http.FileServer(http.Dir("./public"))
	http.Handle("/", fs)

	// --- API エンドポイント ---
	http.HandleFunc("/api/credentials", handleGetCredentials)
	http.HandleFunc("/api/receive", handleReceiveCredential)
	http.HandleFunc("/api/present", handlePresentCredential)

	port := "8082"
	log.Printf("\n======================================================")
	log.Printf("🎉 hello-vcknots Go Wallet Server is running!")
	log.Printf("👉 Wallet Web UI: http://localhost:%s", port)
	log.Printf("======================================================\n")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

// 1. 保有するクレデンシャル一覧の取得
func handleGetCredentials(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	getEntriesReq := wallet.GetCredentialEntriesRequest{}
	credentials, _, err := appWallet.GetCredentialEntries(getEntriesReq)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var response []CredentialUIResponse
	for _, cred := range credentials {
		claims := parseJWTClaims(string(cred.Entry.Raw))
		response = append(response, CredentialUIResponse{
			ID:         cred.Entry.Id,
			Raw:        string(cred.Entry.Raw),
			ReceivedAt: cred.Entry.ReceivedAt.String(),
			MimeType:   cred.Entry.MimeType,
			Claims:     claims,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

// 2. Offer URL による Credential 受信
func handleReceiveCredential(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, "Failed to read request body", http.StatusBadRequest)
		return
	}

	var req ReceiveRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	offerURL := req.OfferURL
	log.Printf("[wallet] Processing receive request for offer URL: %s", offerURL)

	// offer_url から credential_offer パラメータをパース
	if !strings.HasPrefix(offerURL, "openid-credential-offer://?credential_offer=") {
		writeJSONError(w, "Invalid Offer URL format. Must start with openid-credential-offer://", http.StatusBadRequest)
		return
	}

	encodedOffer := strings.TrimPrefix(offerURL, "openid-credential-offer://?credential_offer=")
	decodedOffer, err := url.QueryUnescape(encodedOffer)
	if err != nil {
		writeJSONError(w, "Failed to unescape offer URL: "+err.Error(), http.StatusBadRequest)
		return
	}

	var offerData map[string]interface{}
	if err := json.Unmarshal([]byte(decodedOffer), &offerData); err != nil {
		writeJSONError(w, "Failed to parse offer JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	credentialIssuerStr, ok := offerData["credential_issuer"].(string)
	if !ok {
		writeJSONError(w, "Missing credential_issuer in offer", http.StatusBadRequest)
		return
	}

	credentialIssuerURL, err := url.Parse(credentialIssuerStr)
	if err != nil {
		writeJSONError(w, "Failed to parse issuer URL: "+err.Error(), http.StatusBadRequest)
		return
	}

	configIDs := []string{}
	if ids, ok := offerData["credential_configuration_ids"].([]interface{}); ok {
		for _, id := range ids {
			if idStr, ok := id.(string); ok {
				configIDs = append(configIDs, idStr)
			}
		}
	}

	grants := make(map[string]*wallet.CredentialOfferGrant)
	if grantsData, ok := offerData["grants"].(map[string]interface{}); ok {
		for grantType, grantValue := range grantsData {
			if grantMap, ok := grantValue.(map[string]interface{}); ok {
				grant := &wallet.CredentialOfferGrant{}
				if preAuthCode, ok := grantMap["pre-authorized_code"].(string); ok {
					grant.PreAuthorizedCode = preAuthCode
				}
				grants[grantType] = grant
			}
		}
	}

	credentialOffer := &wallet.CredentialOffer{
		CredentialIssuer:           credentialIssuerURL,
		CredentialConfigurationIDs: configIDs,
		Grants:                     grants,
	}

	receiveReq := wallet.ReceiveCredentialRequest{
		CredentialOffer: credentialOffer,
		Type:            receiverTypes.Oid4vci,
		Key:             mockKey,
	}

	savedCredential, err := appWallet.ReceiveCredential(receiveReq)
	if err != nil {
		log.Printf("[wallet] ReceiveCredential failed: %v", err)
		writeJSONError(w, "Failed to receive credential: "+err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("[wallet] Successfully received credential: %s", savedCredential.Entry.Id)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":       true,
		"id":       savedCredential.Entry.Id,
		"mime":     savedCredential.Entry.MimeType,
		"received": savedCredential.Entry.ReceivedAt.String(),
	})
}

// 3. Request URL による Credential の提示 (Presentation)
func handlePresentCredential(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSONError(w, "Failed to read body", http.StatusBadRequest)
		return
	}

	var req PresentRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSONError(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	requestURL := req.RequestURL
	log.Printf("[wallet] Presenting credential for request URL: %s", requestURL)

	_, err = appWallet.PresentCredential(requestURL, mockKey, nil)
	if err != nil {
		log.Printf("[wallet] PresentCredential failed: %v", err)
		writeJSONError(w, "Failed to present credential: "+err.Error(), http.StatusInternalServerError)
		return
	}

	log.Printf("[wallet] Credential presented successfully!")

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": true,
	})
}

// ユーティリティ: JWT のペイロード（Claims）をパース
func parseJWTClaims(jwtString string) map[string]interface{} {
	parts := strings.Split(jwtString, ".")
	if len(parts) != 3 {
		return nil
	}

	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}

	var fullClaims map[string]interface{}
	if err := json.Unmarshal(payloadBytes, &fullClaims); err != nil {
		return nil
	}

	if vc, ok := fullClaims["vc"].(map[string]interface{}); ok {
		if subject, ok := vc["credentialSubject"].(map[string]interface{}); ok {
			return subject
		}
	}

	return fullClaims
}

func writeJSONError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"error": msg,
	})
}
