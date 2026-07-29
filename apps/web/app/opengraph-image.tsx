import { ImageResponse } from "next/og";

export const alt = "gnt.ai: The rulebook your agents actually check.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Same dark palette as globals.css's --background/--foreground/--muted/
// --border (dark mode is the default theme -- see globals.css's :root
// block), not re-derived, since ImageResponse can't read CSS variables.
const BG = "#201d1d";
const FG = "#fdfcfc";
const MUTED = "#9a9898";
const BORDER = "rgba(253, 252, 252, 0.12)";

const WORDMARK = "gnt.ai";
const HEADLINE = "The rulebook your agents actually check.";
const SUBHEAD = "Rules live as files in your repo. Every answer traces to a merged PR.";

// Same IBM Plex Mono the site itself renders with (layout.tsx) -- this
// route has no dynamic APIs, so Next statically generates the image once
// at build time, same timing next/font/google's own fetch happens at.
// text= subsets the download to only the glyphs this image ever renders.
async function loadFont(weight: 400 | 700) {
  const text = WORDMARK + HEADLINE + SUBHEAD;
  const css = await fetch(
    `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@${weight}&text=${encodeURIComponent(text)}`
  ).then((res) => res.text());
  const fontUrl = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/)?.[1];
  if (!fontUrl) {
    throw new Error(`IBM Plex Mono ${weight} font URL not found in Google Fonts response`);
  }
  return fetch(fontUrl).then((res) => res.arrayBuffer());
}

export default async function Image() {
  const [regular, bold] = await Promise.all([loadFont(400), loadFont(700)]);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: BG,
          color: FG,
          fontFamily: "IBM Plex Mono",
        }}
      >
        <div style={{ display: "flex", fontSize: 32, fontWeight: 700, marginBottom: 48 }}>
          <span style={{ color: MUTED }}>[</span>
          {WORDMARK}
          <span style={{ color: MUTED }}>]</span>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 24,
            maxWidth: 920,
            borderLeft: `2px solid ${BORDER}`,
            paddingLeft: 40,
          }}
        >
          <div style={{ display: "flex", fontSize: 56, fontWeight: 700, lineHeight: 1.25 }}>
            {HEADLINE}
          </div>
          <div style={{ display: "flex", fontSize: 28, fontWeight: 400, color: MUTED, lineHeight: 1.4 }}>
            {SUBHEAD}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "IBM Plex Mono", data: regular, weight: 400, style: "normal" },
        { name: "IBM Plex Mono", data: bold, weight: 700, style: "normal" },
      ],
    }
  );
}
