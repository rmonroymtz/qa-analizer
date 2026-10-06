export interface ReadinessProbe {
  waitUntilReady(): Promise<void>;
}
