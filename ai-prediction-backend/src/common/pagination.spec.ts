import { BadRequestException } from '@nestjs/common';
import { pageQuery, paged } from './pagination';

describe('pagination contract', () => {
  it('applies defaults when parameters are omitted and accepts documented boundaries', () => {
    expect(pageQuery()).toMatchObject({ page: 1, pageSize: 20, skip: 0 });
    expect(pageQuery('1', '1')).toMatchObject({ page: 1, pageSize: 1, skip: 0 });
    expect(pageQuery('4', '100')).toMatchObject({ page: 4, pageSize: 100, skip: 300 });
  });

  it.each([
    ['0', '20'], ['-1', '20'], ['1.5', '20'], ['NaN', '20'], ['', '20'],
    ['1', '0'], ['1', '101'], ['1', '2.5'], ['1', ''], ['1', ['100', '100']],
    [['1', '1'], '20'], ['9007199254740991', '100'],
  ])('rejects ambiguous or out-of-range values (%p, %p)', (page, pageSize) => {
    expect(() => pageQuery(page, pageSize)).toThrow(BadRequestException);
  });
  it('reports result metadata consistently', () => {
    expect(paged(['a', 'b'], 21, 2, 10).meta).toEqual({ page: 2, pageSize: 10, total: 21, totalPages: 3 });
  });
});
