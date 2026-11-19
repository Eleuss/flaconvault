import type { Metadata } from "next";
import Link from "next/link";
import { PUBLIC_RECORD_LINK, SAVE_BUTTON, SCAN_BY_LABEL } from "@/lib/public-record";

export const metadata: Metadata = { title: "Privacy" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl">{title}</h2>
      <div className="mt-3 space-y-3 text-sm text-muted [&_strong]:font-medium [&_strong]:text-ink">{children}</div>
    </section>
  );
}

const STORAGE: Array<[string, string]> = [
  ["fv.scanSession", "The scan running in this browser (session code, expiry, scan page address), so a tap on the seal page can be handed to it. Cleared when the scan step ends; useless after 90 seconds."],
  ["fv.tapHandoff, fv.tapHandoffClaim", "A seal tap handed from the seal page to the scan page (the chip link's parameters). Taken within seconds; ignored after 3 minutes."],
  ["fv.pendingEvent.<order>", "An escrow transaction that landed while the server's confirmation failed (its signature, your wallet and the planned history entry), so the confirmation can be retried; removed once the server confirms it."],
  ["fv.lastTap", "The last chip that is not yet assigned to a passport (UID, serial, counter), for the certify page. Ignored after one hour."],
  ["fv.scanOwner (sessionStorage)", "Which browser tab started the scan. Only in this tab; gone when the tab is closed."],
  ["walletName", "The wallet you picked, so it reconnects on your next visit."],
  ["SolanaMobileWalletAdapterDefaultAuthorizationCache", "Android only: the wallet app's authorization (wallet address and an access token from the wallet app)."],
  ["wc@2:…, @appkit/… (also IndexedDB)", "Only when you use WalletConnect: the WalletConnect session with your wallet app."],
  ["fv.demo, fv.devwallet.a, fv.devwallet.b", "Only in demo mode on development setups: the demo switch and the keys of the two demo wallets (in plain text in this browser)."],
];

