import { useRef, useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import type { SearchText, SearchTextSource } from '../lib/search-text';
import GameText from './GameText';
import { searchTextRow, searchSourceLabel } from '../lib/search-text';
import { useLocalizations } from '../hooks/useComparison';
import { LocalizedPassage } from './LanguageComparison';
import type { ComparisonLanguage } from '../lib/localization';

export default function SearchTextResults({
  rows,
  sources,
  query,
  languages,
  referenceCommit,
}: {
  rows: SearchText[];
  sources: SearchTextSource[];
  query: string;
  languages: ComparisonLanguage[];
  referenceCommit?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<SearchText>();
  const translations = useLocalizations(
    [...rows, ...(selected ? [selected] : [])].map(searchTextRow),
    languages,
    { source: 'search', referenceCommit },
  );
  const columnStyle = { '--comparison-count': languages.length + 1 } as CSSProperties;
  return (
    <>
      {rows.map((row) => (
        <div className={`dialogue-row ${languages.length ? 'comparing' : ''}`} key={row[0]}>
          <div className="dialogue-row-meta">
            <span>{row[3] ?? '기타 텍스트'}</span>
            {row[2].length ? (
              row[2].map((id) => (
                <small key={id}>
                  {sources[id].kind}
                  {searchSourceLabel(sources[id]) && ` · ${searchSourceLabel(sources[id])}`}
                </small>
              ))
            ) : (
              <small>출처 미확인</small>
            )}
          </div>
          <div className={languages.length ? 'comparison-columns' : undefined} style={columnStyle}>
            <button
              className="dialogue-text"
              lang="ko"
              aria-haspopup="dialog"
              onClick={() => {
                setSelected(row);
                dialog.current?.showModal();
              }}
            >
              {languages.length > 0 && <span className="comparison-language-label">한국어</span>}
              <GameText text={row[1]} query={query} />
            </button>
            {languages.map((language) => (
              <LocalizedPassage
                key={language}
                row={searchTextRow(row)}
                language={language}
                {...translations}
              />
            ))}
          </div>
        </div>
      ))}
      <dialog
        className="context-dialog"
        ref={dialog}
        aria-labelledby="search-text-heading"
        onClick={(event) => {
          if (event.target === event.currentTarget) dialog.current?.close();
        }}
      >
        <header>
          <div>
            <span className="eyebrow">
              {selected?.[2].some((id) => sources[id]?.kind === '로딩 화면')
                ? '로딩 화면'
                : '기타 텍스트'}
            </span>
            <h2 id="search-text-heading">{selected?.[3] ?? '한국어 원문'}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="원문 닫기"
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
        </header>
        <div className="context-dialog-body">
          <div className="context-row" lang="ko">
            <div
              className={languages.length ? 'comparison-columns' : undefined}
              style={columnStyle}
            >
              <div className="comparison-korean" lang="ko">
                {languages.length > 0 && <span className="comparison-language-label">한국어</span>}
                <p>{selected && <GameText text={selected[1]} query={query} />}</p>
              </div>
              {selected &&
                languages.map((language) => (
                  <LocalizedPassage
                    key={language}
                    row={searchTextRow(selected)}
                    language={language}
                    {...translations}
                  />
                ))}
            </div>
          </div>
        </div>
        <footer>
          <p>게임 원문의 권리는 HoYoverse 및 해당 권리자에게 있습니다.</p>
        </footer>
      </dialog>
    </>
  );
}
