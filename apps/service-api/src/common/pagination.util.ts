export type PageQuery = {
  page: number;
  pageSize: number;
};

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

export function getOffset(query: PageQuery): number {
  return (query.page - 1) * query.pageSize;
}

export function toPageResult<T>(
  items: T[],
  query: PageQuery,
  total: number,
): PageResult<T> {
  return {
    items,
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}
