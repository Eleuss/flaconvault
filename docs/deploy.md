# Deployment

**Live:** web https://flaconvault.vercel.app · verifier https://verify-production-00e9.up.railway.app (Railway project `flaconvault`, service `verify`, volume `verify-volume` at `/data`). Vercel project `flaconvault` (team `eleuss-projects`, root directory `apps/web`).

Two services. The **web app** runs on Vercel (stable domain for the stickers and the README links), the **verifier** on Railway with a persistent volume for SQLite and media. Tags point at the web domain `/t`; the web app forwards each tap once to the verifier.

## Verifier — Railway

- Build: `Dockerfile.verify` at the repo root (`railway.json` sets the builder and the `/health` healthcheck). Context = repo root, so `docs/seed` is inside the image.
- Volume: mount at `/data` (SQLite `FV_DB_PATH=/data/flaconvault.db`, media `/data/media`, Irys key `/data/irys-key.json`).
- Service variables:

| Variable | Value | Where from |
|---|---|---|
| `FV_MASTER_KEY` | `00000000000000000000000000000000` | factory key (hackathon) |
| `FV_KEY_MODE` | `factory` | |
| `FV_SERVER_ED25519_SEED` | same 32-byte hex as in the local `apps/verify/.env` | **secret** — it is the key registered on-chain as server key id 1; a new seed would need `add_server_key` |
| `FV_SERVER_KEY_ID` | `1` | |
| `FV_DEV_SIMULATOR` | `true` until hardware day, then `false` | |
| `FV_NONCE_TTL_S` | `90` | |
| `FV_SOLANA_RPC` | `https://api.devnet.solana.com` | |
| `FV_PROGRAM_ID` | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` | `docs/devnet.md` |
| `FV_DB_PATH` | `/data/flaconvault.db` | set in the Dockerfile |
| `FV_MEDIA_DIR` | `/data/media` | set in the Dockerfile |
| `FV_WEB_URL` | `https://flaconvault.vercel.app` | redirect target of `/t` |
| `FV_VERIFIER_HOST` | `https://verify-production-00e9.up.railway.app` | host in simulator tag URLs |
| `FV_CORS_ORIGINS` | `https://flaconvault.vercel.app,http://localhost:3000` | comma-separated |
| `FV_ARWEAVE` | `true` | |
| `FV_IRYS_KEY_JSON` | contents of `~/.config/solana/irys.json` | **secret** — a separate keypair (`7oSB1jK7btf5hhG9tbjUdtEJ18npuyA7dcD77CJyL3iB`, 0.05 devnet SOL), not the deploy wallet |
| `FV_IRYS_NETWORK` | `devnet` | |
| `FV_RECONCILE_INTERVAL_S` | `60` | |
| `PORT` | set by Railway | the Dockerfile honours it |

## Web app — Vercel

- Project root directory `apps/web`, framework Next.js, "Include source files outside of the Root Directory" on (npm workspaces: `packages/proof`, `packages/vision` build via their `prepare` scripts). Node 20+.
- Environment variables (Production):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_VERIFY_URL` | `https://verify-production-00e9.up.railway.app` |
| `NEXT_PUBLIC_SOLANA_RPC` | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_PROGRAM_ID` | `7dCr825ibTyE6Y5oPHP2RCmUi5qFPCaKdZmE9TYeAcWL` |
| `NEXT_PUBLIC_ESCROW_PROGRAM_ID` | `9vabByStbAqKH6sM6fuf8HhfGZbV3993Ncp3uZScexKL` |
| `NEXT_PUBLIC_DEV_SIMULATOR` | `true` until hardware day (dev wallets + simulator UI), then `false` |

`VERIFY_URL` (server-side fetches) defaults to `NEXT_PUBLIC_VERIFY_URL`.

## After both are up

1. `curl https://<railway-domain>/health` → `ok`, `programId` set.
2. Simulator tap: `POST https://<railway-domain>/api/dev/tap {"uid":"04A1B2C3D4E5F6"}` → open the returned URL with the host swapped to the web domain → „Siegel echt · Tap N“; open it again → „Wiederholter Tap“.
3. Write `https://flaconvault.vercel.app/t?uid=00000000000000&ctr=000000&cmac=0000000000000000` into the stickers (TagWriter SDM mirrors, see `docs/hardware-day.md`).
4. Local dev keeps working against localhost; only the hosted `.env`s differ.

## CLI cheat sheet (both CLIs are logged in on this Mac)

```bash
vercel --prod --yes                                   # redeploy web (repo root; project linked in .vercel/)
vercel env add NAME production --force                # change a web variable (value from stdin), then redeploy
railway up --service verify --detach --ci             # redeploy verifier from the repo root
railway variables --service verify --set K=V          # change a server variable (redeploys)
railway logs --service verify                         # server logs
```
