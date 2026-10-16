/** Return only same-origin dashboard paths, suitable for restoring Auth0 app state. */
export function safeAuthReturnTarget(
  returnTo: string | undefined,
  origin: string
): string | undefined {
  if (!returnTo) return undefined;
  try {
    const target = new URL(returnTo, origin);
    if (target.origin !== origin || !/^\/admin(?:\/|$)/.test(target.pathname)) return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
