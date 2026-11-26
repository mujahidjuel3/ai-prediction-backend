describe('EMAIL_TEST_RECIPIENTS allowlist parsing', () => {
  function parseAllowlist(raw: string | undefined): string[] {
    return (raw || '')
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  }

  function maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const visible = local.slice(0, 2);
    return `${visible}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
  }

  it('parses and normalizes allowlisted recipients', () => {
    expect(parseAllowlist('Admin@Example.com, other@test.edu, not-an-email')).toEqual([
      'admin@example.com',
      'other@test.edu',
    ]);
  });

  it('returns empty when unset so test email stays disabled', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
  });

  it('masks local-part for status responses without exposing full mailbox', () => {
    expect(maskEmail('verifier@example.com')).toBe('ve******@example.com');
  });
});
