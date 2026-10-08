import { Suspense } from "react";
import type { Metadata } from "next";
import { VerifyEmailView } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Verify your email" };
export default function Page() { return <Suspense><VerifyEmailView /></Suspense>; }
