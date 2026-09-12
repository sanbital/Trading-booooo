export type PageFetcher<T> = (from: number, to: number) => Promise<T[]>;

export type CollectPagesOptions = {
  pageSize?: number;
  maxRows?: number;
};

export async function collectPages<T>(
  fetchPage: PageFetcher<T>,
  options: CollectPagesOptions = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.min(1000, Math.floor(options.pageSize ?? 1000)));
  const maxRows = Math.max(pageSize, Math.floor(options.maxRows ?? 100_000));
  const rows: T[] = [];

  while (rows.length < maxRows) {
    const from = rows.length;
    const to = Math.min(from + pageSize - 1, maxRows - 1);
    const page = await fetchPage(from, to);
    if (!Array.isArray(page)) throw new Error("paginated fetch returned a non-array response");

    rows.push(...page.slice(0, to - from + 1));
    if (page.length < pageSize) break;
  }

  return rows;
}
