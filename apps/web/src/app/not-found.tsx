import Link from "next/link";
export default function NotFound() {
  return (
    <div className="container-page py-24">
      <h1 className="font-serif text-4xl">This passport does not exist.</h1>
      <p className="mt-3 text-muted">Check the serial number or tap a seal.</p>
      <Link href="/" className="btn-outline mt-6">Back to home</Link>
    </div>
  );
}
