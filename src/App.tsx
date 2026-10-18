import GameText from './components/GameText';
import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  ChevronRight,
  Clock3,
  Home,
  Menu,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { archive, categories, worlds } from './data/archive';
import type { ArchiveEntry, Category, World } from './data/types';
import {
  adjacentChapter,
  chapterContentLabel,
  chapterNumber,
  readerPath,
  searchEntries,
} from './lib/archive';
import { isBookmarks, isHistory, useStored, type ReadingHistory } from './lib/storage';
import WorldArt from './components/WorldArt';
import EntryArtwork, { hasCover } from './components/EntryArtwork';
import DialogueBrowser from './components/DialogueBrowser';
import { LanguageComparisonControls } from './components/LanguageComparison';
import { useComparisonLanguages } from './hooks/useComparison';
import CategoryIcon from './components/CategoryIcon';
import CodexReader from './components/CodexReader';
import ContentUpdateStatus from './components/ContentUpdateStatus';
import HomePage from './components/HomePage';
import SourceDetails from './components/SourceDetails';
import dayIcon from '../docs/reference-images/darkmodeicon/DAY.webp';
import nightIcon from '../docs/reference-images/darkmodeicon/Night.webp';

const worldName = (id: World) => worlds.find((world) => world.id === id)!.label;
const categoryName = (id: Category) => categories.find((category) => category.id === id)!.label;
const href = (path: string) => `#${path}`;
const decodeSegment = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
};

function useRoute() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const change = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const [path, search = ''] = route.split('?');
  return { route, path, params: new URLSearchParams(search) };
}

function EntryCard({
  entry,
  saved,
  onBookmark,
}: {
  entry: ArchiveEntry;
  saved: boolean;
  onBookmark: () => void;
}) {
  return (
    <article className={`entry-card${entry.category === 'trailblaze' ? ' trailblaze-entry' : ''}`}>
      <a
        className={`card-art world-${entry.world}${hasCover(entry.world, entry.id) ? ' has-cover' : ''}`}
        href={href(readerPath(entry.id))}
        tabIndex={-1}
        aria-hidden="true"
      >
        <EntryArtwork world={entry.world} entryId={entry.id} />
        <span className="art-index">{String(entry.order).padStart(2, '0')} / ARCHIVE</span>
      </a>
      <div className="card-body">
        <div className="card-eyebrow">{entry.arcLabel ?? worldName(entry.world)}</div>
        <h3>
          <a href={href(readerPath(entry.id))}>{entry.title}</a>
        </h3>
        <p>{entry.description}</p>
        <div className="card-footer">
          <span>
            <BookOpen size={13} />
            {entry.chapters.length}개 항목
          </span>
          <button
            className={`icon-button ${saved ? 'saved' : ''}`}
            onClick={onBookmark}
            aria-label={`${entry.title} 북마크 ${saved ? '해제' : '추가'}`}
            aria-pressed={saved}
          >
            <Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
    </article>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <BookOpen size={34} strokeWidth={1} />
      <h2>{title}</h2>
      <p>{text}</p>
      <a className="button secondary" href="#/archive">
        아카이브 둘러보기 <ArrowRight size={15} />
      </a>
    </div>
  );
}

