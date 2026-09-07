import type { ProviderConfig } from '@tee-replay/protocol';

export function matchesProviderRequest(
  config: ProviderConfig,
  request: { method: string; url: string },
): boolean {
  return request.method === config.capture.method && new RegExp(config.capture.urlRegex, 'u').test(request.url);
}

export function selectCapturedHeaders(
  configuredNames: string[],
  requestHeaders: Array<{ name?: string | undefined; value?: string | undefined }>,
): Record<string, string> {
  const allowed = new Set(configuredNames.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    requestHeaders
      .filter((header) => header.name && typeof header.value === 'string' && allowed.has(header.name.toLowerCase()))
      .map((header) => [header.name!.toLowerCase(), header.value!]),
  );
}
