import { getResearchCache, setResearchCache } from "../storage/etfResearchCache";
import type {
  EtfAnalysisBundle,
  EtfResearchManifest,
  EtfReturnsBundle,
} from "../domain/etfResearchTypes";

const STATIC_MANIFEST = "/data/etf-research-manifest.json";
const STATIC_ANALYSIS = "/data/etf-research-analysis.json";
const STATIC_RETURNS = "/data/etf-research-returns.json";

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} 응답 오류 (${response.status})`);
  return response.json();
}

function manifestFrom(value: unknown): EtfResearchManifest {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { dataVersion?: unknown }).dataVersion !== "string"
  ) {
    throw new Error("ETF 연구 데이터 manifest 형식이 올바르지 않습니다.");
  }
  return value as EtfResearchManifest;
}

function analysisFrom(value: unknown, version: string): EtfAnalysisBundle {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { dataVersion?: unknown }).dataVersion !== version ||
    !Array.isArray((value as { profiles?: unknown }).profiles)
  ) {
    throw new Error("ETF 분석 데이터 형식 또는 버전이 올바르지 않습니다.");
  }
  return value as EtfAnalysisBundle;
}

function returnsFrom(value: unknown, version: string): EtfReturnsBundle {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { dataVersion?: unknown }).dataVersion !== version ||
    !Array.isArray((value as { series?: unknown }).series)
  ) {
    throw new Error("ETF 가격 이력 형식 또는 버전이 올바르지 않습니다.");
  }
  return value as EtfReturnsBundle;
}

async function apiThenStatic(apiPath: string, staticPath: string): Promise<unknown> {
  try {
    return await fetchJson(apiPath);
  } catch {
    return fetchJson(staticPath);
  }
}

export async function loadEtfResearch(): Promise<{
  manifest: EtfResearchManifest;
  analysis: EtfAnalysisBundle;
}> {
  const manifest = manifestFrom(
    await apiThenStatic("/api/etf-research/manifest", STATIC_MANIFEST),
  );
  const cacheKey = `analysis:${manifest.dataVersion}`;
  const cached = await getResearchCache<EtfAnalysisBundle>(cacheKey);
  if (cached?.dataVersion === manifest.dataVersion) return { manifest, analysis: cached };
  const analysis = analysisFrom(
    await apiThenStatic(manifest.analysisPath, STATIC_ANALYSIS),
    manifest.dataVersion,
  );
  void setResearchCache(cacheKey, analysis);
  return { manifest, analysis };
}

export async function loadEtfReturns(
  manifest: EtfResearchManifest,
): Promise<EtfReturnsBundle> {
  const cacheKey = `returns:${manifest.dataVersion}`;
  const cached = await getResearchCache<EtfReturnsBundle>(cacheKey);
  if (cached?.dataVersion === manifest.dataVersion) return cached;
  const bundle = returnsFrom(
    await apiThenStatic(manifest.returnsPath, STATIC_RETURNS),
    manifest.dataVersion,
  );
  void setResearchCache(cacheKey, bundle);
  return bundle;
}
