import { test, expect } from 'vitest';
import { relTime } from './relTime.js';

test('accepts ms-epoch numbers and ISO strings', () => {
  const now = Date.now();
  expect(relTime(now - 5 * 60 * 1000)).toBe('5m ago');
  expect(relTime(new Date(now - 5 * 60 * 1000).toISOString())).toBe('5m ago');
});

test('coarse buckets', () => {
  const now = Date.now();
  expect(relTime(now - 10 * 1000)).toBe('just now');
  expect(relTime(now - 3 * 3600 * 1000)).toBe('3h ago');
  expect(relTime(now - 2 * 86400 * 1000)).toBe('2d ago');
});

test('empty / garbage input renders nothing', () => {
  expect(relTime(null)).toBe('');
  expect(relTime(0)).toBe('');
  expect(relTime('not-a-date')).toBe('');
});
