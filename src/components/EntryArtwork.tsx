import station from '../../docs/reference-images/우주정거장 헤르타 main.png';
import jarilo from '../../docs/reference-images/야릴로main.png';
import luofu from '../../docs/reference-images/선주 나부main.png';
import penacony from '../../docs/reference-images/페나코니main.png';
import amphoreus from '../../docs/reference-images/앰포리어스 main.png';
import paradise from '../../docs/reference-images/이상 낙원 main.png';
import astropolis from '../../docs/reference-images/아스트로폴리스 main.png';
import type { World } from '../data/types';
import WorldArt from './WorldArt';

const covers: Partial<Record<World, string[]>> = {
  'space-station': [station],
  jarilo: [jarilo],
  luofu: [luofu],
  penacony: [penacony],
  amphoreus: [amphoreus],
  'paradise-astropolis': [paradise, astropolis],
};

export const hasCover = (world: World) => Boolean(covers[world]);

export default function EntryArtwork({ world }: { world: World }) {
  const images = covers[world];
  if (!images) return <WorldArt world={world} />;
  return (
    <div className="entry-artwork" aria-hidden="true">
      {images.map((src) => (
        <img key={src} src={src} alt="" loading="lazy" decoding="async" />
      ))}
    </div>
  );
}
