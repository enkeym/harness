export const cachePolicy = Object.freeze({
  pendingHandoffMs: 24 * 60 * 60 * 1000,
  previousHandoffs: 32,
  scanEntries: 100,
  readResultMinBytes: 512
})
