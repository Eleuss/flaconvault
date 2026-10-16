import type { Metadata } from "next";
import { OrderDetail } from "@/components/order-detail";
export const dynamic = "force-dynamic";
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
export async function generateMetadata({ params }: { params: Promise<{ order: string }> }): Promise<Metadata> { return { title: `Order · ${decode((await params).order).slice(0, 8)}…` }; }
/** One escrow order, addressed by its Order PDA (shared links and the Blink point here). */
export default async function OrderPage({ params }: { params: Promise<{ order: string }> }) { return <OrderDetail orderPda={decode((await params).order)} />; }
