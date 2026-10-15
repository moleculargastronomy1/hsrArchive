import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BookMarked,
  BookOpen,
  Bookmark,
  Check,
  ChevronRight,
  Clock3,
  Compass,
  FileText,
  Home,
  Library,
  Menu,
  Moon,
  Search,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { archive, categories, worlds } from './data/archive';
import type { ArchiveEntry, Category, World } from './data/types';
import { adjacentChapter, chapterNumber, readerPath, searchEntries } from './lib/archive';
import { isBookmarks, isHistory, useStored, type ReadingHistory } from './lib/storage';
import WorldArt from './components/WorldArt';
import EntryArtwork, { hasCover } from './components/EntryArtwork';

const categoryIcons = { trailblaze: Compass, companion: Users, readable: FileText };
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
        className={`card-art world-${entry.world}${entry.category === 'trailblaze' && hasCover(entry.world) ? ' has-cover' : ''}`}
        href={href(readerPath(entry.id))}
        tabIndex={-1}
        aria-hidden="true"
      >
        {entry.category === 'trailblaze' ? (
          <EntryArtwork world={entry.world} />
        ) : (
          <WorldArt world={entry.world} />
        )}
        <span className="art-index">{String(entry.order).padStart(2, '0')} / ARCHIVE</span>
        <span className="demo-pill">예시 본문</span>
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
            {entry.chapters.length}
            {entry.category === 'trailblaze' ? '개 항목' : '개의 장'}
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
  const chapter = entry?.chapters.find((item) => item.id === parts[2]);
  const isReader = Boolean(chapter);
  const selectedCategory = categories.find((item) => item.id === params.get('category'))?.id;
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
    document.title = `${chapter?.title ?? entry?.title ?? (path === '/archive' ? (selectedCategory ? categoryName(selectedCategory) : '아카이브 탐색') : path === '/library' ? '내 서재' : path === '/about' ? '서고 안내' : '열차의 서고')} · 스타레일 아카이브`;
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
    window.location.hash = `/archive${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ''}`;
  };
  const recent = Object.entries(history)
    .filter(([id, progress]) =>
      archive.some(
        (item) => item.id === id && item.chapters.some((ch) => ch.id === progress.chapterId),
      ),
    )
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  const lastEntry = recent[0] && archive.find((item) => item.id === recent[0][0]);
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
    value ? next.set(key, value) : next.delete(key);
    window.location.hash = `/archive${next.size ? `?${next}` : ''}`;
  };
  const navActive = (target: string) => path === target;
  let content;

  if (path === '/') {
    content = (
      <>
        <div className="page-intro">
          <span className="eyebrow">
            <span className="tiny-star">✦</span> THE ASTRAL ARCHIVE
          </span>
          <div className="intro-line">
            <h1>열차의 서고</h1>
            <span className="language-chip">
              한국어 아카이브 <span>KO</span>
            </span>
          </div>
          <p>지나온 별의 이야기, 다시 펼쳐 보는 여정.</p>
        </div>
        <section className="hero">
          <div className="hero-copy">
            <span className="hero-eyebrow">
              <span /> 은하를 여행하는 개척자를 위한 기록
            </span>
            <h2>
              모든 여정은
              <br />한 편의 이야기로 남는다.
            </h2>
            <p>
              별과 별 사이에 남겨진 대화와 기록들.
              <br />
              당신이 찾던 이야기를 이곳에서 만나 보세요.
            </p>
            <a className="button gold" href="#/archive?category=trailblaze">
              이야기 둘러보기 <ArrowRight size={17} />
            </a>
          </div>
          <WorldArt world="space-station" hero />
          <div className="hero-caption">
            <span>01 — THE BEGINNING</span>
            <span>기록으로 이어지는 은하의 여정</span>
          </div>
        </section>
        <div className="quick-categories">
          {categories.map((item) => {
            const Icon = categoryIcons[item.id];
            return (
              <a key={item.id} href={href(`/archive?category=${item.id}`)}>
                <span className={`quick-icon ${item.id}`}>
                  <Icon size={21} strokeWidth={1.5} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
                <ChevronRight size={17} />
              </a>
            );
          })}
        </div>
        <section className="section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FOLLOW THE JOURNEY</span>
              <h2>별을 따라, 이야기 속으로</h2>
            </div>
            <a className="text-link" href="#/archive?category=trailblaze">
              개척 임무 전체 보기 <ArrowRight size={15} />
            </a>
          </div>
          {cards(archive.filter((item) => item.category === 'trailblaze'))}
        </section>
        <div className="home-bottom">
          <section className="section companion-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">PEOPLE ALONG THE WAY</span>
                <h2>여정에서 만난 얼굴들</h2>
              </div>
              <a className="text-link" href="#/archive?category=companion">
                더 보기 <ArrowRight size={14} />
              </a>
            </div>
            <div className="companion-list">
              {archive
                .filter((item) => item.category === 'companion')
                .map((item, index) => (
                  <a href={href(readerPath(item.id))} key={item.id}>
                    <span className={`portrait portrait-${index}`}>
                      <Users size={25} strokeWidth={1} />
                    </span>
                    <span>
                      <small>{item.subtitle}</small>
                      <strong>{item.title}</strong>
                    </span>
                    <ChevronRight size={17} />
                  </a>
                ))}
            </div>
          </section>
          <section className="continue-panel">
            <span className="eyebrow">
              <BookMarked size={14} /> MY READING ROOM
            </span>
            <h2>{lastEntry ? '멈췄던 이야기, 그다음 장으로' : '당신만의 여정을 모아 보세요'}</h2>
            <p>
              {lastEntry
                ? `${lastEntry.title} · ${lastEntry.chapters.find((ch) => ch.id === recent[0][1].chapterId)?.title}`
                : '마음에 남은 이야기는 북마크에, 읽던 이야기는 읽기 기록에 보관됩니다.'}
            </p>
            <a
              className="text-link"
              href={
                lastEntry ? href(readerPath(lastEntry.id, recent[0][1].chapterId)) : '#/library'
              }
            >
              {lastEntry ? '이어서 읽기' : '내 서재 열기'} <ArrowRight size={15} />
            </a>
          </section>
        </div>
        <div className="demo-notice">
          <Sparkles size={17} />
          <p>
            <strong>서고를 준비하고 있어요.</strong> 현재 표시된 {archive.length}개 자료는 기능
            확인용 예시입니다. 실제 게임 텍스트는 추출 검증 후 연결됩니다.
          </p>
          <a href="#/about" aria-label="예시 자료와 서고 안내">
            <ArrowRight size={17} />
          </a>
        </div>
      </>
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
              : '별과 인물, 작은 기록을 따라 원하는 이야기를 찾아보세요.'
          }
        />
        <div className="category-tabs" aria-label="자료 분류">
          {[{ id: '', label: '전체 기록' }, ...categories].map((item) => (
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
            총 <strong>{results.length}</strong>개 기록 · 예시 본문
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
                        {item.chapters.find((ch) => ch.id === progress.chapterId)?.title} ·{' '}
                        {new Date(progress.updatedAt).toLocaleDateString('ko-KR')}
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
  } else if (entry && parts.length === 2) {
    const progress = history[entry.id];
    const resume = entry.chapters.find((ch) => ch.id === progress?.chapterId) ?? entry.chapters[0];
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
            <div className="tags">
              {entry.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
              <span>한국어</span>
              <span>예시 본문</span>
            </div>
          </div>
          {entry.category === 'trailblaze' ? (
            <EntryArtwork world={entry.world} />
          ) : (
            <WorldArt world={entry.world} />
          )}
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
                  예시 대사
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
        <p className="source-note">
          자료 출처:{' '}
          {entry.source.kind === 'demo' ? entry.source.note : `게임 자료 ${entry.source.version}`}.
        </p>
      </>
    );
  } else if (entry && chapter && parts.length === 3) {
    content = (
      <Reader
        key={`${entry.id}/${chapter.id}`}
        entry={entry}
        chapterId={chapter.id}
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
          title="서고 안내"
          description="별을 따라 이어지는 이야기를 더 편하게 읽을 수 있도록."
        />
        <article className="about-panel">
          <h2>스타레일 텍스트 아카이브</h2>
          <p>
            열차의 서고는 붕괴: 스타레일의 텍스트를 탐색하고 읽기 위한 비공식 팬 프로젝트입니다.
            LimBooks의 분류, 챕터 탐색과 읽기 흐름을 참고해 스타레일에 맞게 새로 구현했습니다.
          </p>
          <h2>지금은 기본 뼈대를 준비 중입니다</h2>
          <p>
            개척 임무 목록과 하위 목차는 사용자가 제공한 프롤로그와 제1~5장의 제목 및 소개문으로
            구성했습니다. 챕터 본문은 기능을 확인하기 위한 자체 작성 예시이며, 공식 대사가 아닙니다.
            현재 실제 게임 챕터 텍스트와 음성은 제공하지 않습니다.
          </p>
          <h2>앞으로 자료를 연결하는 방법</h2>
          <p>
            입력 자료와 추출 도구의 호환성을 확인한 후, 추출 결과를 지역·분류·챕터·대사 구조로
            변환해 연결할 예정입니다. 자료의 출처와 버전을 함께 기록합니다.
          </p>
          <h2>내 서재와 읽기 설정</h2>
          <p>
            북마크, 마지막으로 읽은 장, 읽기 위치, 화면 테마와 글자 크기는 현재 브라우저에
            저장됩니다. 브라우저 데이터를 지우면 기록도 초기화됩니다.
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
    <div className={`app ${isReader ? 'reading-mode' : ''}`}>
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
            <strong>열차의 서고</strong>
            <small>HONKAI: STAR RAIL ARCHIVE</small>
          </span>
        </a>
        <div className="sidebar-rule" />
        <nav>
          <span className="nav-label">EXPLORE</span>
          <a
            className={navActive('/') ? 'active' : ''}
            href="#/"
            aria-current={navActive('/') ? 'page' : undefined}
          >
            <Home size={18} />
            서고 홈{navActive('/') && <span className="nav-dot" />}
          </a>
          <a
            className={navActive('/archive') && !selectedCategory ? 'active' : ''}
            href="#/archive"
          >
            <Library size={18} />
            전체 아카이브<span className="nav-count">{archive.length}</span>
          </a>
          <span className="nav-label nav-space">STORIES</span>
          {categories.map((item) => {
            const Icon = categoryIcons[item.id];
            const active =
              (navActive('/archive') && selectedCategory === item.id) ||
              entry?.category === item.id;
            return (
              <a
                key={item.id}
                className={active ? 'active' : ''}
                aria-current={active ? 'page' : undefined}
                href={href(`/archive?category=${item.id}`)}
              >
                <Icon size={18} />
                {item.label}
              </a>
            );
          })}
          <span className="nav-label nav-space">MY ARCHIVE</span>
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
          <div className="orbit-decoration">
            ✧<span>기록은 남고, 여정은 계속됩니다.</span>
          </div>
          <a href="#/about">
            <BookOpen size={15} />
            서고 안내 <ChevronRight size={14} />
          </a>
          <div className="sidebar-version">
            <span className="status-dot" />
            개발 미리보기<span>v0.1.0</span>
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
            ARCHIVE <ChevronRight size={12} />
            <span>
              {entry
                ? categoryName(entry.category)
                : path === '/archive'
                  ? '이야기 탐색'
                  : path === '/library'
                    ? '내 서재'
                    : path === '/about'
                      ? '서고 안내'
                      : '서고 홈'}
            </span>
          </div>
          <form className="global-search" onSubmit={submitSearch} role="search">
            <Search size={16} />
            <input
              ref={searchRef}
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
            aria-label={theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환'}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
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
          <span>
            <span className="tiny-star">✦</span> 열차의 서고 <span className="footer-dot">·</span>{' '}
            비공식 스타레일 텍스트 아카이브
          </span>
          <a href="#/about">
            개발용 예시 데이터 <ArrowRight size={12} />
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
  fontSize,
  setFontSize,
  saved,
  toggleBookmark,
  history,
  setHistory,
}: {
  entry: ArchiveEntry;
  chapterId: string;
  fontSize: number;
  setFontSize: (value: number) => void;
  saved: boolean;
  toggleBookmark: () => void;
  history: ReadingHistory;
  setHistory: (value: ReadingHistory | ((previous: ReadingHistory) => ReadingHistory)) => void;
}) {
  const chapter = entry.chapters.find((ch) => ch.id === chapterId)!;
  const initialScroll = useRef(
    history[entry.id]?.chapterId === chapterId ? history[entry.id].scroll : 0,
  );
  const previous = adjacentChapter(entry, chapterId, -1);
  const next = adjacentChapter(entry, chapterId, 1);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
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
      window.scrollTo(0, initialScroll.current);
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
  }, [entry.id, chapterId, setHistory]);

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
      <div className="reader-layout">
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
            <div className="reader-demo">
              <Sparkles size={14} /> 실제 게임 대사가 아닌 기능 확인용 예시 본문입니다.
            </div>
          </header>
          <div className="text-blocks">
            {chapter.blocks.map((block) =>
              block.type === 'dialogue' ? (
                <div key={block.id} className="dialogue">
                  <span className="speaker-mark">✦</span>
                  <div>
                    <h2>{block.speaker}</h2>
                    <p>{block.text}</p>
                  </div>
                </div>
              ) : (
                <p key={block.id} className="narration">
                  {block.text}
                </p>
              ),
            )}
          </div>
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
        </article>
      </div>
    </>
  );
}
