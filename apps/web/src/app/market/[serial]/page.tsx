import type { Metadata } from "next";
import { PassportOrders } from "@/components/order-detail";
export const dynamic = "force-dynamic";
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
export async function generateMetadata({ params }: { params: Promise<{ serial: string }> }): Promise<Metadata> { return { title: `Market · ${decode((await params).serial)}` }; }
/** All orders of one passport (a single open order is shown directly); each order has its own page under /market/o/<order>. */
export default async function PassportOrdersPage({ params }: { params: Promise<{ serial: string }> }) { return <PassportOrders serial={decode((await params).serial)} />; }
