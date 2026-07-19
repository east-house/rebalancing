import type { AssetType } from "../domain";

export interface Instrument {
  ticker: string;
  name: string;
  market: string;
  country: "KR" | "US";
  assetType: AssetType;
}

export interface InstrumentCatalogMeta {
  generatedAt: string;
  counts: {
    total: number;
    krStocks: number;
    krEtfs: number;
    usStocks: number;
    usEtfs: number;
  };
}

export interface InstrumentCatalogPayload {
  meta: InstrumentCatalogMeta;
  instruments: Instrument[];
}
