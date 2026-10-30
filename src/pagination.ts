type PageRequest = { page?: number; perPage?: number };

export function paginationFromHeaders(headers: Headers, pageItemCount: number, request?: PageRequest) {
  const result: Record<string, unknown> = { pageItemCount };
  for (const [name, header] of [["totalPages", "x-pagination-total-pages"], ["resultCount", "x-pagination-result-count"]]) {
    const raw = headers.get(header);
    if (raw !== null && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) result[name] = Number(raw);
  }
  // resultCount is a legacy raw header, not a total match count. The native v1
  // API reports the current page's count; pageItemCount is based on the body.
  if (request !== undefined) {
    const page = request.page ?? 1;
    result.page = page;
    if (request.perPage !== undefined) result.requestedPerPage = request.perPage;
    const total = result.totalPages;
    if (typeof total === "number" && !(total === 0 && pageItemCount > 0) && !(page > total && pageItemCount > 0)
      && !(request.perPage !== undefined && pageItemCount > request.perPage)) {
      result.hasMore = page < total;
      if (page < total) result.nextPage = page + 1;
      result.completeness = page === 1 && total <= 1 ? "complete" : "partial";
    } else {
      result.completeness = "unknown";
    }
  } else {
    // Some endpoints do not expose paging arguments. Forwarding a header does
    // not establish a supported continuation mechanism for those endpoints.
    result.completeness = "unknown";
  }
  return result;
}
