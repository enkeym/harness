export const cachePolicy = Object.freeze({
  pendingHandoffMs: 24 * 60 * 60 * 1000,
  previousHandoffs: 32,
  scanEntries: 100,
  readResultMinBytes: 512,
  taskCheckpointChars: 6000,
  taskSourceEntries: 8,
  taskSourceLines: 160,
  taskSourceBytes: 24000,
  taskContextMs: 24 * 60 * 60 * 1000,
  taskPruneMs: 10 * 60 * 1000
})
