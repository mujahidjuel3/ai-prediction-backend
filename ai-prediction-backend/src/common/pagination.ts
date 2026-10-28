import { BadRequestException } from '@nestjs/common';
const PAGE_ERROR = 'page must be a positive integer and pageSize must be an integer from 1 to 100';

function parsePositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new BadRequestException(PAGE_ERROR);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new BadRequestException(PAGE_ERROR);
  return parsed;
}

export function pageQuery(page?: unknown, pageSize?: unknown) {
  const p = parsePositiveInteger(page, 1);
  const s = parsePositiveInteger(pageSize, 20);
  const skip = (p - 1) * s;
  if (s > 100 || !Number.isSafeInteger(skip)) throw new BadRequestException(PAGE_ERROR);
  return { page: p, pageSize: s, skip };
}
export function paged<T>(data: T[], total: number, page: number, pageSize: number) {
  return { data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}
