import type { CookieOptions } from 'express';

const ACCESS_PATH = '/';
const REFRESH_PATH = '/api/v1/auth';
const CSRF_PATH = '/';

/** Allowed production cookie Domain (no leading dot; shared across api/admin/www). */
export const PRODUCTION_COOKIE_DOMAIN = 'academicsentinel.live';

export function cookieDomainFromEnv(raw: string | undefined = process.env.COOKIE_DOMAIN): string | undefined {
  const domain = raw?.trim();
  return domain ? domain : undefined;
}

export function baseCookieOptions(overrides: CookieOptions = {}): CookieOptions {
  const secure = process.env.COOKIE_SECURE === 'true';
  const sameSite = (process.env.COOKIE_SAME_SITE as CookieOptions['sameSite'] | undefined) ?? 'lax';
  const domain = cookieDomainFromEnv();
  return {
    secure,
    sameSite,
    ...(domain ? { domain } : {}),
    ...overrides,
  };
}

export function accessTokenCookieOptions(maxAgeMs = 10 * 60 * 1000): CookieOptions {
  return baseCookieOptions({ httpOnly: true, path: ACCESS_PATH, maxAge: maxAgeMs });
}

export function refreshTokenCookieOptions(maxAgeMs?: number): CookieOptions {
  const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 14);
  const ttl = Number.isFinite(maxAgeMs) ? maxAgeMs! : days * 86_400_000;
  return baseCookieOptions({ httpOnly: true, path: REFRESH_PATH, maxAge: ttl });
}

export function csrfTokenCookieOptions(): CookieOptions {
  return baseCookieOptions({ httpOnly: false, path: CSRF_PATH });
}

export function clearAccessTokenCookieOptions(): CookieOptions {
  return baseCookieOptions({ path: ACCESS_PATH });
}

export function clearRefreshTokenCookieOptions(): CookieOptions {
  return baseCookieOptions({ path: REFRESH_PATH });
}

export function clearCsrfTokenCookieOptions(): CookieOptions {
  return baseCookieOptions({ path: CSRF_PATH });
}
