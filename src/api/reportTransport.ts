export async function reportJson<T>(primary: string, fallback: string): Promise<T> {
  const paths = import.meta.env.DEV ? [primary, fallback] : [primary];
  let lastError: unknown;
  for (const path of paths) {
    try {
      const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-cache" });
      if (!response.ok) throw new Error(`보고서 조회 실패 (${response.status})`);
      const value = await response.json();
      const releaseId = response.headers.get("x-report-release");
      if (releaseId) {
        value.releaseId = releaseId;
        if (typeof value.dashboardImage === "string") value.dashboardImage += `${value.dashboardImage.includes("?") ? "&" : "?"}release=${encodeURIComponent(releaseId)}`;
      }
      value.dataSource = response.headers.get("x-report-source") ?? (path.startsWith("/data/") ? "static-preview" : "legacy");
      return value as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("보고서를 불러오지 못했습니다.");
}
