# gnt-web

Next.js marketing site + docs — no dashboard. The terminal (`apps/cli`) is the product
surface; this app is the public gnt.ai site plus the couple of flows that genuinely need a
browser (Better Auth sign-up/sign-in, one-time `gnt login`, merging a proposed rule on GitHub).

## Setup

```bash
pnpm install
cp .env.local.example .env.local   # fill in DATABASE_URL/BETTER_AUTH_SECRET + NEXT_PUBLIC_API_URL
pnpm exec better-auth migrate      # creates Better Auth's own tables in that database
```

## Run

```bash
pnpm dev       # http://localhost:3000, needs apps/api running on :8000
```

## Other commands

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Deploy

Vercel, auto-deploys `main` on push — see the repo root README.
