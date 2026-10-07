// Located at: lambda/search-indexer/index.ts
//
// AWS Lambda: search-indexer
//
// Triggered by S3 when a file is created or removed under carrier= or a
// manifest changes under manifests/. Rebuilds, in the background, the two
// things the website would otherwise rebuild on the next request:
//   1. the All Info search index   (lib/searchIndex.ts, warmSearchIndex)
//   2. the Master Dashboard result (lib/masterCache.ts, warmMaster)
// It uses the website's own code, bundled in by build-search-indexer.ps1, so
// what it saves is exactly what the website would have built. Each step
// checks first and does nothing if the current version is already saved, so
// a burst of uploads costs one build, not one per file.
//
// No access keys: it runs on its own IAM role. It never logs file contents
// or member names.

import { warmSearchIndex } from '@/lib/searchIndex';
import { warmMaster } from '@/lib/masterCache';

export const handler = async (event: any) => {
  const records = Array.isArray(event?.Records) ? event.Records.length : 0;
  const t0 = Date.now();
  const search = await warmSearchIndex();
  const master = await warmMaster();
  const summary = {
    triggeredBy: records ? `${records} S3 event(s)` : 'manual or test',
    search: { action: search.action, ms: search.ms },
    master: { action: master.action, ms: master.ms },
    totalMs: Date.now() - t0,
  };
  console.log('[search-indexer]', JSON.stringify(summary));
  return summary;
};