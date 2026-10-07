export interface PageSnapshot {
  url: string;
  title: string;
  ariaSnapshot: string;
  /**
   * Set when the snapshot was captured at the wait cap while first-party
   * requests were still in flight, so content may be missing (for example a
   * "Loading..." placeholder). Lists up to five pending paths, without query strings.
   */
  loadIncomplete?: { pendingRequests: string[] };
}

export interface PageInspector {
  inspect(url: string): Promise<PageSnapshot>;
}
