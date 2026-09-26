import { BadRequestException } from '@nestjs/common';
import { parseTenantId } from './tenant-id.decorator';

describe('parseTenantId', () => {
  it('accepts simple ids and lower-cases them', () => {
    expect(parseTenantId('acme')).toBe('acme');
    expect(parseTenantId(' Acme-EU_2 ')).toBe('acme-eu_2');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['path traversal', '../../etc/passwd'],
    ['slash', 'acme/other'],
    ['dot', 'acme.json'],
    ['duplicated header (array)', ['a', 'b']],
    ['too long', 'a'.repeat(64)],
  ])('rejects %s', (_, raw) => {
    expect(() => parseTenantId(raw)).toThrow(BadRequestException);
  });
});
