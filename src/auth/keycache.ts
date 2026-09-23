

let cachedApiKey: string | undefined;

export function getApiKeyCache(): string | undefined {
    return cachedApiKey;
}

export function setApiKeyCache(key: string | undefined): void {
    cachedApiKey = key;
}
