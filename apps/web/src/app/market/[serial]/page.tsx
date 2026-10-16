import type { Metadata } from "next";
import { PassportOrders } from "@/components/order-detail";
export const dynamic = "force-dynamic";
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
export async function generateMetadata({ params }: { params: { serial: string } }): Promise<Metadata> { return { title: `Market · ${decode(params.serial)}` }; }
/** All orders of one passport (a single open order is shown directly); each order has its own page under /market/o/<order>. */
export default function PassportOrdersPage({ params }: { params: { serial: string } }) { return <PassportOrders serial={decode(params.serial)} />; }
