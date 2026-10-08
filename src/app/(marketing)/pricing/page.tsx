import type { Metadata } from "next";
import { PricingSection } from "@/components/marketing/pricing";

export const metadata: Metadata = { title: "Pricing", description: "Simple plans for CA firms of every size. Start free." };

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-16 sm:py-20">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Pricing that grows with your practice</h1>
        <p className="mt-4 text-lg text-muted">One subscription for your whole firm. Everyone on your team shares the same clients and monthly GST check allowance.</p>
      </div>
      <PricingSection withComparison />
    </div>
  );
}
