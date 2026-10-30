import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginationFromHeaders } from '../dist/pagination.js';

test('a response exceeding the requested page size has unknown coverage',()=>{
  const headers=new Headers({'X-Pagination-Total-Pages':'1','X-Pagination-Result-Count':'2'});
  const result=paginationFromHeaders(headers,2,{page:1,perPage:1});
  assert.equal(result.completeness,'unknown');assert.equal(result.hasMore,undefined);assert.equal(result.nextPage,undefined);
});

test('pagination never turns a page count or last page into a full-result total', () => {
  const headers = new Headers({ 'x-pagination-total-pages': '3', 'x-pagination-result-count': '1' });
  const first = paginationFromHeaders(headers, 1, { page: 1, perPage: 1 });
  assert.equal(first.pageItemCount, 1);assert.equal(first.hasMore, true);assert.equal(first.nextPage, 2);assert.equal(first.totalItems, undefined);
  const last = paginationFromHeaders(headers, 1, { page: 3, perPage: 1 });
  assert.equal(last.hasMore, false);assert.equal(last.completeness, 'partial');assert.equal(last.nextPage, undefined);
});

test('empty and single-page reads are complete only with consistent known boundaries', () => {
  for (const [count, total] of [[0, 0], [0, 1], [1, 1]]) {
    const page = paginationFromHeaders(new Headers({ 'x-pagination-total-pages': String(total) }), count, {});
    assert.equal(page.completeness, 'complete');assert.equal(page.hasMore, false);
  }
  for (const [count, total, page] of [[1, 0, 1], [1, 1, 2]]) {
    const result = paginationFromHeaders(new Headers({ 'x-pagination-total-pages': String(total) }), count, {page});
    assert.equal(result.completeness, 'unknown');assert.equal(result.hasMore, undefined);
  }
  const noPaging = paginationFromHeaders(new Headers({ 'x-pagination-total-pages': '2' }), 1);
  assert.equal(noPaging.completeness, 'unknown');assert.equal(noPaging.nextPage, undefined);
});
