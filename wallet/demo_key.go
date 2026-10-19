package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"

	"github.com/go-jose/go-jose/v4"
)

// demoKeyEntry is a fixed P-256 key used only for the hello-vcknots demo.
// It uses a hardcoded private scalar so that the demo is reproducible without
// any key management setup. Never use a hardcoded key in production.
type demoKeyEntry struct {
	id         string
	privateKey *ecdsa.PrivateKey
}

func newDemoKeyEntry() *demoKeyEntry {
	dBytes, _ := base64.RawURLEncoding.DecodeString("jAfOh_53IRxqpEsFojZK8iHP--L8ol3ePEo3DnwiIyM")
	privateKey, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), dBytes)
	if err != nil {
		panic(fmt.Sprintf("demo key is not a valid P-256 private key: %v", err))
	}
	return &demoKeyEntry{id: "demo-key-1", privateKey: privateKey}
}

func (k *demoKeyEntry) ID() string {
	return k.id
}

func (k *demoKeyEntry) PublicKey() jose.JSONWebKey {
	return jose.JSONWebKey{
		Key:       &k.privateKey.PublicKey,
		KeyID:     k.id,
		Algorithm: "ES256",
		Use:       "sig",
	}
}

func (k *demoKeyEntry) Sign(payload []byte) ([]byte, error) {
	hash := sha256.Sum256(payload)
	r, s, err := ecdsa.Sign(rand.Reader, k.privateKey, hash[:])
	if err != nil {
		return nil, fmt.Errorf("failed to sign with ECDSA: %w", err)
	}
	signature := make([]byte, 64)
	rBytes := r.Bytes()
	sBytes := s.Bytes()
	copy(signature[32-len(rBytes):32], rBytes)
	copy(signature[64-len(sBytes):64], sBytes)
	return signature, nil
}
