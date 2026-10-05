const escapeQuotedString = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
const quoteAuthParam = (name, value) => `${name}="${escapeQuotedString(value)}"`;
export const buildBearerAuthenticateHeader = ({ realm, error, errorDescription, errorUri, scope, }) => {
    const params = [quoteAuthParam('realm', realm)];
    if (error) {
        params.push(quoteAuthParam('error', error));
    }
    if (errorDescription) {
        params.push(quoteAuthParam('error_description', errorDescription));
    }
    if (errorUri) {
        params.push(quoteAuthParam('error_uri', errorUri));
    }
    if (scope) {
        params.push(quoteAuthParam('scope', scope));
    }
    return `Bearer ${params.join(', ')}`;
};
export const buildDpopAuthenticateHeader = ({ realm, error, errorDescription, errorUri, }) => {
    const params = [quoteAuthParam('realm', realm)];
    if (error) {
        params.push(quoteAuthParam('error', error));
    }
    if (errorDescription) {
        params.push(quoteAuthParam('error_description', errorDescription));
    }
    if (errorUri) {
        params.push(quoteAuthParam('error_uri', errorUri));
    }
    return `DPoP ${params.join(', ')}`;
};
