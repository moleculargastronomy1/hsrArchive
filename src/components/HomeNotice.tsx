import useContentUpdateStatus from '../hooks/useContentUpdateStatus';
import useSiteUpdateStatus from '../hooks/useSiteUpdateStatus';
import { siteUpdateDate } from '../lib/content-update';

export default function HomeNotice() {
  const status = useContentUpdateStatus();
  const siteStatus = useSiteUpdateStatus();
  const chapter = status?.latestTrailblaze;
  return (
    <section className="hero-notice" aria-labelledby="home-notice-title">
      <h3 id="home-notice-title">공지사항</h3>
      <p>아카이브 업데이트 : {siteStatus ? siteUpdateDate(siteStatus) : '확인 중'}</p>
      {chapter ? (
        <p>
          {chapter.chapter}장 {chapter.act}막 「{chapter.title}」
        </p>
      ) : (
        <p>최신 개척 임무 정보를 확인하고 있습니다.</p>
      )}
    </section>
  );
}
