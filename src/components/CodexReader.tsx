import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowLeft, Bookmark, ChevronRight, Search } from 'lucide-react';
import type { ArchiveEntry } from '../data/types';
import { readerPath } from '../lib/archive';
import { isDialogueRows, type DialogueRow } from '../lib/dialogue';
import type { ReadingHistory } from '../lib/storage';

export default function CodexReader({
  entry,
  chapterId,
  fontSize,
  setFontSize,
  saved,
  toggleBookmark,
  setHistory,
}: {
  entry: ArchiveEntry;
  chapterId?: string;
  fontSize: number;
  setFontSize: Dispatch<SetStateAction<number>>;
  saved: boolean;
  toggleBookmark: () => void;
  setHistory: Dispatch<SetStateAction<ReadingHistory>>;
}) {
  const selected =
    entry.chapters.find(
      (chapter) => chapter.id === chapterId || chapter.aliases?.includes(chapterId ?? ''),
    ) ??
    entry.chapters.find((chapter) => chapter.intro) ??
    entry.chapters[0];
  const [query, setQuery] = useState('');
  const [payload, setPayload] = useState<{ file: string; rows: DialogueRow[] }>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [variantChoice, setVariantChoice] = useState<{ file: string; index: number }>();
  const file = selected.content!.file;
  const list = useMemo(
    () =>
      entry.chapters.filter((chapter) =>
        chapter.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [entry, query],
  );
  const ready = payload?.file === file;
  const records = ready ? payload!.rows : [];
  const hasVariants = records.length > 0 && records.every((row) => typeof row.variant === 'string');
  const variantIndex =
    variantChoice?.file === file
      ? Math.min(variantChoice.index, records.length - 1)
      : records.length - 1;
  const displayedRows = hasVariants ? [records[variantIndex]] : records;

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch(`${import.meta.env.BASE_URL}${file}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('원문을 불러오지 못했습니다.');
        const data = await response.json();
        if (data.schema !== 'hsr-dialogue.v1' || !isDialogueRows(data.rows))
          throw new Error('자료 형식을 확인해 주세요.');
        if (!controller.signal.aborted) setPayload({ file, rows: data.rows });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : '자료를 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, [file, retry]);
  useEffect(() => {
    if (ready)
      setHistory((previous) => ({
        ...previous,
        [entry.id]: { chapterId: selected.id, scroll: 0, updatedAt: Date.now() },
      }));
  }, [ready, entry.id, selected.id, setHistory]);

  return (
    <>
      <a className="back-link" href="#/archive?category=codex">
        <ArrowLeft size={15} /> 아카이브 목록
      </a>
      <div className="codex-heading">
        <div>
          <span className="eyebrow">GALACTIC ARCHIVE</span>
          <h1>{entry.title}</h1>
          <p>{entry.description}</p>
        </div>
        <button className="button secondary" aria-pressed={saved} onClick={toggleBookmark}>
          <Bookmark size={15} fill={saved ? 'currentColor' : 'none'} />
          {saved ? '북마크됨' : '북마크'}
        </button>
      </div>
      <div className="codex-layout">
        <aside className="codex-index" aria-label={`${entry.title} 항목 목록`}>
          <label className="codex-index-search">
            <Search size={16} />
            <input
              aria-label={`${entry.title} 항목 검색`}
              placeholder="항목 이름 검색"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <p>
            {list.length.toLocaleString('ko-KR')} / {entry.chapters.length.toLocaleString('ko-KR')}
            개 항목
          </p>
          <nav>
            {list.map((chapter) => (
              <a
                key={chapter.id}
                href={`#${readerPath(entry.id, chapter.id)}`}
                className={selected.id === chapter.id ? 'active' : ''}
                aria-current={selected.id === chapter.id ? 'page' : undefined}
              >
                {chapter.title}
                <ChevronRight size={14} />
              </a>
            ))}
            {!list.length && <p className="codex-no-results">일치하는 항목이 없습니다.</p>}
          </nav>
        </aside>
        <article className="codex-article" style={{ fontSize }} aria-labelledby="codex-title">
          <header>
            <div>
              <span className="eyebrow">{entry.title}</span>
              <h2 id="codex-title">{selected.title}</h2>
            </div>
            <div className="codex-font-controls" aria-label="읽기 글자 크기">
              <button
                aria-label="글자 축소"
                disabled={fontSize <= 14}
                onClick={() => setFontSize((value) => Math.max(14, value - 1))}
              >
                A−
              </button>
              <span>{fontSize}</span>
              <button
                aria-label="글자 확대"
                disabled={fontSize >= 24}
                onClick={() => setFontSize((value) => Math.min(24, value + 1))}
              >
                A+
              </button>
            </div>
          </header>
          {error ? (
            <div className="dialogue-status" role="alert">
              <p>{error}</p>
              <button className="button secondary" onClick={() => setRetry((value) => value + 1)}>
                다시 시도
              </button>
            </div>
          ) : !ready ? (
            <div className="dialogue-status" role="status">
              한국어 원문을 불러오는 중입니다…
            </div>
          ) : (
            <div className="codex-passages">
              {hasVariants && records.length > 1 && (
                <div className="codex-variants">
                  <label>
                    본문 기록{' '}
                    <select
                      aria-label="본문 기록 선택"
                      value={variantIndex}
                      onChange={(event) =>
                        setVariantChoice({ file, index: Number(event.target.value) })
                      }
                    >
                      {records.map((row, index) => (
                        <option key={row.id} value={index}>
                          {row.variant}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p>스토리 진행에 따라 갱신되는 기록입니다.</p>
                </div>
              )}
              {displayedRows.map((row, index) => (
                <section key={row.id}>
                  {row.scene !== selected.title &&
                    row.scene !== displayedRows[index - 1]?.scene && <h3>{row.scene}</h3>}
                  <p>{row.text}</p>
                </section>
              ))}
            </div>
          )}
          <footer>
            한국어 원문 · {entry.source.kind === 'extracted' ? entry.source.version : '예시'}
            <br />
            게임 원문의 권리는 해당 권리자에게 있습니다.
          </footer>
        </article>
      </div>
    </>
  );
}
