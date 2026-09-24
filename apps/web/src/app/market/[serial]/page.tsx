import type { Metadata } from "next";
import { OrderDetail } from "@/components/order-detail";
export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: { serial: string } }): Promise<Metadata> { return { title: `Markt · ${decodeURIComponent(params.serial)}` }; }
export default function OrderPage({ params }: { params: { serial: string } }) { return <OrderDetail serial={decodeURIComponent(params.serial)} />; }
