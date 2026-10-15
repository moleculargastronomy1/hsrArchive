import type { World } from '../data/types';

// Original vector scenery: no reference repository or game assets are copied.
export default function WorldArt({ world, hero = false }: { world: World; hero?: boolean }) {
  return (
    <svg
      className={`world-art ${hero ? 'hero-art' : ''}`}
      viewBox="0 0 400 240"
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`glow-${world}-${hero}`}>
          <stop stopColor="currentColor" stopOpacity=".26" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="245" cy="112" r="128" fill={`url(#glow-${world}-${hero})`} />
      <g stroke="currentColor" strokeWidth=".65" opacity=".35">
        <ellipse cx="238" cy="120" rx="126" ry="74" transform="rotate(-28 238 120)" />
        <ellipse
          cx="238"
          cy="120"
          rx="144"
          ry="95"
          transform="rotate(-28 238 120)"
          strokeDasharray="3 8"
        />
        <path d="M37 53h44m-22-22v44M340 191h22m-11-11v22M85 187h18m-9-9v18" />
        <path d="m56 136 65-49 86 18 73-67 53 47" strokeDasharray="2 5" />
      </g>
      <g fill="currentColor">
        <circle cx="56" cy="136" r="2" />
        <circle cx="121" cy="87" r="2" />
        <circle cx="207" cy="105" r="2" />
        <circle cx="280" cy="38" r="2" />
        <circle cx="333" cy="85" r="2" />
        <circle cx="354" cy="41" r="1" />
        <circle cx="26" cy="172" r="1" />
        <circle cx="162" cy="33" r="1.5" />
      </g>
      {world === 'space-station' && (
        <g stroke="currentColor">
          <circle cx="238" cy="120" r="55" fill="currentColor" fillOpacity=".055" />
          <ellipse
            cx="238"
            cy="120"
            rx="91"
            ry="21"
            transform="rotate(-28 238 120)"
            strokeWidth="3"
          />
          <ellipse cx="238" cy="120" rx="76" ry="13" transform="rotate(-28 238 120)" />
          <path d="m209 72 51 97m-74-65 103 33" opacity=".3" />
          <path d="m280 74 22-12 13 24-22 12z" fill="currentColor" fillOpacity=".1" />
        </g>
      )}
      {world === 'jarilo' && (
        <g stroke="currentColor">
          <circle cx="259" cy="87" r="37" fill="currentColor" fillOpacity=".08" />
          <path d="m105 194 66-89 41 60 35-39 73 68H105Z" fill="currentColor" fillOpacity=".08" />
          <path
            d="m155 127 16-22 17 25-17-7-16 4Zm73 21 19-22 24 23-24-9-19 8Z"
            fill="currentColor"
            fillOpacity=".3"
          />
          <path d="M201 194v-43h15v-20h9v20h15v43m-29-43v-9m-34 52v-28h15v28m60 0v-33h17v33" />
        </g>
      )}
      {world === 'luofu' && (
        <g stroke="currentColor">
          <circle cx="255" cy="90" r="44" fill="currentColor" fillOpacity=".08" />
          <path
            d="M100 181c31-15 41 7 72-7s52-10 76-2 42-7 74-4M129 199c35-9 58 3 82-4s54-6 82-2"
            opacity=".5"
          />
          <path d="M184 171v-48m66 48v-48m-83 0c22-4 40-12 50-29 10 17 28 25 50 29H167Zm11-31c18-3 31-9 39-21 8 12 21 18 39 21h-78Zm28 31v48m21-48v48m-10-104V55" />
          <path d="m143 158 74-14 72 14-32 19-79-3-35-16Z" fill="currentColor" fillOpacity=".1" />
        </g>
      )}
      {world === 'penacony' && (
        <g stroke="currentColor">
          <circle cx="238" cy="113" r="63" fill="currentColor" fillOpacity=".06" />
          <circle cx="238" cy="113" r="51" strokeDasharray="1 7" strokeWidth="3" />
          <path d="M238 72v41l25 15M162 194v-46h20v-19h16v65m6 0v-29h19v29m40 0v-40h18v-23h16v63m-71 0v-40h18v-17h10v57" />
          <path d="m237 37 4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" fill="currentColor" />
        </g>
      )}
    </svg>
  );
}
