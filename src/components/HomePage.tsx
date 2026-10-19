import type { FormEventHandler, ReactNode, Ref } from 'react';
import { ArrowRight, BookMarked, ChevronRight, Search } from 'lucide-react';
import { categories } from '../data/archive';
import type { ArchiveEntry, Chapter } from '../data/types';
import { readerPath } from '../lib/archive';
import CategoryIcon from './CategoryIcon';
import HomeNotice from './HomeNotice';
import OfficialVideo from './OfficialVideo';

const categoryDescriptions = {
  trailblaze: '뭇별로 향하는 궤도',
  simulation: '껍질 속 우주',
  codex: '은하열차 자료실',
  books: '지역별 서적, 편지와 문서',
};

export default function HomePage({
  search,
  setSearch,
  searchRef,
  onSearch,
  entries,
  lastEntry,
  lastChapter,
}: {
  search: string;
  setSearch: (value: string) => void;
  searchRef: Ref<HTMLInputElement>;
  onSearch: FormEventHandler<HTMLFormElement>;
  entries: ReactNode;
  lastEntry?: ArchiveEntry;
  lastChapter?: Chapter;
}) {
  return (
    <div className="home-content">
      <section className="home-intro" aria-labelledby="home-title">
        <p className="home-kicker">붕괴: 스타레일 한국어 자료실</p>
        <h1 id="home-title">열차 아카이브</h1>
        <form className="home-search" onSubmit={onSearch} role="search" aria-label="홈 원문 검색">
          <Search size={23} strokeWidth={1.6} aria-hidden="true" />
          <input
            ref={searchRef}
            aria-label="아카이브 원문 검색"
            placeholder="임무명, 인물 또는 대사 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <kbd>Ctrl K</kbd>
          <button type="submit" aria-label="원문 검색 실행">
            <ArrowRight size={21} />
          </button>
        </form>
        <div className="home-search-help">
          <span>한국어 원문 검색 · 영어 / 중국어 / 일본어 비교</span>
        </div>
      </section>

      <nav className="home-categories" aria-label="자료 분류 바로가기">
        {categories.map((category) => (
          <a key={category.id} href={`#/archive?category=${category.id}`}>
            <CategoryIcon category={category.id} />
            <span>
              <strong>{category.label}</strong>
              <small>{categoryDescriptions[category.id]}</small>
            </span>
            <ChevronRight className="home-category-arrow" size={16} />
          </a>
        ))}
      </nav>

      <div className="home-columns">
        <section className="home-missions" aria-labelledby="home-missions-title">
          <div className="home-section-heading">
            <div>
              <h2 id="home-missions-title">개척 임무</h2>
              <p>프롤로그부터 장 순서대로</p>
            </div>
            <a href="#/archive?category=trailblaze">
              전체 보기 <ArrowRight size={14} />
            </a>
          </div>
          {entries}
        </section>

        <aside className="home-aside" aria-label="읽기 기록과 새 소식">
          <section className="home-resume" aria-labelledby="home-resume-title">
            <h2 id="home-resume-title">
              <BookMarked size={17} /> 이어 읽기
            </h2>
            {lastEntry && lastChapter ? (
              <>
                <p className="home-resume-entry">{lastEntry.title}</p>
                <a
                  className="home-resume-link"
                  href={`#${readerPath(lastEntry.id, lastChapter.id)}`}
                >
                  <strong>{lastChapter.title}</strong>
                  <ArrowRight size={17} />
                </a>
                <p className="home-aside-note">마지막으로 읽은 위치에서 이어집니다.</p>
              </>
            ) : (
              <>
                <p className="home-resume-empty">읽던 기록이 여기에 남습니다.</p>
                <p className="home-aside-note">임무나 서적을 열면 마지막 읽기 위치를 저장합니다.</p>
              </>
            )}
            <a className="home-history-link" href="#/library?view=history">
              읽기 기록 <ChevronRight size={14} />
            </a>
          </section>
          <HomeNotice />
          <OfficialVideo />
          <a className="home-bookmarks-link" href="#/library">
            북마크한 자료 보기 <ArrowRight size={15} />
          </a>
        </aside>
      </div>
    </div>
  );
}
