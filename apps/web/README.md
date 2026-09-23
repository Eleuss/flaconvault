# @flaconvault/web

Next.js 14 App Router. Mobile-first, Android Chrome is the demo device.

```bash
npm run dev -w @flaconvault/web      # http://localhost:3000
```

Routes: `/` landing · `/p/[serial]` public passport (no wallet, no login) · `/t` tag landing · `/dev` simulator console · `/scan` (next block) · `/wallet/[pubkey]` attester.
Reads everything from the verify server (`NEXT_PUBLIC_VERIFY_URL`, default `http://localhost:8787`).