export default function PrivacyPage() {
  return (
    <div className="page-in container-page max-w-3xl py-12">
      <p className="eyebrow">Privacy</p>
      <h1 className="mt-3 font-serif text-4xl">What FlaconVault stores, and where</h1>
      <p className="mt-4 text-muted">
        FlaconVault records the history of a perfume bottle: its seal taps, condition scans and changes of owner. A large
        part of that history is <strong className="font-medium text-ink">public and permanent by design</strong> — on the Solana
        blockchain and in the Arweave archive — so a buyer can check it without trusting us. Please read this before you
        scan, photograph or connect a wallet. There are no cookies, no analytics, no advertising and no tracking on this site.
      </p>

      <Section title="Scan without a wallet: the public record">
        <p>
          A <strong>seal tap</strong> (opening the seal&apos;s link) and a scan saved with &ldquo;{SAVE_BUTTON}&rdquo; need
          no wallet, no account and no signature from you. Our verification server signs the entry; our relayer, a key on
          that server that only pays fees, sends it to Solana and pays for it. A tap is saved there within about 3
          minutes, unless a scan of the same tap takes its place.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>On Solana, public and permanent</strong>: a hash of the serial number and of the chip UID, the chip counter, the purpose (tap or check), tier and role, a hash of the signed public record, a random one-time code, the time, and our server key and signature; for a check also the indicator readings (heat, humidity, light), the fill level and a hash of the photos, if any. The only wallet address in the transaction is our relayer&apos;s; the field for who scanned stays empty.</li>
          <li><strong>In the signed public record</strong>, a document the verification server serves with the passport&apos;s public data (Solana holds only its hash): also the serial number, the seal (box or neck) and the country, if you typed one.</li>
          <li><strong>Only on the verification server</strong>: the place you typed, your device type, the card photos themselves, and a note or wallet address if one is sent along (the scan page sends neither). They are not in the transaction, not in the signed public record and not shown on the passport page.</li>
          <li><strong>Not on Arweave</strong>: at present these scans and their photos are not uploaded to the archive.</li>
          <li><strong>On the passport page</strong>: the date, the label &ldquo;{SCAN_BY_LABEL.VISITOR}&rdquo;, the chip counter, what it was (a tap is listed as &ldquo;Sighting&rdquo;, a check as a scan with its readings), the country, and the link &ldquo;{PUBLIC_RECORD_LINK}&rdquo; to the transaction.</li>
          <li><strong>Limits</strong>: per seal, at most 3 taps and 1 check within 24 hours are sent to Solana. An entry beyond that, or one that could not be sent, is kept by FlaconVault only: on the verification server, and listed on the passport page without that link.</li>
        </ul>
        <p>
          What is on Solana cannot be changed or deleted by anyone, including us. What stays on the verification server is
          stored without automatic deletion at present.
        </p>
      </Section>

      <Section title="Public and permanent: Solana (devnet)">
        <p>
          Every anchored scan, passport, seal and escrow order is a Solana account or transaction. It is public, copied by
          every node and <strong>cannot be changed or deleted</strong> by anyone, including us. It contains:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Wallet addresses</strong>: of whoever anchors a scan (attester), issues a passport, attaches a seal, sells or buys.</li>
          <li><strong>Scan proofs</strong>: chip counter, tier and role, indicator readings (heat, humidity, light), fill level, a hash of the photos and of the scan record, server key and time.</li>
          <li><strong>Passports and seals</strong>: a hash of the serial number, the issuer wallet, the linked digital asset, a <strong>hash of the chip UID</strong> and its counter, and whether the seal stopped responding.</li>
          <li><strong>Escrow orders</strong>: seller and buyer wallets, price, state and times.</li>
        </ul>
        <p>Country and place are never part of a Solana transaction.</p>
      </Section>

      <Section title="Public and permanent: Arweave archive">
        <p>
          When archiving is enabled on the verification server, the record (the signed scan bundle) of each confirmed
          scan <strong>anchored with a wallet</strong> and its <strong>photos of the card</strong> are uploaded to Arweave
          through the Irys network. Arweave is built to keep data
          forever: <strong>an archived photo or record can never be deleted</strong>. The scan record includes the serial number,
          chip counter, indicator readings, fill level, the country and place you typed (if any), the device type (Android,
          iPhone or desktop browser), role and tier, the attester wallet, the session code and the server&apos;s signature. Keep
          faces, documents and anything personal out of the card photos.
        </p>
        <p>Scans saved without a wallet are not uploaded to Arweave at present.</p>
      </Section>

      <Section title="Verification server (Railway)">
        <p>The verification server checks seal taps, signs scans and serves the passport pages. It stores, without automatic deletion at present:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Every seal tap</strong>: the chip UID, counter and checksum, the result, the passport serial and the time. The raw chip UID stays on the server (it is needed to check the chip); public pages show only a hash or a short tail of it — except for a chip not yet assigned to a passport, whose UID is shown to the person who tapped it so it can be registered.</li>
          <li><strong>Scan records</strong>: as listed above for Arweave, plus whether the scan was confirmed on chain.</li>
          <li><strong>Scans without a wallet</strong>: the scan record as above (its place and device type stay here and are not public), the signed public record and the message we signed for Solana, and its status: waiting, saved or not saved, with the transaction and the fee we paid.</li>
          <li><strong>Card photos</strong>: the five frames you upload for a scan, stored as files on the server.</li>
          <li><strong>Country and place</strong>, only if you type them (two-letter country, a rough place name). No GPS, no location from your device.</li>
          <li><strong>Wallet addresses</strong> with per-wallet statistics (number of scans, certified scans, agreement with other scans) and, for partners, a public label.</li>
          <li><strong>&ldquo;Seal not responding&rdquo; reports</strong>: the serial, the wallet address you were connected with (if any) and the time.</li>
          <li><strong>Session codes</strong>: random one-time codes, deleted after they expire.</li>
        </ul>
        <p>
          Passport pages, their history and wallet statistics are public, without login. IP addresses are kept only briefly
          in the server&apos;s memory to limit request rates; they are not written to the database.
        </p>
      </Section>

      <Section title="Server logs">
        <p>
          The hosting providers of this web app (Vercel) and of the verification server (Railway) log requests: IP address,
          time, the requested address with its parameters (for a seal tap that includes the chip UID, counter and checksum
          from the seal&apos;s link) and the browser&apos;s user agent. These logs are kept for the providers&apos; standard retention
          period and are used only to run the service and to stop abuse.
        </p>
      </Section>

      <Section title="In your browser">
        <p>This site uses the browser&apos;s local storage (no cookies) for the following:</p>
        <dl className="divide-y divide-line border-y border-line">
          {STORAGE.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,16rem)_1fr] sm:gap-4">
              <dt className="mono break-all text-ink">{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p>You can remove all of it at any time in the browser&apos;s site settings. Camera frames are processed in your browser and leave it only when you press &ldquo;{SAVE_BUTTON}&rdquo; or &ldquo;Get signature&rdquo;.</p>
      </Section>

      <Section title="Services your browser talks to">
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Solana RPC</strong> (Solana devnet endpoint): reads accounts and sends your signed transactions; it sees your IP address and wallet address.</li>
          <li><strong>Your wallet app</strong> (Phantom, Solflare, Backpack …), and the <strong>WalletConnect / Reown relay</strong> if you connect through WalletConnect.</li>
          <li><strong>Phantom / Solflare links</strong> on iPhone: &ldquo;Continue in Phantom&rdquo; opens this site in the wallet app with a one-time reference to your signed scan.</li>
          <li><strong>Irys / Arweave gateway</strong> and <strong>Solana Explorer</strong>, only when you open a photo, record or transaction link.</li>
        </ul>
        <p>Fonts are served from this site; no request goes to Google Fonts.</p>
      </Section>

      <Section title="Your choices">
        <p>
          You can check a seal and read every passport without a wallet and without typing anything. A seal tap is itself
          saved to the public record, as described under &ldquo;Scan without a wallet&rdquo;. Photos, country and
          place are optional. Data on the verification server can be corrected or deleted on request where that does not
          break the history of a passport; data on Solana and Arweave cannot be changed or deleted by anyone. For requests,
          contact the operator of FlaconVault named in the legal notice on{" "}
          <a href="https://flaconvault.com" className="link">flaconvault.com</a>.
        </p>
      </Section>

      <p className="mt-12 text-xs text-muted">Last updated November 2026. <Link href="/" className="link">Back to home</Link></p>
    </div>
  );
}
