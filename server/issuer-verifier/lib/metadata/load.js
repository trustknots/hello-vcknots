import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuthorizationServerMetadata } from '@trustknots/vcknots/authz';
import { CredentialIssuerMetadata } from '@trustknots/vcknots/issuer';
import { VerifierMetadata } from '@trustknots/vcknots/verifier';
export const loadMetadataConfigs = (metadataDir) => {
    const issuerMetadataConfigRaw = JSON.parse(readFileSync(join(metadataDir, 'issuer_metadata.json'), 'utf-8'));
    const authorizationMetadataConfigRaw = JSON.parse(readFileSync(join(metadataDir, 'authorization_metadata.json'), 'utf-8'));
    const verifierMetadataConfigRaw = JSON.parse(readFileSync(join(metadataDir, 'verifier_metadata.json'), 'utf-8'));
    return {
        issuerMetadataConfig: CredentialIssuerMetadata(issuerMetadataConfigRaw),
        authorizationMetadataConfig: AuthorizationServerMetadata(authorizationMetadataConfigRaw),
        verifierMetadataConfig: VerifierMetadata(verifierMetadataConfigRaw),
    };
};
