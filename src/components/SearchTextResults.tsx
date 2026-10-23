import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { SearchText, SearchTextSource } from '../lib/search-text';
import GameText from './GameText';

export default function SearchTextResults({
  rows,
  sources,
  query,
}: {
  rows: SearchText[];
  sources: SearchTextSource[];
  query: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<SearchText>();
  return (
    <>
      {rows.map((row) => (
        <div className="dialogue-row" key={row[0]}>
          <div className="dialogue-row-meta">
            <span>기타 텍스트</span>
            {row[2].length ? (
              row[2].map((id) => (
                <small key={id}>
                  {sources[id].kind} · {sources[id].label}
                </small>
              ))
            ) : (
              <small>출처 미확인</small>
            )}
          </div>
          <button
            className="dialogue-text"
            lang="ko"
            aria-haspopup="dialog"
            onClick={() => {
              setSelected(row);
              dialog.current?.showModal();
            }}
          >
            <GameText text={row[1]} query={query} />
          </button>
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
            <span className="eyebrow">기타 텍스트</span>
            <h2 id="search-text-heading">한국어 원문</h2>
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
            <p>{selected && <GameText text={selected[1]} query={query} />}</p>
          </div>
        </div>
        <footer>
          {selected?.[2].map((id) => {
            const source = sources[id];
            return (
              <p key={id}>
                {source.kind} ·{' '}
                <a
                  href={`https://wiki.biligame.com/sr/${encodeURIComponent(source.pageTitle)}?oldid=${source.revision}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.label} (BWIKI)
                </a>
              </p>
            );
          })}
          {!!selected?.[2].length && (
            <p>
              BWIKI에서 같은 중국어 원문이 확인된 문서입니다. 분류·출처 정보는{' '}
              <a
                href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
                target="_blank"
                rel="noreferrer"
              >
                CC BY-NC-SA 4.0
              </a>
              에 따라 재구성했습니다.
            </p>
          )}
          <p>게임 원문의 권리는 HoYoverse 및 해당 권리자에게 있습니다.</p>
        </footer>
      </dialog>
    </>
  );
}
