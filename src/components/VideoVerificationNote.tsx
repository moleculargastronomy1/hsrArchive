import { useEffect, useState } from 'react';

type VideoReview = {
  videos: { id: string; title: string }[];
  captionMatches: number;
  screenMatches?: number;
  status: string;
};

export default function VideoVerificationNote({ file }: { file: string }) {
  const [review, setReview] = useState<VideoReview>();
  useEffect(() => {
    const controller = new AbortController();
    setReview(undefined);
    fetch(`${import.meta.env.BASE_URL}video-review-summary.json`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        const item = data.chapters?.[file];
        if (
          data.schema === 'hsr-video-review-summary.v1' &&
          Array.isArray(item?.videos) &&
          item.videos.every(
            (video: { id?: unknown; title?: unknown }) =>
              typeof video.id === 'string' &&
              /^[\w-]{11}$/.test(video.id) &&
              typeof video.title === 'string',
          ) &&
          Number.isSafeInteger(item.captionMatches) &&
          item.captionMatches >= 0 &&
          typeof item.status === 'string' &&
          !controller.signal.aborted
        )
          setReview(item);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [file]);
  if (!review?.videos.length) return null;
  return (
    <span>
      영상 보조 대조:{' '}
      {review.status === 'caption-order-conflict'
        ? '순서 충돌 검토 중'
        : review.screenMatches
          ? `화면 대사 ${review.screenMatches}줄 대조`
          : review.captionMatches
            ? `자막 문장 ${review.captionMatches}줄 일치`
            : '확인 대기'}
      . 공개 자막을 읽지 못했거나 연결이 모호한 구간은 미확인으로 유지합니다.
      {review.videos.map((video) => (
        <span key={video.id} style={{ display: 'block' }}>
          <a href={`https://www.youtube.com/watch?v=${video.id}`} target="_blank" rel="noreferrer">
            한국어 플레이 영상 · {video.title}
          </a>
        </span>
      ))}
    </span>
  );
}
