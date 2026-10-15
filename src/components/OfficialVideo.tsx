import { useEffect, useState } from 'react';
import { ArrowUpRight, Play, Youtube } from 'lucide-react';

interface VideoSnapshot {
  checkedAt: string;
  channelUrl: string;
  video: { id: string; title: string; published: string; url: string; isShort: boolean };
}

export default function OfficialVideo() {
  const [snapshot, setSnapshot] = useState<VideoSnapshot>();
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}official-videos.json`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Video unavailable');
        return response.json();
      })
      .then((data) => {
        if (/^[\w-]{11}$/.test(data.video?.id) && data.channelId === 'UCH33CJMcI0XZUpIhWRHiUuw')
          setSnapshot(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <section className="official-video" aria-label="스타레일 공식 최신 영상">
      <div className="video-heading">
        <Youtube size={17} />
        <span>공식 최신 영상</span>
        <a
          href="https://www.youtube.com/@Honkaistarrail_kr/videos"
          target="_blank"
          rel="noreferrer"
          aria-label="스타레일 공식 유튜브 채널 열기"
        >
          <ArrowUpRight size={15} />
        </a>
      </div>
      {snapshot ? (
        <>
          {playing ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${snapshot.video.id}?autoplay=1`}
              title={snapshot.video.title}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <button
              className="video-thumbnail"
              onClick={() => setPlaying(true)}
              aria-label={`${snapshot.video.title} 재생`}
            >
              <img
                src={`https://i.ytimg.com/vi/${snapshot.video.id}/hqdefault.jpg`}
                alt=""
                loading="lazy"
              />
              <span>
                <Play size={19} fill="currentColor" />
              </span>
            </button>
          )}
          <a className="video-title" href={snapshot.video.url} target="_blank" rel="noreferrer">
            {snapshot.video.title}
          </a>
          <p>
            {new Date(snapshot.video.published).toLocaleDateString('ko-KR', {
              timeZone: 'Asia/Seoul',
            })}{' '}
            업로드
          </p>
          <small>
            {new Date(snapshot.checkedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}{' '}
            확인 · 6시간마다 갱신
          </small>
        </>
      ) : (
        <a
          className="video-fallback"
          href="https://www.youtube.com/@Honkaistarrail_kr/videos"
          target="_blank"
          rel="noreferrer"
        >
          공식 채널에서 최신 영상 보기 <ArrowUpRight size={14} />
        </a>
      )}
    </section>
  );
}
