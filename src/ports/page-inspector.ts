export interface PageSnapshot {
  url: string;
  title: string;
  ariaSnapshot: string;
}

export interface PageInspector {
  inspect(url: string): Promise<PageSnapshot>;
}
