import { normalizedKorean as normalize } from './video-order.mjs';

const chapterKind = (title) =>
  title.startsWith('개척 후문:')
    ? 'continuance'
    : title.startsWith('종말 임무:')
      ? 'finality'
      : title.startsWith('모험 임무:')
        ? 'coda'
        : 'main';
function videoKind(title) {
  if (/개척\s*후문/.test(title)) return 'continuance';
  if (/종말\s*임무/.test(title)) return 'finality';
  if (/개척\s*임무.*후일담/.test(title)) return 'coda';
  if (/개척\s*임무|프롤로그/.test(title)) return 'main';
  return undefined;
}
function chapterNames(title) {
  const base = title.replace(/^(?:제\d+막|개척 후문|종말 임무|모험 임무):\s*/, '');
  const names = [base];
  const suffix = base.split(/[·•]/).at(-1);
  // A descriptive subtitle is useful; upper/lower labels never establish a
  // video's episode boundary and are not removed to guess its chapter.
  if (suffix !== base && normalize(suffix).length >= 5) names.push(suffix);
  return names;
}
function missionNames(title) {
  return [
    ...new Set([
      title,
      title.replace(
        /\s*(?:[（(](?:서막|서장|상|하|후일담|에필로그)[）)]|[·•]\s*(?:서막|서장|상|하))\s*$/,
        '',
      ),
    ]),
  ];
}

export function linkVideos(chapters, videos) {
  const matches = Object.fromEntries(chapters.map((chapter) => [chapter.file, []]));
  const review = [];
  for (const video of videos) {
    if (Array.isArray(video.files)) {
      for (const file of video.files) {
        const chapter = chapters.find(
          (item) => item.file === file && item.category === video.category,
        );
        if (chapter)
          matches[file].push({
            ...video,
            linkMethod: 'reviewed-mode-and-event-scope',
            matchedTitle: chapter.title,
          });
        else
          review.push({
            videoId: video.id,
            reason: '등록한 모드/사건 범위가 현재 목차와 일치하지 않음',
            candidateFiles: [file],
          });
      }
      continue;
    }
    const kind = videoKind(video.title);
    if (!kind) continue; // Event and companion videos cannot verify main story order.
    const major = video.title.match(/개척\s*임무\s*제\s*(\d+)\s*장/)?.[1];
    const quoted = [...video.title.matchAll(/[『「]([^』」]+)[』」]/g)].map((match) =>
      normalize(match[1]),
    );
    const normalized = normalize(video.title);
    const candidates = [];
    for (const chapter of chapters) {
      if (chapter.category === 'simulation') continue;
      if (chapterKind(chapter.title) !== kind) continue;
      const expectedMajor = chapter.arcLabel?.match(/제\s*(\d+)\s*장/)?.[1];
      if (major && expectedMajor && major !== expectedMajor) continue;
      const title = chapterNames(chapter.title).find(
        (name) =>
          (normalize(name).length >= 5 && normalized.includes(normalize(name))) ||
          (normalize(name).length >= 4 && quoted.includes(normalize(name))),
      );
      const mission = chapter.missionTitles
        ?.flatMap(missionNames)
        .find((name) => normalize(name).length >= 4 && quoted.includes(normalize(name)));
      if (title || mission)
        candidates.push({
          file: chapter.file,
          rank: title ? 2 : 1,
          method: title ? 'official-chapter-title' : 'official-mission-title',
          matchedTitle: title ?? mission,
        });
    }
    const highest = Math.max(0, ...candidates.map((candidate) => candidate.rank));
    const winners = candidates.filter((candidate) => candidate.rank === highest);
    if (winners.length === 1) {
      const winner = winners[0];
      matches[winner.file].push({
        ...video,
        linkMethod: winner.method,
        matchedTitle: winner.matchedTitle,
      });
    } else
      review.push({
        videoId: video.id,
        title: video.title,
        reason: winners.length
          ? '여러 장과 일치 · 영상 번호만으로 장을 추정하지 않음'
          : '공식 장/임무 제목 연결 근거 없음',
        candidateFiles: winners.length
          ? winners.map((winner) => winner.file)
          : chapters
              .filter(
                (chapter) =>
                  chapterKind(chapter.title) === kind &&
                  /[·•][상하]$/.test(chapter.title) &&
                  quoted.includes(
                    normalize(chapterNames(chapter.title)[0].replace(/[·•][상하]$/, '')),
                  ),
              )
              .map((chapter) => chapter.file),
      });
  }
  return { matches, review };
}
