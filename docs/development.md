# development

## run it locally

```sh
pnpm install
pnpm keygen        # writes .dev.vars (SIGNING_KEY + ADMIN_TOKEN)
pnpm dev           # http://localhost:5173
pnpm seed          # in another terminal: cuts, signs and uploads every piece
```

`pnpm test` checks the core (tiling, wear cycle, tamper detection, forgetting). `pnpm typecheck` covers the client and the worker.

## the picture

- `art/master.png` is the lossless source the pieces are cut from. it must be exactly `cols × cell` by `rows × cell` (see `src/shared/config.ts`; currently 20 × 14 at 128 px = 2560 × 1792).
- `public/master.jpg` is the same picture, compressed, for the board in the browser.

to swap the picture (before launch only):

```sh
sips -m "/System/Library/ColorSync/Profiles/sRGB Profile.icc" -s format png -z 1792 2560 photo.jpg --out art/master.png
sips -s format jpeg -s formatOptions 88 art/master.png --out public/master.jpg
```

## deploy (cloudflare)

one-time setup:

```sh
pnpm wrangler login
pnpm wrangler r2 bucket create puzzle
pnpm keygen --prod                        # writes .prod.vars, back it up somewhere safe
pnpm run deploy                           # first deploy (not `pnpm deploy`, that's a pnpm built-in)
pnpm wrangler secret bulk .prod.vars      # SIGNING_KEY + ADMIN_TOKEN
pnpm seed https://puzzle.<you>.workers.dev
```

once real people hold pieces, never change `SIGNING_KEY`, the picture, the grid, or `PUZZLE.seed`: every piece in the world would stop matching.

## how it works

| part | where |
|---|---|
| static site + `master.jpg` | workers static assets |
| api | one worker (`src/worker/index.ts`) |
| who holds what | one durable object with sqlite (`src/worker/puzzle.ts`): per piece only `state`, `seq`, a hash of the holder's secret, and pending ghost sightings |
| pieces sitting in the puzzle | r2, `pieces/{id}.png` (the returned file itself, wear and all) |
| piece history | **only inside the piece files** |

**piece states:** `in` (stored in r2, anyone can take it), `out` (held by whoever has the current file; r2 copy deleted), `gift` (stored in r2, the gift link is the piece).

**a file is live** only if its `seq` matches the server and its 16-byte secret hashes to the stored hash. every state change bumps `seq`, so every other copy goes stale:
- the giver's file after wrapping → *keepsake*
- the returner's file after putting it back → *keepsake*
- anything older → *ghost*; the sighting is written into the piece's memory at its next change

**payload** (`src/shared/payload.ts`), hidden in the rgb lsbs of fully opaque pixels in row-major order (`src/shared/stego.ts`):
`PZL | version | puzzle | piece | seq | owners | total | secret | events[] | ed25519 signature`.
the signature covers the payload plus a hash of the visible pixels (lsbs zeroed), so neither the history nor the image can be edited.

**wear** (`src/shared/wear.ts`) is applied to the real pixels before embedding. handling wear on every take or redeem: edge grime, edge whitening, scuffs, creases, fraying, chips (about 10 hand-offs = well worn). age wear on return or gift-wrap, scaled by days since the piece left: sepia fade (half-life 1 year), stains, peels. frayed pixels can't hold data, so heavily used pieces remember less.

**shapes** come from `PUZZLE.seed` in `src/shared/config.ts`; the client draws the whole board from `master.jpg` and the seed, overlaying the stored image of any piece that has been passed around.

## api

| | |
|---|---|
| `GET /api/state` | `{ states: "iog…", seqs: [...] }`, edge-cached 2 s |
| `GET /api/piece/:id` | state, plus its memory if it's in the puzzle |
| `GET /api/piece/:id.png` | stored image of a piece in the puzzle |
| `POST /api/take` `{id?}` | → png (random piece if no id) |
| `POST /api/inspect` png | memory + `standing`: `current` / `returned` / `gifted` / `ghost` |
| `POST /api/return` png | put the piece back |
| `POST /api/gift` png | → `{ url }` (one-time, never expires) |
| `GET /api/gift/:token` | wrapped / opened dates |
| `POST /api/gift/:token/open` | → png |
| `PUT /api/admin/seed/:id` | used by `pnpm seed` (bearer `ADMIN_TOKEN`) |

## not done yet

- rate limiting / turnstile on take (nothing stops a script from emptying the puzzle)
- lazy overlay loading by viewport (needed past a few thousand pieces)
