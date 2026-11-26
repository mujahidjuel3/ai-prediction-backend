import {
  PRODUCTION_COOKIE_DOMAIN,
  accessTokenCookieOptions,
  clearAccessTokenCookieOptions,
  clearCsrfTokenCookieOptions,
  clearRefreshTokenCookieOptions,
  cookieDomainFromEnv,
  csrfTokenCookieOptions,
  refreshTokenCookieOptions,
} from './auth-cookie';

describe('auth cookie options', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('omits domain for local host-only cookies when COOKIE_DOMAIN is unset', () => {
    delete process.env.COOKIE_DOMAIN;
    process.env.COOKIE_SECURE = 'false';
    process.env.COOKIE_SAME_SITE = 'lax';

    expect(cookieDomainFromEnv()).toBeUndefined();
    expect(accessTokenCookieOptions()).toEqual(expect.objectContaining({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
    }));
    expect(accessTokenCookieOptions()).not.toHaveProperty('domain');
    expect(refreshTokenCookieOptions()).not.toHaveProperty('domain');
    expect(csrfTokenCookieOptions()).not.toHaveProperty('domain');
  });

  it('applies the configured Domain to access, refresh, and csrf cookies', () => {
    process.env.COOKIE_DOMAIN = PRODUCTION_COOKIE_DOMAIN;
    process.env.COOKIE_SECURE = 'true';
    process.env.COOKIE_SAME_SITE = 'lax';
    process.env.REFRESH_TOKEN_TTL_DAYS = '14';

    expect(accessTokenCookieOptions()).toEqual(expect.objectContaining({
      domain: PRODUCTION_COOKIE_DOMAIN,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000,
    }));
    expect(refreshTokenCookieOptions()).toEqual(expect.objectContaining({
      domain: PRODUCTION_COOKIE_DOMAIN,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 14 * 86_400_000,
    }));
    expect(csrfTokenCookieOptions()).toEqual(expect.objectContaining({
      domain: PRODUCTION_COOKIE_DOMAIN,
      httpOnly: false,
      secure: true,
      sameSite: 'lax',
      path: '/',
    }));
  });

  it('clears cookies with matching Domain and Path attributes', () => {
    process.env.COOKIE_DOMAIN = PRODUCTION_COOKIE_DOMAIN;
    process.env.COOKIE_SECURE = 'true';
    process.env.COOKIE_SAME_SITE = 'lax';

    expect(clearAccessTokenCookieOptions()).toEqual(expect.objectContaining({
      domain: PRODUCTION_COOKIE_DOMAIN,
      path: '/',
      secure: true,
      sameSite: 'lax',
    }));
    expect(clearRefreshTokenCookieOptions()).toEqual(expect.objectContaining({
      domain: PRODUCTION_COOKIE_DOMAIN,
      path: '/api/v1/auth',
    }));
    expect(clearCsrfTokenCookieOptions()).toEqual(expect.objectContaining({
      domain: PRODUCTION_COOKIE_DOMAIN,
      path: '/',
    }));
  });
});
