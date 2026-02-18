/**
 * Azure OpenAI authentication via DefaultAzureCredential.
 *
 * Uses @azure/identity to obtain Bearer tokens for Azure OpenAI endpoints.
 * Supports Azure CLI login, managed identity, environment credentials, etc.
 * Tokens are cached until 5 minutes before expiry to minimise latency.
 *
 * Equivalent Node.js pattern for the Python:
 *   token_provider = get_bearer_token_provider(
 *     DefaultAzureCredential(), "https://cognitiveservices.azure.com/.default"
 *   )
 */

const AZURE_COGNITIVESERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

// Refresh 5 minutes before the token expires.
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: string | null = null;
let cachedExpiryMs = 0;

/**
 * Retrieve a fresh (or cached) Azure OpenAI Bearer token via DefaultAzureCredential.
 * Returns null when @azure/identity is unavailable or credentials cannot be found.
 */
export async function resolveAzureOpenAiToken(): Promise<string | null> {
  const now = Date.now();
  if (cachedToken && cachedExpiryMs - EXPIRY_BUFFER_MS > now) {
    return cachedToken;
  }

  try {
    // Dynamic import keeps the module optional – users without @azure/identity
    // installed (or not using Azure) are unaffected.
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const tokenResponse = await credential.getToken(AZURE_COGNITIVESERVICES_SCOPE);
    if (!tokenResponse) {
      return null;
    }
    cachedToken = tokenResponse.token;
    cachedExpiryMs = tokenResponse.expiresOnTimestamp;
    return cachedToken;
  } catch {
    return null;
  }
}

/** Force-clear the token cache (useful for tests or explicit re-auth). */
export function clearAzureTokenCache(): void {
  cachedToken = null;
  cachedExpiryMs = 0;
}
