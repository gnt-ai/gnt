import type { ZudokuConfig } from "zudoku";
import { LandingPage } from "zudoku/components";
import { CodeIcon, DatabaseIcon, PlugIcon, RocketIcon, WrenchIcon } from "zudoku/icons";

import "./styles.css";

// Brand pass mapping gnt.ai's own design system (apps/web/app/globals.css)
// onto Zudoku's shadcn-derived theme.light/dark tokens (see its Colors &
// Theme docs) -- Parchment canvas, Off-Black text, Ash borders, the real
// green reserved for destructive/status the way apps/web reserves it for
// --success. Radius stays a single moderate value (Zudoku's shadcn base
// only exposes one --radius, derived into sm/md/lg/xl by its own CSS) --
// gnt.ai's own --radius/--radius-lg (16px) is the closest one-value match
// to a system that's otherwise pill-and-soft-rect at very different
// component scales (40px cards, 100px buttons) this base token can't
// represent directly.
const config: ZudokuConfig = {
  site: {
    title: "gnt.ai",
    logo: {
      src: { light: "/logo-light.svg", dark: "/logo-dark.svg" },
      alt: "gnt.ai",
      width: "110px",
      // Was left at the default "/" (docs home) on purpose; changed back
      // to the marketing site on request -- a reader clicking the gnt.ai
      // mark expects the main site, not another docs page. reloadDocument
      // defaults to true already (Zudoku's own site.logo docs), which is
      // what a cross-origin jump needs anyway -- client-side routing
      // can't carry across docs.gntai.dev -> gntai.dev regardless.
      href: "https://gntai.dev",
    },
  },
  theme: {
    // apps/web's fonts.css note in styles.css explains why sans and mono
    // point at the same face: gnt.ai has no separate UI sans, IBM Plex
    // Mono (self-hosted below, not fetched from Google Fonts at runtime --
    // see public/fonts.css) is the whole site's UI voice per globals.css's
    // own "the monospace IS the brand voice" framing. Source Serif 4 is
    // reserved for headings only (styles.css), matching apps/web reserving
    // it for headings and IBM Plex Mono for body/UI.
    fonts: {
      sans: { url: "/fonts.css", fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace" },
      mono: { url: "/fonts.css", fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, monospace" },
      serif: { url: "/fonts.css", fontFamily: "'Source Serif 4', Georgia, serif" },
    },
    light: {
      background: "#f6f3f1", // --color-parchment
      foreground: "#242424", // --color-off-black
      card: "#ece9e7", // --surface-low
      cardForeground: "#242424",
      popover: "#e2dedd", // --surface
      popoverForeground: "#242424",
      primary: "#242424", // matches --accent-brand's monochrome pair
      primaryForeground: "#f6f3f1",
      secondary: "#e2dedd", // --surface
      secondaryForeground: "#242424",
      muted: "#ece9e7", // --surface-low
      mutedForeground: "#4e4d4d", // --color-graphite, same as globals.css's --muted text color
      accent: "#e2dedd", // --surface
      accentForeground: "#242424",
      destructive: "#b91c1c", // --error
      destructiveForeground: "#f6f3f1",
      border: "#cecac8", // --color-ash, globals.css's own hairline-border color
      input: "#cecac8",
      ring: "#242424", // matches --accent, what globals.css's :focus-visible outlines with
      radius: "1rem",
    },
    dark: {
      background: "#141414", // dark :root's --shell/--background
      foreground: "#f6f3f1", // Parchment reused as dark-theme text, same as globals.css
      card: "#242424", // Off-Black -- globals.css's own elevated-surface tone in dark mode
      cardForeground: "#f6f3f1",
      popover: "#242424",
      popoverForeground: "#f6f3f1",
      primary: "#f6f3f1", // matches dark --accent-brand's monochrome pair
      primaryForeground: "#242424",
      secondary: "#464645", // .theme-dark-surface's --surface
      secondaryForeground: "#f6f3f1",
      muted: "#2d2d2c", // dark :root's --surface-low
      mutedForeground: "#b9b5b4", // dark :root's derived --muted text color
      accent: "#464645",
      accentForeground: "#f6f3f1",
      destructive: "#f87171", // dark :root's --error
      destructiveForeground: "#141414",
      // Solid approximation of globals.css's translucent dark border
      // (rgba(246,243,241,0.12) over #141414) -- a flat value here since
      // Tailwind's own alpha utilities (border/50 etc) may derive further
      // opacity from this token, which an already-transparent color would
      // compound incorrectly.
      border: "#2f2f2d",
      input: "#2f2f2d",
      ring: "#f6f3f1", // matches dark --accent, same focus-ring role
      radius: "1rem",
    },
  },
  navigation: [
    // Card-grid documentation hub at "/" -- Zudoku's own built-in
    // LandingPage "grid" variant (zero new dependency, not a bespoke
    // build), the same reference-style card-grid landing the brief asked
    // for. display: "hide" keeps this entry out of the top tab bar itself
    // (it's the root page those tabs already sit under, not a sibling
    // section); the header/sidebar/footer chrome stays on (no
    // layout: "none") since this is a documentation hub that should still
    // offer the standing top nav, not a chrome-free marketing splash.
    // Card copy below is drawn straight from each target page's own real
    // frontmatter description, not new marketing prose.
    {
      type: "custom-page",
      path: "/",
      display: "hide",
      element: (
        <LandingPage
          variant="grid"
          title="gnt.ai docs"
          description="Connect gnt-brain to any MCP-capable agent. Check an action or query a rule in one call."
          features={[
            {
              icon: <RocketIcon />,
              title: "Quickstart",
              description: "Get a key, connect an agent, and see how a rule gets approved.",
              href: "/docs/quickstart",
            },
            {
              icon: <WrenchIcon />,
              title: "Tools & Enforcement",
              description: "The 5 MCP tools gnt-brain exposes, and how to enforce check_action before acting.",
              href: "/docs/tools",
            },
            {
              icon: <PlugIcon />,
              title: "Connect an Agent",
              description: "claude.ai, Claude Code, a raw MCP client, OpenAI, Hermes, or OpenClaw.",
              href: "/docs/connect",
            },
            {
              icon: <DatabaseIcon />,
              title: "Sources",
              description: "Pull decision-prose in from the tools your team already uses.",
              href: "/docs/sources",
            },
            {
              icon: <CodeIcon />,
              title: "API Reference",
              description: "The full HTTP API gnt-brain runs on.",
              href: "/api",
            },
          ]}
        />
      ),
    },
    // First tab, not tucked away -- the logo already links back to the
    // marketing site (see site.logo's own href/comment above), but a
    // reader deep in a doc page won't necessarily think to click the
    // mark. An explicit top-nav tab is the straightforward way back,
    // same reasoning reloadDocument gets on the logo: this is a real
    // cross-origin jump, not client-side routing.
    {
      type: "link",
      to: "https://gntai.dev",
      label: "gnt.ai site",
      icon: "external-link",
    },
    {
      type: "doc",
      file: "docs/quickstart",
      label: "Quickstart",
      icon: "rocket",
    },
    {
      type: "category",
      label: "Tools & Enforcement",
      icon: "wrench",
      items: ["docs/tools", "docs/enforce"],
    },
    {
      type: "category",
      label: "CLI Commands",
      icon: "terminal",
      items: ["docs/org", "docs/billing", "docs/stale"],
    },
    {
      type: "category",
      label: "Connect an Agent",
      icon: "plug",
      items: ["docs/connect", "docs/mcp-clients", "docs/hermes-agent"],
    },
    {
      type: "category",
      label: "Sources",
      icon: "database",
      items: [
        "docs/sources",
        "docs/granola",
        "docs/zoom",
        "docs/gmail-export",
        "docs/outlook-export",
        "docs/meeting-notes-export",
      ],
    },
    {
      type: "link",
      to: "/api",
      label: "API Reference",
      icon: "code",
    },
  ],
  // Pagefind: already bundled with zudoku itself (see its own package.json),
  // so this is zero new dependencies, unlike the Algolia/Inkeep providers
  // which need a separate package and a third-party account. Static,
  // self-hosted search, generated at build time -- no external service,
  // no API key, matching this site's own self-hosted brief.
  search: {
    type: "pagefind",
  },
  apis: [
    {
      type: "file",
      input: "./apis/openapi.yaml",
      path: "/api",
    },
  ],
};

export default config;
