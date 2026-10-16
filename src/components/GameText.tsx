import { Fragment } from 'react';
import { parseGameText } from '../lib/game-text';

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`(${escaped.join('|')})`, 'gi');
  return (
    <>
      {text
        .split(regex)
        .map((part, index) =>
          terms.some((term) => term.toLocaleLowerCase() === part.toLocaleLowerCase()) ? (
            <mark key={index}>{part}</mark>
          ) : (
            part
          ),
        )}
    </>
  );
}

export default function GameText({ text, query = '' }: { text: string; query?: string }) {
  return (
    <>
      {parseGameText(text).map((part, index) =>
        part.ruby === undefined ? (
          <Fragment key={index}>
            <Highlight text={part.text} query={query} />
          </Fragment>
        ) : (
          <ruby className="game-ruby" key={index}>
            <Highlight text={part.text} query={query} />
            <rp>(</rp>
            <rt>
              <Highlight text={part.ruby} query={query} />
            </rt>
            <rp>)</rp>
          </ruby>
        ),
      )}
    </>
  );
}
