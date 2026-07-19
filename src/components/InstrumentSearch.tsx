import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { Search } from "lucide-react";

import type { Instrument } from "../types/instrument";
import "./InstrumentSearch.css";

interface InstrumentSearchProps {
  instruments: readonly Instrument[];
  value: string;
  selectedName: string;
  onSelect: (instrument: Instrument) => void;
  hasError?: boolean;
  ariaLabel?: string;
}

interface SearchableInstrument {
  instrument: Instrument;
  tickerKey: string;
  nameKey: string;
}

const indexCache = new WeakMap<
  readonly Instrument[],
  readonly SearchableInstrument[]
>();

function normalizeSearch(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s._()/\-]/g, "")
    .replace(/[\[\]]/g, "");
}

function getSearchIndex(
  instruments: readonly Instrument[],
): readonly SearchableInstrument[] {
  const cached = indexCache.get(instruments);
  if (cached) return cached;

  const index = instruments.map((instrument) => ({
    instrument,
    tickerKey: normalizeSearch(instrument.ticker),
    nameKey: normalizeSearch(instrument.name),
  }));
  indexCache.set(instruments, index);
  return index;
}

export function searchInstruments(
  instruments: readonly Instrument[],
  query: string,
  limit = 8,
) {
  const queryKey = normalizeSearch(query);
  if (!queryKey) return [];
  const prefersKorean = /[가-힣]/.test(query);

  return getSearchIndex(instruments)
    .flatMap((item) => {
      let score = Number.POSITIVE_INFINITY;
      if (item.tickerKey === queryKey) score = 0;
      else if (item.tickerKey.startsWith(queryKey)) score = 1;
      else if (item.nameKey.startsWith(queryKey)) score = 2;
      else if (item.nameKey.includes(queryKey)) score = 3;
      else if (item.tickerKey.includes(queryKey)) score = 4;

      if (!Number.isFinite(score)) return [];
      const countryScore =
        prefersKorean && item.instrument.country === "KR" ? -0.25 : 0;
      return [{ ...item, score: score + countryScore }];
    })
    .sort(
      (first, second) =>
        first.score - second.score ||
        first.instrument.ticker.localeCompare(second.instrument.ticker),
    )
    .slice(0, limit)
    .map((item) => item.instrument);
}

function InstrumentSearch({
  instruments,
  value,
  selectedName,
  onSelect,
  hasError = false,
  ariaLabel,
}: InstrumentSearchProps) {
  const [query, setQuery] = useState(value);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rawId = useId();
  const listboxId = `instrument-results-${rawId.replace(/:/g, "")}`;
  const results = useMemo(
    () => searchInstruments(instruments, query),
    [instruments, query],
  );

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const selectInstrument = (instrument: Instrument) => {
    setQuery(instrument.ticker);
    setIsOpen(false);
    onSelect(instrument);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && results.length > 0) {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((current) => Math.min(results.length - 1, current + 1));
      return;
    }
    if (event.key === "ArrowUp" && results.length > 0) {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      selectInstrument(results[activeIndex]);
      return;
    }
    if (event.key === "Escape") {
      setIsOpen(false);
      setQuery(value);
    }
  };

  return (
    <div className="instrument-search">
      <Search className="instrument-search__icon" size={13} aria-hidden="true" />
      <input
        aria-label={
          ariaLabel ?? `${selectedName || value || "종목"} 검색`
        }
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={isOpen && results.length > 0}
        aria-activedescendant={
          isOpen && results[activeIndex]
            ? `${listboxId}-${activeIndex}`
            : undefined
        }
        className={hasError ? "input-error" : ""}
        role="combobox"
        value={query}
        inputMode="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={60}
        placeholder="Ticker 또는 종목명"
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          window.setTimeout(() => {
            setIsOpen(false);
            setQuery(value);
          }, 100);
        }}
      />

      {isOpen && query.trim() && (
        <div
          className="instrument-search__results"
          id={listboxId}
          role="listbox"
          aria-label="종목 검색 결과"
        >
          {results.length > 0 ? (
            results.map((instrument, index) => (
              <button
                key={`${instrument.country}-${instrument.ticker}`}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectInstrument(instrument)}
              >
                <span className="instrument-search__ticker">
                  {instrument.ticker}
                </span>
                <span className="instrument-search__name">{instrument.name}</span>
                <span className="instrument-search__meta">
                  {instrument.country} · {instrument.market} · {instrument.assetType}
                </span>
              </button>
            ))
          ) : (
            <div className="instrument-search__empty">
              검색 결과가 없습니다
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default InstrumentSearch;
