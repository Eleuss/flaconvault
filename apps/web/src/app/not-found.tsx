import Link from "next/link";
export default function NotFound() {
  return (
    <div className="container-page py-24">
      <h1 className="font-serif text-4xl">Not found</h1>
      <p className="mt-3 max-w-md text-muted">There is no passport or page at this address. Check the serial number, or tap the seal to open its passport.</p>
      <Link href="/" className="btn-outline mt-6">Back to home</Link>
    </div>
  );
}
