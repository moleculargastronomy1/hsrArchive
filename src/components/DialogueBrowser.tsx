import {
  useEffect,
  useMemo,
  useRef,
  useState,
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
import { searchableGameText } from '../lib/game-text';

export default function DialogueBrowser({
  file = 'content/search-index.json',
  initialQuery = '',
  global = false,
  onReady,
  targetRowId,
  languages: controlledLanguages,
  footer,
  sourceNote,
}: {
  file?: string;
  initialQuery?: string;
  global?: boolean;
  onReady?: () => void;
  targetRowId?: string;
  languages?: ComparisonLanguage[];
  footer?: ReactNode;
  sourceNote?: string;
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
  const targetRow = useRef<HTMLDivElement>(null);
  const targetFocused = useRef(false);
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
            ? dialoguePage(rows, targetRowId, pageSize)
            : undefined;
        setMatches(result);
        setPage(
          targetPage ??
            (restorePage.current && !query
              ? Math.min(savedPage, Math.max(1, Math.ceil(result.length / pageSize)))
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
  }, [rows, query, scope, searchIndex, entries, loading, targetRowId]);
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
  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  useEffect(() => setPageInput(String(page)), [page, totalPages]);
  const jumpToPage = (event: FormEvent) => {
    event.preventDefault();
    const next = Number(pageInput);
    if (Number.isInteger(next) && next >= 1 && next <= totalPages) changePage(next);
  };
  const visible = matches.slice((page - 1) * pageSize, page * pageSize);
  const selectedRow = selected === undefined ? undefined : rows[selected];
  const linkedChoice =
    selectedRow?.type === 'choice' &&
    (selectedRow.flowStatus === 'verified' ||
      ['matched', 'cached'].includes(selectedRow.bwikiStatus ?? ''));
  const selectedWiki = ['matched', 'cached'].includes(selectedRow?.bwikiStatus ?? '');
  const context = useMemo(
    () =>
      selected === undefined
        ? []
        : linkedChoice
          ? choiceDialogue(rows, selected)
          : nearbyDialogue(rows, selected),
    [rows, selected, linkedChoice],
  );
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const flowSummary = useMemo(
    () => ({
      verified: rows.filter((row) => row.flowStatus === 'verified').length,
      review: rows.filter((row) => row.flowStatus === 'review').length,
      wiki: rows.filter((row) => row.bwikiStatus === 'matched').length,
      cached: rows.filter((row) => row.bwikiStatus === 'cached').length,
    }),
    [rows],
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
        연결이 확인된 선택지를 누르면 해당 응답과 이어지는 대사를 볼 수 있습니다. 확인이 필요한
        구간은 기존 참조 순서를 유지합니다.
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
                const orderUnverified =
                  (row.flowStatus === 'review' || row.bwikiStatus === 'review') &&
                  row.flowStatus !== 'verified' &&
                  !['matched', 'cached'].includes(row.bwikiStatus ?? '') &&
                  !['caption-matched', 'screen-matched'].includes(row.videoStatus ?? '');
                return (
                  <div
                    className={`dialogue-row ${row.type === 'choice' ? 'choice-row' : ''} ${languages.length ? 'comparing' : ''} ${row.id === targetRowId ? 'dialogue-target' : ''}`}
                    key={row.id}
                    ref={row.id === targetRowId ? targetRow : undefined}
                    tabIndex={row.id === targetRowId ? -1 : undefined}
                    data-dialogue-id={row.id}
                  >
                    <div className="dialogue-row-meta">
                      <span>
                        {entry?.category === 'books'
                          ? '서적 원문'
                          : row.type === 'choice'
                            ? '선택지'
                            : row.speaker || '장면 설명'}
                      </span>
                      <small>{row.bwikiMission ?? row.mission}</small>
                      {orderUnverified && <small>(순서 미확인)</small>}
                      {row.flowBoundary && <small>후속 대사 확인 필요</small>}
                      {(row.bwikiReplyToIds ?? row.replyToIds)
                        ?.map((id) => byId.get(id))
                        .filter(Boolean)
                        .map((choice) => (
                          <button
                            className="flow-reply-link"
                            key={choice!.id}
                            onClick={() => openContext(rows.indexOf(choice!))}
                          >
                            “<GameText text={choice!.text} />
                            ”의 응답
                          </button>
                        ))}
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
            <span className="eyebrow">DIALOGUE CONTEXT</span>
            <h2 id="context-heading">
              <MessageSquareText size={19} />
              {selectedRow && entries.get(selectedRow.entryId)?.category === 'books'
                ? '서적 원문'
                : linkedChoice
                  ? '선택지 응답'
                  : '앞뒤 대사'}
            </h2>
            <p>
              {selectedRow?.bwikiMission ?? selectedRow?.mission}
              {!selectedWiki && <> · {selectedRow?.scene}</>}
            </p>
          </div>
          <button className="icon-button" aria-label="앞뒤 대사 닫기" onClick={closeDialog}>
            <X size={20} />
          </button>
        </header>
        <div className="context-dialog-body">
          {selectedRow?.flowStatus === 'review' && !selectedWiki && (
            <p className="dialogue-help">
              이 구간은 실행 연결을 확인하지 못했습니다. 아래 내용은 기존 자료의 주변 대사이며,
              선택지에 따른 응답을 보장하지 않습니다.
            </p>
          )}
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
              {row.id === selectedRow?.id && <small>선택한 대사</small>}
              {row.flowBoundary && <small>이후 대사는 연결 자료가 부족해 표시하지 않습니다.</small>}
            </div>
          ))}
        </div>
        <footer>
          <nav className="context-navigation" aria-label="선택한 대사로 이동">
            {selectedRow && (
              <a
                className="button secondary"
                href={`#${readerPath(selectedRow.entryId, selectedRow.chapterId, selectedRow.id)}`}
                onClick={closeDialog}
              >
                선택한 대사로
              </a>
            )}
          </nav>
          <p>
            {selectedRow && entries.get(selectedRow.entryId)?.category === 'books'
              ? '서적 원문은 선택한 권 단위로 표시합니다.'
              : linkedChoice
                ? '확인된 응답과 공통 후속 대사를 최대 41줄 표시하며, 다음 선택지 앞에서 멈춥니다.'
                : '같은 장면 안에서 최대 앞뒤 20줄을 표시합니다.'}
          </p>
        </footer>
      </dialog>
    </section>
  );
}