export default function App() {
  const { route, path, params } = useRoute();
  const [theme, setTheme] = useStored<'light' | 'dark'>(
    'theme',
    'light',
    (v): v is 'light' | 'dark' => v === 'light' || v === 'dark',
  );
  const [bookmarks, setBookmarks] = useStored<string[]>('bookmarks', [], isBookmarks);
  const [history, setHistory] = useStored<ReadingHistory>('history', {}, isHistory);
  const [fontSize, setFontSize] = useStored<number>(
    'fontSize',
    17,
    (v): v is number => typeof v === 'number' && v >= 14 && v <= 24,
  );
  const [mobileMenu, setMobileMenu] = useState(false);
  const [search, setSearch] = useState(params.get('q') ?? '');
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const parts = path.split('/').filter(Boolean).map(decodeSegment);
  const entry = parts[0] === 'entry' ? archive.find((item) => item.id === parts[1]) : undefined;
  const chapter = entry?.chapters.find(
    (item) => item.id === parts[2] || item.aliases?.includes(parts[2]),
  );
  const isReader = Boolean(chapter) && entry?.category !== 'codex' && entry?.category !== 'books';
  const selectedCategory =
    categories.find((item) => item.id === params.get('category'))?.id ??
    (path === '/archive' ? 'trailblaze' : undefined);
  const selectedWorld = worlds.find((item) => item.id === params.get('world'))?.id;
  const toggleBookmark = (id: string) =>
    setBookmarks((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id],
    );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    setMobileMenu(false);
    setSearch(new URLSearchParams(route.split('?')[1] ?? '').get('q') ?? '');
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [route]);
  useEffect(() => {
    const pageTitle =
      chapter?.title ??
      entry?.title ??
      (path === '/archive'
        ? selectedCategory
          ? categoryName(selectedCategory)
          : '아카이브 탐색'
        : path === '/search'
          ? '원문 검색'
          : path === '/library'
            ? '내 서재'
            : path === '/about'
              ? '사이트 안내'
              : '열차 아카이브');
    document.title =
      pageTitle === '열차 아카이브'
        ? '열차 아카이브 · 붕괴: 스타레일'
        : `${pageTitle} · 열차 아카이브`;
  }, [path, entry, chapter, selectedCategory]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') setMobileMenu(false);
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    window.location.hash = `/search${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`;
  };
  const recent = Object.entries(history)
    .filter(([id, progress]) =>
      archive.some(
        (item) =>
          item.id === id &&
          item.chapters.some(
            (ch) => ch.id === progress.chapterId || ch.aliases?.includes(progress.chapterId),
          ),
      ),
    )
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const lastEntry = recent[0] && archive.find((item) => item.id === recent[0][0]);
  const lastChapter = lastEntry?.chapters.find(
    (ch) => ch.id === recent[0][1].chapterId || ch.aliases?.includes(recent[0][1].chapterId),
  );
  const cards = (entries: ArchiveEntry[]) => (
    <div
      className={`entry-grid${entries.length && entries.every((item) => item.category === 'trailblaze') ? ' trailblaze-grid' : ''}`}
    >
      {entries.map((item) => (
        <EntryCard
          key={item.id}
          entry={item}
          saved={bookmarks.includes(item.id)}
          onBookmark={() => toggleBookmark(item.id)}
        />
      ))}
    </div>
  );
  const updateFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (key === 'category') next.delete('world');
    value ? next.set(key, value) : next.delete(key);
    window.location.hash = `/archive${next.size ? `?${next}` : ''}`;
  };
  const navActive = (target: string) => path === target;
  let content;

  if (path === '/') {
    content = (
      <HomePage
        search={search}
        setSearch={setSearch}
        searchRef={searchRef}
        onSearch={submitSearch}
        entries={cards(archive.filter((item) => item.category === 'trailblaze'))}
        lastEntry={lastEntry || undefined}
        lastChapter={lastChapter}
      />
    );
  } else if (path === '/archive') {
    const results = searchEntries(archive, params.get('q') ?? '', selectedCategory, selectedWorld);
    content = (
      <>
        <PageIntro
          eyebrow="EXPLORE THE ARCHIVE"
          title={selectedCategory ? categoryName(selectedCategory) : '이야기 탐색'}
          description={
            selectedCategory === 'trailblaze'
              ? '프롤로그부터 제5장까지, 개척의 여정을 순서대로 만나보세요.'
              : selectedCategory === 'simulation'
                ? '시뮬레이션 우주의 실험, 기물과 발견의 기록을 만나보세요.'
                : selectedCategory === 'books'
                  ? '지역별로 정리한 인게임 서적과 편지, 문서를 시리즈·권 순서로 읽어보세요.'
                  : '광추부터 파벌까지, 별바다에 남겨진 지식과 기록을 찾아보세요.'
          }
        />
        <div className="category-tabs" aria-label="자료 분류">
          {categories.map((item) => (
            <button
              key={item.id}
              className={(selectedCategory ?? '') === item.id ? 'active' : ''}
              aria-pressed={(selectedCategory ?? '') === item.id}
              onClick={() => updateFilter('category', item.id)}
            >
              {item.label}
              <span>
                {item.id
                  ? archive.filter((entry) => entry.category === item.id).length
                  : archive.length}
              </span>
            </button>
          ))}
        </div>
        <div className="filter-bar">
          <label>
            <SlidersHorizontal size={16} />
            <span>지역</span>
            <select
              aria-label="지역 필터"
              value={selectedWorld ?? ''}
              onChange={(event) => updateFilter('world', event.target.value)}
            >
              <option value="">모든 지역</option>
              {worlds.map((world) => (
                <option key={world.id} value={world.id}>
                  {world.label}
                </option>
              ))}
            </select>
          </label>
          <span>
            총 <strong>{results.length}</strong>개 기록
          </span>
        </div>
        {params.get('q') && (
          <div className="search-summary">
            <p>
              “<strong>{params.get('q')}</strong>” 검색 결과 <span>제목 · 태그 · 본문 검색</span>
            </p>
            <button className="text-link" onClick={() => updateFilter('q', '')}>
              검색 지우기 <X size={14} />
            </button>
          </div>
        )}
        {results.length ? (
          cards(results)
        ) : (
          <Empty
            title="일치하는 기록이 없어요"
            text="다른 검색어를 입력하거나 지역과 분류 필터를 바꿔 보세요."
          />
        )}
      </>
    );
  } else if (path === '/search') {
    content = (
      <>
        <PageIntro
          eyebrow="DIALOGUE SEARCH"
          title="원문 검색"
          description="임무명과 서적명, 화자와 한국어 원문을 검색하고 맥락을 함께 읽어보세요."
        />
        <DialogueBrowser initialQuery={params.get('q') ?? ''} global />
      </>
    );
  } else if (path === '/library') {
    const historyView = params.get('view') === 'history';
    const saved = archive.filter((item) => bookmarks.includes(item.id));
    content = (
      <>
        <PageIntro
          eyebrow="YOUR READING ROOM"
          title="내 서재"
          description="다시 읽고 싶은 이야기와 마지막으로 머문 페이지를 모았습니다."
        />
        <div className="category-tabs">
          <a className={!historyView ? 'active' : ''} href="#/library">
            북마크 <span>{saved.length}</span>
          </a>
          <a className={historyView ? 'active' : ''} href="#/library?view=history">
            읽기 기록 <span>{recent.length}</span>
          </a>
        </div>
        <p className="local-note">
          이 브라우저에 저장된 기록입니다. 다른 기기와 동기화되지 않습니다.
        </p>
        {historyView ? (
          recent.length ? (
            <div className="chapter-list">
              {recent.map(([id, progress]) => {
                const item = archive.find((entry) => entry.id === id)!;
                return (
                  <a key={id} href={href(readerPath(id, progress.chapterId))}>
                    <Clock3 size={19} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {
                          item.chapters.find(
                            (ch) =>
                              ch.id === progress.chapterId ||
                              ch.aliases?.includes(progress.chapterId),
                          )?.title
                        }{' '}
                        · {new Date(progress.updatedAt).toLocaleDateString('ko-KR')}
                      </small>
                    </span>
                    <span className="text-link">
                      이어서 읽기 <ArrowRight size={15} />
                    </span>
                  </a>
                );
              })}
            </div>
          ) : (
            <Empty
              title="아직 읽은 기록이 없어요"
              text="이야기를 열면 마지막으로 읽은 장이 여기에 남습니다."
            />
          )
        ) : saved.length ? (
          cards(saved)
        ) : (
          <Empty
            title="아직 꽂아 둔 책갈피가 없어요"
            text="이야기 카드의 북마크 아이콘을 눌러 내 서재에 담아 보세요."
          />
        )}
      </>
    );
  } else if (
    (entry?.category === 'codex' || entry?.category === 'books') &&
    (parts.length === 2 || (chapter && parts.length === 3))
  ) {
    content = (
      <CodexReader
        key={`${entry.id}/${params.get('dialogue') ?? ''}`}
        entry={entry}
        chapterId={chapter?.id}
        targetRowId={params.get('dialogue') ?? undefined}
        fontSize={fontSize}
        setFontSize={setFontSize}
        saved={bookmarks.includes(entry.id)}
        toggleBookmark={() => toggleBookmark(entry.id)}
        setHistory={setHistory}
      />
    );
  } else if (entry && parts.length === 2) {
    const progress = history[entry.id];
    const resume =
      entry.chapters.find(
        (ch) => ch.id === progress?.chapterId || ch.aliases?.includes(progress?.chapterId ?? ''),
      ) ?? entry.chapters[0];
    content = (
      <>
        <a className="back-link" href={href(`/archive?category=${entry.category}`)}>
          <ArrowLeft size={15} /> {categoryName(entry.category)} 목록
        </a>
        <div className={`entry-detail world-${entry.world}`}>
          <div>
            <span className="eyebrow">{entry.arcLabel ?? worldName(entry.world)}</span>
            <h1>{entry.title}</h1>
            <p>{entry.description}</p>
          </div>
          <EntryArtwork world={entry.world} entryId={entry.id} />
        </div>
        <div className="detail-actions">
          <a className="button primary" href={href(readerPath(entry.id, resume.id))}>
            {progress ? '이어서 읽기' : '첫 장 읽기'} <ArrowRight size={16} />
          </a>
          <button
            className="button secondary"
            onClick={() => toggleBookmark(entry.id)}
            aria-pressed={bookmarks.includes(entry.id)}
          >
            <Bookmark size={16} fill={bookmarks.includes(entry.id) ? 'currentColor' : 'none'} />
            {bookmarks.includes(entry.id) ? '북마크됨' : '북마크'}
          </button>
        </div>
        <div className="section-heading chapter-heading">
          <h2>이야기의 목차</h2>
          <span>{entry.chapters.length}개 항목</span>
        </div>
        <div className="chapter-list">
          {entry.chapters.map((ch) => (
            <a
              key={ch.id}
              className={ch.parentId ? 'chapter-child' : undefined}
              href={href(readerPath(entry.id, ch.id))}
            >
              <span className="chapter-number">{chapterNumber(entry, ch.id)}</span>
              <span>
                <strong>{ch.title}</strong>
                <small>
                  {ch.kind === 'branch'
                    ? '선택 분기 · '
                    : ch.kind === 'adventure'
                      ? '관련 모험 임무 · '
                      : ''}
                  {ch.content
                    ? `${ch.content.rows.toLocaleString('ko-KR')}줄`
                    : chapterContentLabel(ch)}
                </small>
              </span>
              {ch.id === progress?.chapterId ? (
                <span className="reading-label">
                  읽던 장 <Bookmark size={13} />
                </span>
              ) : (
                <ChevronRight size={18} />
              )}
            </a>
          ))}
        </div>
        <SourceDetails>
          <p>
            {entry.source.kind === 'demo' ? entry.source.note : `게임 자료 ${entry.source.version}`}
            .
          </p>
          <p>게임 원문의 권리는 HoYoverse 및 해당 권리자에게 있습니다.</p>
        </SourceDetails>
      </>
    );
  } else if (entry && chapter && parts.length === 3) {
    content = (
      <Reader
        key={`${entry.id}/${chapter.id}/${params.get('dialogue') ?? ''}`}
        entry={entry}
        chapterId={chapter.id}
        targetRowId={params.get('dialogue') ?? undefined}
        fontSize={fontSize}
        setFontSize={setFontSize}
        saved={bookmarks.includes(entry.id)}
        toggleBookmark={() => toggleBookmark(entry.id)}
        history={history}
        setHistory={setHistory}
      />
    );
  } else if (path === '/about') {
    content = (
      <>
        <PageIntro
          eyebrow="ABOUT THE ARCHIVE"
          title="사이트 안내"
          description="별을 따라 이어지는 이야기를 더 편하게 읽을 수 있도록."
        />
        <article className="about-panel">
          <h2>현재 수록한 자료</h2>
          <p>
            개척 임무 36개 목차, 시뮬레이션 우주 기록과 아카이브 7개 분류에 한국어 자료를
            연결했습니다. 에이언즈·고유 명사·파벌은 열차 자료실 전용 원문과 메뉴 순서로 제공합니다.
            개척 임무 등은 고정된 한국어 자료를 대조해 변환했으며, 임무 귀속과 장면 연결이 확인되지
            않은 자료는 제외했습니다. 자료의 참조 순서는 실제 플레이 순서와 다를 수 있으며, 모든
            분기·컷신을 수록했다고 보장하지 않습니다.
          </p>
          <ContentUpdateStatus />
          <h2>인게임 서적</h2>
          <p>
            왼쪽 ‘서적’에서 지역을 선택해 책과 편지, 문서를 읽을 수 있습니다. 시리즈·권 순서로
            정리했으며, 게임 내 책장 수록 여부로 분류할 수 있습니다. 제목 검색, 전체 원문 검색과
            영·중·일 원문 비교를 지원합니다. 이미지가 포함된 서적은 텍스트 원문을 제공하며, 실제
            수집·해금 상태를 나타내지 않습니다.
          </p>
          <h2>여러 언어의 원문 비교</h2>
          <p>
            읽기 화면의 ‘언어 추가’에서 영어·중국어(간체)·일본어를 선택하면 한국어와 동시에 비교할
            수 있습니다. 선택지와 자료실 갱신 기록도 같은 행에 함께 표시합니다. 연결된 원문이 없는
            행은 별도로 안내합니다.
          </p>
          <p>
            원문 데이터 출처:{' '}
            <a
              href="https://github.com/DimbreathBot/TurnBasedGameData"
              target="_blank"
              rel="noreferrer"
            >
              DimbreathBot/TurnBasedGameData
            </a>
            . 게임 원문의 권리와 저작권은 HoYoverse 및 해당 권리자에게 있습니다.
          </p>
          <p>
            임무 순서·분기 대조에는{' '}
            <a href="https://wiki.biligame.com/sr/开拓任务" target="_blank" rel="noreferrer">
              BWIKI 기여자들의 정리
            </a>
            를 참고합니다. BWIKI 기반 정리 정보는{' '}
            <a
              href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY-NC-SA 4.0
            </a>
            에 따라 한국어 자료에 맞춰 재구성했습니다. 중국어 원문을 공식 대사 ID와 연결하며 한국어
            본문을 번역으로 채우지 않습니다. 연결이 모호하거나 자료가 부족한 구간은 기존 자료를
            유지합니다.
          </p>
          <h2>내 서재와 읽기 설정</h2>
          <p>
            북마크, 마지막으로 읽은 장, 읽기 위치, 화면 테마와 글자 크기, 비교 언어는 현재
            브라우저에 저장됩니다. 브라우저 데이터를 지우면 기록도 초기화됩니다.
          </p>
          <div className="about-status">
            <Check size={17} /> 탐색 · 검색 · 읽기 · 북마크 사용 가능
          </div>
        </article>
      </>
    );
  } else {
    content = (
      <Empty
        title="이 기록을 찾을 수 없어요"
        text="주소를 확인하거나 아카이브에서 다른 이야기를 찾아보세요."
      />
    );
  }

  return (
    <div className={`app ${path === '/' ? 'home-page' : ''} ${isReader ? 'reading-mode' : ''}`}>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
      >
        본문으로 건너뛰기
      </a>
      {mobileMenu && (
        <button
          className="sidebar-backdrop"
          aria-label="메뉴 닫기"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? 'open' : ''}`} aria-label="주 메뉴">
        <a className="brand" href="#/">
          <span className="brand-symbol">✦</span>
          <span>
            <strong>열차 아카이브</strong>
            <small>{path === '/' ? '붕괴: 스타레일 자료실' : 'HONKAI: STAR RAIL ARCHIVE'}</small>
          </span>
        </a>
        <div className="sidebar-rule" />
        <nav>
          <span className="nav-label">{path === '/' ? '탐색' : 'EXPLORE'}</span>
          <a
            className={navActive('/') ? 'active' : ''}
            href="#/"
            aria-current={navActive('/') ? 'page' : undefined}
          >
            <Home size={18} />
            아카이브 홈{navActive('/') && <span className="nav-dot" />}
          </a>
          <a className={navActive('/search') ? 'active' : ''} href="#/search">
            <Search size={18} />
            원문 검색
          </a>
          <span className="nav-label nav-space">{path === '/' ? '자료 분류' : 'STORIES'}</span>
          {categories.map((item) => {
            const active =
              (navActive('/archive') && selectedCategory === item.id) ||
              entry?.category === item.id;
            return (
              <Fragment key={item.id}>
                <a
                  className={`primary-story-link ${active ? 'active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  href={href(`/archive?category=${item.id}`)}
                >
                  <CategoryIcon category={item.id} />
                  {item.label}
                </a>
                {(item.id === 'codex' || item.id === 'books') && active && (
                  <div
                    className="codex-submenu"
                    aria-label={item.id === 'books' ? '서적 지역' : '아카이브 분류'}
                  >
                    {archive
                      .filter((record) => record.category === item.id)
                      .map((record) => (
                        <a
                          key={record.id}
                          href={href(readerPath(record.id))}
                          className={entry?.id === record.id ? 'active' : ''}
                          aria-current={entry?.id === record.id ? 'page' : undefined}
                        >
                          {record.title}
                        </a>
                      ))}
                  </div>
                )}
              </Fragment>
            );
          })}
          <span className="nav-label nav-space">{path === '/' ? '내 서재' : 'MY ARCHIVE'}</span>
          <a
            href="#/library"
            className={path === '/library' && params.get('view') !== 'history' ? 'active' : ''}
          >
            <Bookmark size={18} />
            북마크
            <span className="nav-count">
              {bookmarks.filter((id) => archive.some((item) => item.id === id)).length}
            </span>
          </a>
          <a
            href="#/library?view=history"
            className={path === '/library' && params.get('view') === 'history' ? 'active' : ''}
          >
            <Clock3 size={18} />
            읽기 기록
          </a>
        </nav>
        <div className="sidebar-bottom">
          <a href="#/about">
            <BookOpen size={15} />
            사이트 안내 <ChevronRight size={14} />
          </a>
          <div className="sidebar-version">
            <span className="status-dot" />
            베타 0.1.0
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="메뉴 열기"
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            <Menu size={21} />
          </button>
          <div className="topbar-location">
            {path === '/' ? '열차 아카이브' : 'ARCHIVE'} <ChevronRight size={12} />
            <span>
              {entry
                ? categoryName(entry.category)
                : path === '/archive'
                  ? '이야기 탐색'
                  : path === '/search'
                    ? '원문 검색'
                    : path === '/library'
                      ? '내 서재'
                      : path === '/about'
                        ? '사이트 안내'
                        : '아카이브 홈'}
            </span>
          </div>
          <form className="global-search" onSubmit={submitSearch} role="search">
            <Search size={16} />
            <input
              ref={path === '/' ? undefined : searchRef}
              aria-label="아카이브 검색"
              placeholder="어떤 이야기를 찾고 있나요?"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <kbd>Ctrl K</kbd>
            <button type="submit" aria-label="검색 실행">
              <ArrowRight size={15} />
            </button>
          </form>
          <button
            className="icon-button theme-button"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'}
          >
            <img src={theme === 'light' ? nightIcon : dayIcon} alt="" width={24} height={24} />
            <span>{theme === 'light' ? '다크모드' : '라이트모드'}</span>
          </button>
        </header>
        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className={`main-content ${isReader ? 'reader-main' : ''}`}
        >
          {content}
        </main>
        <footer className="footer">
          <div className="footer-credit">
            <span>© 2026 HSRArchive</span>
            <p>
              열차 아카이브는 개인 프로젝트로 공식 서비스가 아니며, 모든 데이터의 권리와 저작권은
              HoYoverse에게 있습니다.
            </p>
          </div>
          <a href="#/about">
            자료 출처와 수록 범위 <ArrowRight size={12} />
          </a>
        </footer>
      </div>
    </div>
  );
}

function PageIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-intro">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}

function Reader({
  entry,
  chapterId,
  targetRowId,
  fontSize,
  setFontSize,
  saved,
  toggleBookmark,
  history,
  setHistory,
}: {
  entry: ArchiveEntry;
  chapterId: string;
  targetRowId?: string;
  fontSize: number;
  setFontSize: (value: number) => void;
  saved: boolean;
  toggleBookmark: () => void;
  history: ReadingHistory;
  setHistory: (value: ReadingHistory | ((previous: ReadingHistory) => ReadingHistory)) => void;
}) {
  const chapter = entry.chapters.find((ch) => ch.id === chapterId)!;
  const initialScroll = useRef(
    !targetRowId && history[entry.id]?.chapterId === chapterId ? history[entry.id].scroll : 0,
  );
  const previous = adjacentChapter(entry, chapterId, -1);
  const next = adjacentChapter(entry, chapterId, 1);
  const [progress, setProgress] = useState(0);
  const [contentReady, setContentReady] = useState(!chapter.content);
  const [languages, setLanguages] = useComparisonLanguages();
  const markReady = useCallback(() => setContentReady(true), []);
  useEffect(() => {
    if (!contentReady) return;
    let lastScroll = initialScroll.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () =>
      setHistory((current) => ({
        ...current,
        [entry.id]: { chapterId, scroll: lastScroll, updatedAt: Date.now() },
      }));
    const track = () => {
      lastScroll = window.scrollY;
      const available = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(available > 0 ? Math.min(100, Math.round((lastScroll / available) * 100)) : 100);
      if (!timer)
        timer = setTimeout(() => {
          save();
          timer = undefined;
        }, 400);
    };
    const frame = requestAnimationFrame(() => {
      if (!targetRowId) window.scrollTo(0, initialScroll.current);
      track();
      save();
    });
    window.addEventListener('scroll', track, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', track);
      clearTimeout(timer);
      save();
    };
  }, [entry.id, chapterId, setHistory, contentReady, targetRowId]);

  const chapterNavigation = (
    <>
      <div className="chapter-end">
        <span />✦<span />
      </div>
      <nav className="chapter-navigation" aria-label="이전 다음 장">
        {previous ? (
          <a href={href(readerPath(entry.id, previous.id))}>
            <ArrowLeft size={17} />
            <span>
              <small>이전 장</small>
              <strong>{previous.title}</strong>
            </span>
          </a>
        ) : (
          <span className="chapter-boundary">첫 번째 장입니다</span>
        )}
        {next ? (
          <a href={href(readerPath(entry.id, next.id))}>
            <span>
              <small>다음 장</small>
              <strong>{next.title}</strong>
            </span>
            <ArrowRight size={17} />
          </a>
        ) : (
          <a href={href(readerPath(entry.id))}>
            <span>
              <small>마지막 장입니다</small>
              <strong>목차로 돌아가기</strong>
            </span>
            <ArrowDown size={17} />
          </a>
        )}
      </nav>
    </>
  );

  return (
    <>
      <div className="reading-progress" style={{ width: `${progress}%` }} />
      <div className="reader-toolbar">
        <a className="back-link" href={href(readerPath(entry.id))}>
          <ArrowLeft size={15} /> 목차로 돌아가기
        </a>
        <div>
          <span className="font-label">글자 크기</span>
          <button
            className="icon-button"
            disabled={fontSize <= 14}
            aria-label="글자 축소"
            onClick={() => setFontSize(Math.max(14, fontSize - 1))}
          >
            A−
          </button>
          <span className="font-value">{fontSize}</span>
          <button
            className="icon-button"
            disabled={fontSize >= 24}
            aria-label="글자 확대"
            onClick={() => setFontSize(Math.min(24, fontSize + 1))}
          >
            A+
          </button>
          <span className="toolbar-divider" />
          <button
            className={`icon-button ${saved ? 'saved' : ''}`}
            aria-label={saved ? '북마크 해제' : '북마크 추가'}
            aria-pressed={saved}
            onClick={toggleBookmark}
          >
            <Bookmark size={18} fill={saved ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
      <div className={`reader-layout ${languages.length ? 'is-comparing' : ''}`}>
        <aside className="reader-toc" aria-label="챕터 목차">
          <span className="eyebrow">IN THIS STORY</span>
          <h2>{entry.title}</h2>
          {entry.chapters.map((ch) => (
            <a
              key={ch.id}
              className={`${ch.id === chapterId ? 'active' : ''}${ch.parentId ? ' toc-child' : ''}`}
              aria-current={ch.id === chapterId ? 'page' : undefined}
              href={href(readerPath(entry.id, ch.id))}
            >
              <span>{chapterNumber(entry, ch.id)}</span>
              {ch.title}
            </a>
          ))}
        </aside>
        <article className="reader-article" style={{ fontSize }}>
          <header>
            <span className="eyebrow">
              {worldName(entry.world)} <span> / </span> {chapterNumber(entry, chapterId)}
            </span>
            <h1>{chapter.title}</h1>
            <p>{entry.title}</p>
            {chapter.content ? (
              <LanguageComparisonControls
                label={chapterContentLabel(chapter)}
                languages={languages}
                onChange={setLanguages}
              />
            ) : (
              <div className="reader-demo">
                <Sparkles size={14} />
                실제 게임 대사가 아닌 기능 확인용 예시 본문입니다.
              </div>
            )}
          </header>
          {chapter.content && (
            <DialogueBrowser
              file={chapter.content.file}
              targetRowId={targetRowId}
              onReady={markReady}
              languages={languages}
              footer={chapterNavigation}
              sourceNote={
                entry.source.kind === 'demo'
                  ? entry.source.note
                  : `게임 자료 ${entry.source.version}.`
              }
            />
          )}
          {!chapter.content && (
            <div className="text-blocks">
              {chapter.blocks.map((block) =>
                block.type === 'dialogue' ? (
                  <div key={block.id} className="dialogue">
                    <span className="speaker-mark">✦</span>
                    <div>
                      <h2>{block.speaker}</h2>
                      <p>
                        <GameText text={block.text} />
                      </p>
                    </div>
                  </div>
                ) : (
                  <p key={block.id} className="narration">
                    <GameText text={block.text} />
                  </p>
                ),
              )}
            </div>
          )}
          {!chapter.content && chapterNavigation}
        </article>
      </div>
    </>
  );
}
