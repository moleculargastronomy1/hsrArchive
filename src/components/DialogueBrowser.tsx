import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  MessageSquareText,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { archive, categories } from '../data/archive';
import { readerPath } from '../lib/archive';
import { isDialogueRows, nearbyDialogue, type DialogueRow } from '../lib/dialogue';
import { useStored } from '../lib/storage';
import { useComparisonLanguages, useLocalizations } from '../hooks/useComparison';
import { LanguageComparisonControls, LocalizedPassage } from './LanguageComparison';
import type { ComparisonLanguage } from '../lib/localization';

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  return (
    <>
      {text
        .split(regex)
        .map((part, index) =>
          terms.some((term) => term.toLocaleLowerCase() === part.toLocaleLowerCase()) ? (
            <mark key={index}>{part}</mark>
          ) : (
            part
          ),
        )}
    </>
  );
}

export default function DialogueBrowser({
  file = 'content/search-index.json',
  initialQuery = '',
  global = false,
  onReady,
  languages: controlledLanguages,
}: {
  file?: string;
  initialQuery?: string;
  global?: boolean;
  onReady?: () => void;
  languages?: ComparisonLanguage[];
}) {
  const [storedLanguages, setLanguages] = useComparisonLanguages();
  const languages = controlledLanguages ?? storedLanguages;
  const [rows, setRows] = useState<DialogueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [scope, setScope] = useState('all');
  const [matches, setMatches] = useState<number[]>([]);
  const [searching, setSearching] = useState(false);
  const [savedPage, setSavedPage] = useStored<number>(
    `dialogue-page:${file}`,
    1,
    (value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0,
  );
  const [page, setPage] = useState(savedPage);
  const [pageInput, setPageInput] = useState(String(savedPage));
  const restorePage = useRef(true);
  const [selected, setSelected] = useState<number>();
  const version = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const tableTop = useRef<HTMLDivElement>(null);
  const pageSize = 50;
  const entries = useMemo(() => new Map(archive.map((entry) => [entry.id, entry])), []);

  useEffect(() => {
    setDraft(initialQuery);
    setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setRows([]);
    setMatches([]);
    setSelected(undefined);
    if (!/^content\/[a-zA-Z0-9_-]+\.json$/.test(file)) {
      setError('자료 주소를 확인해 주세요.');
      setLoading(false);
      return;
    }
    fetch(`${import.meta.env.BASE_URL}${file}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`본문을 불러오지 못했습니다 (${response.status}).`);
        const data = await response.json();
        if (data.schema !== 'hsr-dialogue.v1' || !isDialogueRows(data.rows))
          throw new Error('본문의 자료 형식을 확인해 주세요.');
        if (!controller.signal.aborted) {
          setRows(data.rows);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : '본문을 불러오지 못했습니다.');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [file, retry]);
  const searchIndex = useMemo(
    () =>
      rows.map((row) =>
        `${row.mission} ${row.scene} ${row.speaker} ${row.text}`.toLocaleLowerCase(),
      ),
    [rows],
  );
  useEffect(() => {
    const token = ++version.current;
    if (loading) return;
    const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    setSearching(true);
    const timer = setTimeout(async () => {
      const result: number[] = [];
      for (let start = 0; start < rows.length; start += 2000) {
        if (version.current !== token) return;
        for (let index = start; index < Math.min(start + 2000, rows.length); index++) {
          if (
            (scope === 'all' || entries.get(rows[index].entryId)?.category === scope) &&
            terms.every((term) => searchIndex[index].includes(term))
          )
            result.push(index);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (version.current === token) {
        setMatches(result);
        setPage(
          restorePage.current && !query
            ? Math.min(savedPage, Math.max(1, Math.ceil(result.length / pageSize)))
            : 1,
        );
        restorePage.current = false;
        setSearching(false);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      version.current++;
    };
  }, [rows, query, scope, searchIndex, entries, loading]);
  useEffect(() => {
    if (!loading && !searching && !error && !restorePage.current) onReady?.();
  }, [loading, searching, error, onReady]);
  useEffect(() => {
    if (selected !== undefined && !dialog.current?.open) {
      dialog.current?.showModal();
      requestAnimationFrame(() =>
        dialog.current?.querySelector('.context-selected')?.scrollIntoView({ block: 'center' }),
      );
    }
  }, [selected]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setQuery(draft.trim());
  };
  const changePage = (next: number) => {
    setPage(next);
    if (!query && scope === 'all') setSavedPage(next);
    tableTop.current?.scrollIntoView({ block: 'start' });
  };
  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  useEffect(() => setPageInput(String(page)), [page, totalPages]);
  const jumpToPage = (event: FormEvent) => {
    event.preventDefault();
    const next = Number(pageInput);
    if (Number.isInteger(next) && next >= 1 && next <= totalPages) changePage(next);
  };
  const visible = matches.slice((page - 1) * pageSize, page * pageSize);
  const context = selected === undefined ? [] : nearbyDialogue(rows, selected);
  const selectedRow = selected === undefined ? undefined : rows[selected];
  const translations = useLocalizations(
    [...visible.map((index) => rows[index]), ...context],
    languages,
  );
  const columnStyle = { '--comparison-count': languages.length + 1 } as CSSProperties;
  const closeDialog = () => {
    dialog.current?.close();
    setSelected(undefined);
  };

  return (
    <section
      className={`dialogue-browser ${global ? 'global-dialogue-browser' : ''}`}
      aria-label={global ? '전체 원문 검색' : '한국어 본문'}
    >
      {controlledLanguages === undefined && (
        <LanguageComparisonControls languages={languages} onChange={setLanguages} />
      )}
      <form className="dialogue-search" onSubmit={submit}>
        <Search size={17} />
        <input
          aria-label={global ? '원문 검색어' : '이 장에서 검색'}
          placeholder={
            global ? '임무명, 서적명, 화자, 원문을 검색해 보세요' : '이 장에서 화자나 대사 검색'
          }
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="button primary" type="submit" disabled={loading}>
          검색
        </button>
      </form>
      {global && (
        <div className="dialogue-scopes" aria-label="대사 검색 범위">
          {[['all', '전체'], ...categories.map((category) => [category.id, category.label])].map(
            ([id, label]) => (
              <button
                key={id}
                className={scope === id ? 'active' : ''}
                aria-pressed={scope === id}
                onClick={() => setScope(id)}
              >
                {label}
              </button>
            ),
          )}
        </div>
      )}
      <p className="dialogue-help">
        대사를 누르면 같은 장면의 앞뒤 대사를 볼 수 있습니다. 선택지와 분기는 자료에 남은 순서대로
        함께 표시됩니다.
      </p>
      {loading ? (
        <div className="dialogue-status" role="status">
          <BookOpen size={22} />
          <p>한국어 원문을 불러오는 중입니다…</p>
        </div>
      ) : error ? (
        <div className="dialogue-status" role="alert">
          <p>{error}</p>
          <button className="button secondary" onClick={() => setRetry((value) => value + 1)}>
            <RotateCcw size={14} />
            다시 시도
          </button>
        </div>
      ) : (
        <>
          <div className="dialogue-result-bar" ref={tableTop} aria-live="polite">
            <span>
              {searching
                ? '검색 중…'
                : `${matches.length.toLocaleString('ko-KR')}줄${query ? ` · “${query}”` : ''}`}
            </span>
            {query && (
              <button
                className="text-link"
                onClick={() => {
                  setDraft('');
                  setQuery('');
                }}
              >
                검색 지우기 <X size={12} />
              </button>
            )}
          </div>
          {!searching && !matches.length ? (
            <div className="dialogue-status">
              <p>
                {rows.length
                  ? '일치하는 대사가 없습니다.'
                  : '이 항목에서 확인된 한국어 대사가 없습니다.'}
              </p>
            </div>
          ) : (
            <div className="dialogue-table" aria-busy={searching}>
              {visible.map((index) => {
                const row = rows[index];
                const entry = entries.get(row.entryId);
                return (
                  <div
                    className={`dialogue-row ${row.type === 'choice' ? 'choice-row' : ''} ${languages.length ? 'comparing' : ''}`}
                    key={row.id}
                  >
                    <div className="dialogue-row-meta">
                      <span>
                        {entry?.category === 'books'
                          ? '서적 원문'
                          : row.type === 'choice'
                            ? '선택지'
                            : row.speaker || '장면 설명'}
                      </span>
                      <small>{row.mission}</small>
                      {global && (
                        <a href={`#${readerPath(row.entryId, row.chapterId)}`}>
                          {entry?.arcLabel ?? entry?.title}
                          <ArrowRight size={11} />
                        </a>
                      )}
                    </div>
                    <div
                      className={languages.length ? 'comparison-columns' : undefined}
                      style={columnStyle}
                    >
                      <button
                        className="dialogue-text"
                        lang="ko"
                        onClick={() => setSelected(index)}
                        aria-haspopup="dialog"
                      >
                        {languages.length > 0 && (
                          <span className="comparison-language-label">한국어</span>
                        )}
                        <Highlight text={row.text} query={query} />
                      </button>
                      {languages.map((language) => (
                        <LocalizedPassage
                          key={language}
                          row={row}
                          language={language}
                          {...translations}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <nav className="dialogue-pagination" aria-label="대사 페이지 이동">
            <button
              className="button secondary"
              disabled={page <= 1 || searching}
              onClick={() => changePage(page - 1)}
            >
              <ArrowLeft size={14} />
              이전
            </button>
            <form className="page-jump" onSubmit={jumpToPage}>
              <input
                type="number"
                aria-label="이동할 페이지"
                min={1}
                max={totalPages}
                step={1}
                required
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                disabled={searching}
              />
              <span>/ {totalPages} 페이지</span>
              <button className="button secondary" type="submit" disabled={searching}>
                이동
              </button>
            </form>
            <button
              className="button secondary"
              disabled={page >= totalPages || searching}
              onClick={() => changePage(page + 1)}
            >
              다음
              <ArrowRight size={14} />
            </button>
          </nav>
        </>
      )}
      <dialog
        className="context-dialog"
        ref={dialog}
        onClose={() => setSelected(undefined)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
        aria-labelledby="context-heading"
      >
        <header>
          <div>
            <span className="eyebrow">DIALOGUE CONTEXT</span>
            <h2 id="context-heading">
              <MessageSquareText size={19} />
              {selectedRow && entries.get(selectedRow.entryId)?.category === 'books'
                ? '서적 원문'
                : '앞뒤 대사'}
            </h2>
            <p>
              {selectedRow?.mission} · {selectedRow?.scene}
            </p>
          </div>
          <button className="icon-button" aria-label="앞뒤 대사 닫기" onClick={closeDialog}>
            <X size={20} />
          </button>
        </header>
        <div className="context-dialog-body">
          {context.map((row) => (
            <div
              key={row.id}
              className={`context-row ${row.id === selectedRow?.id ? 'context-selected' : ''}`}
            >
              <strong>
                {entries.get(row.entryId)?.category === 'books'
                  ? row.scene
                  : row.type === 'choice'
                    ? '선택지'
                    : row.speaker || '장면 설명'}
              </strong>
              <div
                className={languages.length ? 'comparison-columns' : undefined}
                style={columnStyle}
              >
                <div className="comparison-korean" lang="ko">
                  {languages.length > 0 && (
                    <span className="comparison-language-label">한국어</span>
                  )}
                  <p>
                    <Highlight text={row.text} query={query} />
                  </p>
                </div>
                {languages.map((language) => (
                  <LocalizedPassage
                    key={language}
                    row={row}
                    language={language}
                    {...translations}
                  />
                ))}
              </div>
              {row.id === selectedRow?.id && <small>선택한 대사</small>}
            </div>
          ))}
        </div>
        <footer>
          {selectedRow && entries.get(selectedRow.entryId)?.category === 'books'
            ? '서적 원문은 선택한 권 단위로 표시합니다.'
            : '같은 장면 안에서 최대 앞뒤 20줄을 표시합니다.'}
        </footer>
      </dialog>
    </section>
  );
}
