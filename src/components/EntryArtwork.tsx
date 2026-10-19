import station from '../../docs/reference-images/우주정거장 헤르타 main.png';
import jarilo from '../../docs/reference-images/야릴로main.png';
import luofu from '../../docs/reference-images/선주 나부main.png';
import penacony from '../../docs/reference-images/페나코니main.png';
import amphoreus from '../../docs/reference-images/앰포리어스 main.png';
import paradise from '../../docs/reference-images/이상 낙원 main.png';
import astropolis from '../../docs/reference-images/아스트로폴리스 main.png';
import aeons from '../../docs/reference-images/아카이브 이미지 에이언즈.webp';
import terms from '../../docs/reference-images/아카이브 이미지 고유명사.webp';
import simulation from '../../docs/reference-images/시뮬레이션 우주 기본 메인 일러스트.jpg';
import swarm from '../../docs/reference-images/시뮬레이션 우주-곤충 떼 재난 메인 일러.jpg';
import gears from '../../docs/reference-images/시뮬레이션 우주 황금과 기계 메인 일러.jpg';
import divergent from '../../docs/reference-images/시뮬레이션 우주 차분화 우주 메인 일러.png';
import unknowable from '../../docs/reference-images/시뮬레이션 우주 인지 불가 영역 메인 일러.webp';
import type { World } from '../data/types';
import WorldArt from './WorldArt';

const covers: Partial<Record<World, string[]>> = {
  'space-station': [station],
  jarilo: [jarilo],
  luofu: [luofu],
  penacony: [penacony],
  amphoreus: [amphoreus],
  'paradise-astropolis': [paradise, astropolis],
  'simulated-universe': [simulation],
};

const entryCovers: Record<string, string[]> = {
  'codex-aeons': [aeons],
  'codex-terms': [terms],
  'swarm-disaster': [swarm],
  'gold-and-gears': [gears],
  'divergent-universe': [divergent],
  'unknowable-domain': [unknowable],
};

const imagesFor = (world: World, entryId?: string) =>
  (entryId && entryCovers[entryId]) || covers[world];

export const hasCover = (world: World, entryId?: string) => Boolean(imagesFor(world, entryId));

export default function EntryArtwork({ world, entryId }: { world: World; entryId?: string }) {
  const images = imagesFor(world, entryId);
  if (!images) return <WorldArt world={world} />;
  return (
    <div className="entry-artwork" aria-hidden="true">
      {images.map((src) => (
        <img key={src} src={src} alt="" loading="lazy" decoding="async" />
      ))}
    </div>
  );
}
