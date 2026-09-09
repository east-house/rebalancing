import { useEffect, useState } from "react";

export function useReportRefresh(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) setRevision((value) => value + 1); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return revision;
}
