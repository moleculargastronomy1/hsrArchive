import {
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
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
import {
  choiceDialogue,
  dialoguePage,
  isDialogueRows,
  nearbyDialogue,
  type DialogueRow,
} from '../lib/dialogue';
import { useStored } from '../lib/storage';
import { useComparisonLanguages, useLocalizations } from '../hooks/useComparison';
import { LanguageComparisonControls, LocalizedPassage } from './LanguageComparison';
import { localizationKey, type ComparisonLanguage } from '../lib/localization';
import GameText from './GameText';
import VideoVerificationNote from './VideoVerificationNote';
import SourceDetails from './SourceDetails';
import SearchTextResults from './SearchTextResults';
import { useSearchText } from '../hooks/useSearchText';
import { searchTextWindow, otherTextCategories, type OtherTextFilter } from '../lib/search-text';
import { searchableGameText } from '../lib/game-text';
import {
  isWikiReading,
  isExecutionReading,
  readingRows,
  positionKey,
  type WikiReading,
  type ExecutionReading,
} from '../lib/wiki-reading';

interface DialogueDocument {
  rows: DialogueRow[];
  wikiReading?: WikiReading;
  executionReading?: ExecutionReading;
}

async function loadDialogueDocument(file: string, signal: AbortSignal): Promise<DialogueDocument> {
  if (!/^content\/[a-zA-Z0-9_-]+\.json$/.test(file)) throw new Error('자료 주소를 확인해 주세요.');
  const response = await fetch(`${import.meta.env.BASE_URL}${file}`, { signal });
  if (!response.ok) throw new Error(`본문을 불러오지 못했습니다 (${response.status}).`);
  const data = await response.json();
  if (data.schema !== 'hsr-dialogue.v1' || !isDialogueRows(data.rows))
    throw new Error('본문의 자료 형식을 확인해 주세요.');
  if (data.wikiReading !== undefined && !isWikiReading(data.wikiReading, data.rows))
    throw new Error('출현 위치의 자료 형식을 확인해 주세요.');
  if (data.executionReading !== undefined && !isExecutionReading(data.executionReading, data.rows))
    throw new Error('대사 연결의 자료 형식을 확인해 주세요.');
  return data;
}

export default function DialogueBrowser({
  file = 'content/search-index.json',
  initialQuery = '',
  initialScope = 'all',
  initialOtherKind = 'all',
  onScopeChange,
  global = false,
  onReady,
  targetRowId,
  targetOccurrenceId,
  languages: controlledLanguages,
  footer,
  sourceNote,
}: {
  file?: string;
  initialQuery?: string;
  initialScope?: string;
  initialOtherKind?: OtherTextFilter;
  onScopeChange?: (scope: string, kind: OtherTextFilter, query: string) => void;
  global?: boolean;
  onReady?: () => void;
  targetRowId?: string;
  targetOccurrenceId?: string;
  languages?: ComparisonLanguage[];
  footer?: ReactNode;
  sourceNote?: string;
}) {
  const [storedLanguages, setLanguages] = useComparisonLanguages();
  const languages = controlledLanguages ?? storedLanguages;
  const [canonicalRows, setRows] = useState<DialogueRow[]>([]);
  const [reading, setReading] = useState<WikiReading>();
  const [execution, setExecution] = useState<ExecutionReading>();
  const rows = useMemo(
    () => readingRows(canonicalRows, reading, execution),
    [canonicalRows, reading, execution],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState(initialQuery);
  const [draft, setDraft] = useState(initialQuery);
  const [scope, setScope] = useState(initialScope);
  const [otherKind, setOtherKind] = useState<OtherTextFilter>(initialOtherKind);
  const onlyOther = global && scope === 'other';
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
  const [contextMode, setContextMode] = useState<'position' | 'existing'>('position');
  const [contextDocument, setContextDocument] = useState<{
    file: string;
    data: DialogueDocument;
  }>();
  const [contextOccurrence, setContextOccurrence] = useState<string>();
  const [contextError, setContextError] = useState('');
  const [contextRetry, setContextRetry] = useState(0);
  const version = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const tableTop = useRef<HTMLDivElement>(null);
  const targetRow = useRef<HTMLDivElement>(null);
  const targetFocused = useRef(false);
  const pageSize = 50;
  const entries = useMemo(() => new Map(archive.map((entry) => [entry.id, entry])), []);

  useEffect(() => {
    setDraft(initialQuery);
    setQuery(initialQuery);
  }, [initialQuery]);
  useEffect(() => {
    setScope(initialScope);
    setOtherKind(initialOtherKind);
    setPage(1);
  }, [initialScope, initialOtherKind]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setRows([]);
    setReading(undefined);
    setExecution(undefined);
    setMatches([]);
    setSelected(undefined);
    if (onlyOther) {
      setLoading(false);
      return () => controller.abort();
    }
    loadDialogueDocument(file, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setRows(data.rows);
          setReading(data.wikiReading);
          setExecution(data.executionReading);
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
  }, [file, retry, onlyOther]);
  const searchIndex = useMemo(
    () =>
      rows.map((row) =>
        `${row.bwikiMission ?? row.mission} ${row.scene} ${row.speaker} ${searchableGameText(row.text)}`.toLocaleLowerCase(),
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
        const targetPage =
          restorePage.current && targetRowId && !query && scope === 'all'
            ? targetOccurrenceId &&
              rows.some((row) => positionKey(row) === targetOccurrenceId && row.id === targetRowId)
              ? Math.floor(
                  rows.findIndex(
                    (row) => positionKey(row) === targetOccurrenceId && row.id === targetRowId,
                  ) / pageSize,
                ) + 1
              : dialoguePage(rows, targetRowId, pageSize)
            : undefined;
        setMatches(result);
        setPage(
          targetPage ??
            (restorePage.current && !query
              ? global
                ? savedPage
                : Math.min(savedPage, Math.max(1, Math.ceil(result.length / pageSize)))
              : 1),
        );
        if (targetPage !== undefined) setSavedPage(targetPage);
        restorePage.current = false;
        setSearching(false);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      version.current++;
    };
  }, [rows, query, scope, searchIndex, entries, loading, targetRowId, targetOccurrenceId]);
  useEffect(() => {
    if (!loading && !searching && !error && !restorePage.current) onReady?.();
  }, [loading, searching, error, onReady]);
  useEffect(() => {
    if (selected === undefined) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    const frame = requestAnimationFrame(() => {
      dialog.current?.querySelector('.context-selected')?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
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
  const extraWindow = searchTextWindow(matches.length, page, pageSize);
  const extra = useSearchText(
    global && (scope === 'all' || onlyOther),
    query,
    extraWindow.offset,
    extraWindow.limit,
    onlyOther ? otherKind : undefined,
  );
  const totalMatches = matches.length + extra.count;
  const busy = searching || extra.loading;
  const totalPages = Math.max(1, Math.ceil(totalMatches / pageSize));
  useEffect(() => {
    if (!loading && !busy && page > totalPages) setPage(totalPages);
  }, [loading, busy, page, totalPages]);
  useEffect(() => setPageInput(String(page)), [page, totalPages]);
  const jumpToPage = (event: FormEvent) => {
    event.preventDefault();
    const next = Number(pageInput);
    if (Number.isInteger(next) && next >= 1 && next <= totalPages) changePage(next);
  };
  const visible = matches.slice((page - 1) * pageSize, page * pageSize);
  const originRow = selected === undefined ? undefined : rows[selected];
  const contextFile =
    global && originRow
      ? entries
          .get(originRow.entryId)
          ?.chapters.find((chapter) => chapter.id === originRow.chapterId)?.content?.file
      : undefined;
  useEffect(() => {
    setContextError('');
    if (!global || !originRow) return;
    if (!contextFile) {
      setContextError('이 대사의 본문을 찾지 못했습니다.');
      return;
    }
    if (contextDocument?.file === contextFile) return;
    const controller = new AbortController();
    loadDialogueDocument(contextFile, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setContextDocument({ file: contextFile, data });
      })
      .catch((err) => {
        if (!controller.signal.aborted)
          setContextError(err instanceof Error ? err.message : '본문을 불러오지 못했습니다.');
      });
    return () => controller.abort();
  }, [global, contextFile, contextDocument?.file, contextRetry, originRow?.id]);
  const loadedContext =
    global && contextDocument?.file === contextFile ? contextDocument?.data : undefined;
  const contextCanonical = loadedContext?.rows ?? canonicalRows;
  const contextRows = useMemo(
    () =>
      loadedContext
        ? readingRows(loadedContext.rows, loadedContext.wikiReading, loadedContext.executionReading)
        : rows,
    [loadedContext, rows],
  );
  const occurrences =
    global && loadedContext && originRow
      ? contextRows.filter((row) => row.id === originRow.id)
      : [];
  const contextIndex = global
    ? contextRows.findIndex(
        (row) =>
          row.id === originRow?.id &&
          (!contextOccurrence || positionKey(row) === contextOccurrence),
      )
    : (selected ?? -1);
  const selectedRow = contextRows[contextIndex] ?? originRow;
  const contextMismatch =
    global &&
    loadedContext &&
    originRow &&
    (!selectedRow ||
      selectedRow.text !== originRow.text ||
      selectedRow.speaker !== originRow.speaker ||
      selectedRow.type !== originRow.type ||
      !occurrences.length);
  const contextPending = global && !!originRow && !loadedContext;
  const linkedChoice =
    selectedRow?.type === 'choice' &&
    ((selectedRow.wikiPosition || selectedRow.executionPosition) && contextMode !== 'existing'
      ? (selectedRow.wikiPosition ?? selectedRow.executionPosition)!.nextIds.length > 0
      : selectedRow.flowStatus === 'verified' ||
        ['matched', 'cached'].includes(selectedRow.bwikiStatus ?? ''));
  const context = useMemo(
    () =>
      selected === undefined || contextPending || contextMismatch
        ? []
        : contextMode === 'existing'
          ? (selectedRow?.type === 'choice' ? choiceDialogue : nearbyDialogue)(
              contextCanonical,
              contextCanonical.findIndex((row) => row.id === selectedRow?.id),
            )
          : linkedChoice
            ? choiceDialogue(contextRows, contextIndex)
            : nearbyDialogue(contextRows, contextIndex),
    [
      contextRows,
      contextCanonical,
      selected,
      selectedRow,
      contextIndex,
      contextPending,
      contextMismatch,
      linkedChoice,
      contextMode,
    ],
  );
  const byId = useMemo(() => new Map(contextRows.map((row) => [row.id, row])), [contextRows]);
  const byPosition = useMemo(
    () =>
      new Map(
        contextRows
          .filter((row) => row.wikiPosition || row.executionPosition)
          .map((row) => [positionKey(row), row]),
      ),
    [contextRows],
  );
  const occurrenceIndex = targetOccurrenceId
    ? rows.findIndex((row) => positionKey(row) === targetOccurrenceId && row.id === targetRowId)
    : -1;
  const targetIndex =
    occurrenceIndex >= 0 ? occurrenceIndex : rows.findIndex((row) => row.id === targetRowId);
  const flowSummary = useMemo(
    () => ({
      verified: canonicalRows.filter((row) => row.flowStatus === 'verified').length,
      review: canonicalRows.filter((row) => row.flowStatus === 'review').length,
      wiki: canonicalRows.filter((row) => row.bwikiStatus === 'matched').length,
      cached: canonicalRows.filter((row) => row.bwikiStatus === 'cached').length,
    }),
    [canonicalRows],
  );
  const translations = useLocalizations(
    [...visible.map((index) => rows[index]), ...context],
    languages,
  );
  const targetRecord = targetRowId ? rows.find((row) => row.id === targetRowId) : undefined;
  const targetTranslationsReady =
    !targetRecord ||
    languages.every((language) => translations.states[localizationKey(targetRecord, language)]);
  useEffect(() => {
    if (
      loading ||
      searching ||
      restorePage.current ||
      targetFocused.current ||
      !targetTranslationsReady ||
      !targetRow.current
    )
      return;
    const frame = requestAnimationFrame(() => {
      const row = targetRow.current;
      if (!row) return;
      row.scrollIntoView({
        block: row.offsetHeight > window.innerHeight - 160 ? 'start' : 'center',
      });
      row.focus({ preventScroll: true });
      targetFocused.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, searching, page, targetRowId, targetTranslationsReady]);
  const columnStyle = {
    '--comparison-count': languages.length + 1,
  } as CSSProperties;
  const closeDialog = () => {
    dialog.current?.close();
    setSelected(undefined);
  };
  const openContext = (index: number) => {
    setContextOccurrence(undefined);
    setContextMode(rows[index].wikiLegacy ? 'existing' : 'position');
    setSelected(index);
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
            global
              ? '임무명, 서적명, 화자, 전체 원문을 검색해 보세요'
              : '이 장에서 화자나 대사 검색'
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
          {[
            ['all', '전체'],
            ...categories.map((category) => [category.id, category.label]),
            ['other', '기타'],
          ].map(([id, label]) => (
            <button
              key={id}
              className={scope === id ? 'active' : ''}
              aria-pressed={scope === id}
              onClick={() => {
                setScope(id);
                setOtherKind('all');
                setPage(1);
                onScopeChange?.(id, 'all', query);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {onlyOther && (
        <div className="dialogue-scopes" aria-label="기타 소분류">
          {[{ id: 'all' as const, label: '전체' }, ...otherTextCategories].map((category) => (
            <button
              key={category.id}
              className={otherKind === category.id ? 'active' : ''}
              aria-pressed={otherKind === category.id}
              onClick={() => {
                setOtherKind(category.id);
                setPage(1);
                onScopeChange?.('other', category.id, query);
              }}
            >
              {category.label}
            </button>
          ))}
        </div>
      )}
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
              {busy
                ? '검색 중…'
                : `${totalMatches.toLocaleString('ko-KR')}줄${query ? ` · “${query}”` : ''}`}
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
          {extra.error && (
            <div className="dialogue-status" role="alert">
              <p>{extra.error} 기존 자료의 검색 결과는 계속 표시합니다.</p>
              <button className="button secondary" onClick={extra.retry}>
                다시 시도
              </button>
            </div>
          )}
          {!busy && !totalMatches ? (
            <div className="dialogue-status">
              <p>
                {rows.length || onlyOther
                  ? '일치하는 원문이 없습니다.'
                  : '이 항목에서 확인된 한국어 대사가 없습니다.'}
              </p>
            </div>
          ) : (
            <div className="dialogue-table" aria-busy={busy}>
              {visible.map((index) => {
                const row = rows[index];
                const position = row.wikiPosition ?? row.executionPosition;
                const isTarget = index === targetIndex;
                const entry = entries.get(row.entryId);
                return (
                  <Fragment key={positionKey(row)}>
                    <div
                      className={`dialogue-row ${row.type === 'choice' ? 'choice-row' : ''} ${languages.length ? 'comparing' : ''} ${isTarget ? 'dialogue-target' : ''}`}
                      ref={isTarget ? targetRow : undefined}
                      tabIndex={isTarget ? -1 : undefined}
                      data-dialogue-id={row.id}
                      data-occurrence-id={position?.id}
                    >
                      <div className="dialogue-row-meta">
                        <span>
                          {entry?.category === 'books'
                            ? '서적 원문'
                            : row.type === 'choice'
                              ? '선택지'
                              : row.speaker || '장면 설명'}
                        </span>
                        <small>{position?.mission ?? row.bwikiMission ?? row.mission}</small>
                        {global && (
                          <a href={`#${readerPath(row.entryId, row.chapterId, row.id)}`}>
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
                          onClick={() => openContext(index)}
                          aria-haspopup="dialog"
                        >
                          {languages.length > 0 && (
                            <span className="comparison-language-label">한국어</span>
                          )}
                          <GameText text={row.text} query={query} />
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
                  </Fragment>
                );
              })}
              {global && (
                <SearchTextResults rows={extra.rows} sources={extra.sources} query={query}
                  languages={languages} referenceCommit={extra.commit} />
              )}
            </div>
          )}
          <nav className="dialogue-pagination" aria-label="대사 페이지 이동">
            <button
              className="button secondary"
              disabled={page <= 1 || busy}
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
                disabled={busy}
              />
              <span>/ {totalPages} 페이지</span>
              <button className="button secondary" type="submit" disabled={busy}>
                이동
              </button>
            </form>
            <button
              className="button secondary"
              disabled={page >= totalPages || busy}
              onClick={() => changePage(page + 1)}
            >
              다음
              <ArrowRight size={14} />
            </button>
          </nav>
        </>
      )}
      {footer}
      {(sourceNote ||
        (!loading && !error && (flowSummary.verified > 0 || flowSummary.review > 0))) && (
        <SourceDetails>
          {sourceNote && (
            <>
              <p>{sourceNote}</p>
              <p>게임 원문의 권리는 HoYoverse 및 해당 권리자에게 있습니다.</p>
            </>
          )}
          {!loading && !error && (
            <p className="dialogue-flow-summary">
              {(flowSummary.wiki > 0 || flowSummary.cached > 0) && (
                <span>
                  BWIKI 대조 {flowSummary.wiki.toLocaleString('ko-KR')}줄 · 이전 대조 유지{' '}
                  {flowSummary.cached.toLocaleString('ko-KR')}줄
                </span>
              )}
              {rows.some((row) => row.bwikiStatus) && (
                <span>
                  순서·분기 참고:{' '}
                  <a href="https://wiki.biligame.com/sr/开拓任务" target="_blank" rel="noreferrer">
                    BWIKI 기여자
                  </a>{' '}
                  ·{' '}
                  <a
                    href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    CC BY-NC-SA 4.0
                  </a>
                  . 정리 정보를 한국어 자료에 맞춰 재구성했습니다.
                </span>
              )}
              <VideoVerificationNote file={file} />
            </p>
          )}
        </SourceDetails>
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
            <span className="eyebrow">대사 문맥</span>
            <h2 id="context-heading">
              <MessageSquareText size={19} />
              {selectedRow && entries.get(selectedRow.entryId)?.category === 'books'
                ? '서적 원문'
                : contextMode === 'existing' && selectedRow?.wikiPosition
                  ? '다른 대화'
                  : linkedChoice
                    ? '선택지 응답'
                    : '앞뒤 대사'}
            </h2>
            <p>
              {selectedRow?.wikiPosition?.mission ??
                selectedRow?.bwikiMission ??
                selectedRow?.mission}
            </p>
          </div>
          <button className="icon-button" aria-label="앞뒤 대사 닫기" onClick={closeDialog}>
            <X size={20} />
          </button>
        </header>
        <div className="context-dialog-body">
          {contextPending && !contextError && <p role="status">주변 대사를 불러오는 중입니다…</p>}
          {(contextError || contextMismatch) && (
            <div role="alert">
              <p>{contextError || '검색 자료와 본문이 달라졌습니다. 다시 검색해 주세요.'}</p>
              {contextError && (
                <button
                  className="button secondary"
                  onClick={() => setContextRetry(contextRetry + 1)}
                >
                  다시 시도
                </button>
              )}
            </div>
          )}
          {context.map((row) => (
            <div
              key={positionKey(row)}
              className={`context-row ${selectedRow && (contextMode === 'existing' ? row.id === selectedRow.id : positionKey(row) === positionKey(selectedRow)) ? 'context-selected' : ''}`}
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
                    <GameText text={row.text} query={query} />
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
              {selectedRow &&
                (contextMode === 'existing'
                  ? row.id === selectedRow.id
                  : positionKey(row) === positionKey(selectedRow)) && <small>선택한 대사</small>}
            </div>
          ))}
        </div>
        <footer>
          <nav className="context-navigation" aria-label="선택한 대사로 이동">
            {occurrences.length > 1 && (
              <label>
                대사 위치{' '}
                <select
                  aria-label="대사 출현 위치"
                  value={selectedRow ? positionKey(selectedRow) : ''}
                  onChange={(event) => {
                    setContextOccurrence(event.target.value);
                    setContextMode('position');
                  }}
                >
                  {occurrences.map((row, index) => (
                    <option key={positionKey(row)} value={positionKey(row)}>
                      {row.wikiPosition?.mission ?? row.mission} · {index + 1}/{occurrences.length}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selectedRow?.wikiPosition &&
              selectedRow.type === 'choice' &&
              selectedRow.bwikiNextIds?.some(
                (id) =>
                  !selectedRow.wikiPosition!.nextIds.some(
                    (target) => byPosition.get(target)?.id === id,
                  ),
              ) && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setContextMode(contextMode === 'existing' ? 'position' : 'existing')
                  }
                >
                  {contextMode === 'existing' ? '선택한 대화 보기' : '다른 대화 보기'}
                </button>
              )}
            {selectedRow &&
              (
                selectedRow.wikiPosition?.replyToIds ??
                selectedRow.executionPosition?.replyToIds ??
                selectedRow.bwikiReplyToIds ??
                selectedRow.replyToIds
              )
                ?.map((id) =>
                  selectedRow.wikiPosition || selectedRow.executionPosition
                    ? byPosition.get(id)
                    : byId.get(id),
                )
                .filter(Boolean)
                .map((choice) => (
                  <button
                    className="button secondary"
                    key={positionKey(choice!)}
                    onClick={() => {
                      if (global) {
                        const index = rows.findIndex((row) => row.id === choice!.id);
                        if (index < 0) return;
                        setSelected(index);
                        setContextOccurrence(positionKey(choice!));
                        setContextMode('position');
                      } else if (selectedRow.wikiLegacy) {
                        setContextMode('existing');
                        setSelected(rows.indexOf(choice!));
                      } else openContext(rows.indexOf(choice!));
                    }}
                  >
                    “<GameText text={choice!.text} />” 선택지
                  </button>
                ))}
            {selectedRow && (
              <a
                className="button secondary"
                href={`#${readerPath(selectedRow.entryId, selectedRow.chapterId, selectedRow.id)}${selectedRow.wikiPosition || selectedRow.executionPosition ? '&occurrence=' + encodeURIComponent(positionKey(selectedRow)) : ''}`}
                onClick={closeDialog}
              >
                선택한 대사로
              </a>
            )}
          </nav>
          <p>
            {selectedRow && entries.get(selectedRow.entryId)?.category === 'books'
              ? '서적 원문은 선택한 권 단위로 표시합니다.'
              : '선택한 대사의 주변 내용을 표시합니다.'}
          </p>
        </footer>
      </dialog>
    </section>
  );
}
