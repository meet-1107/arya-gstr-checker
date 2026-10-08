"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { SearchCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/form";
import { extractGstins } from "@/lib/gstin-extract";
import { normalizeGstin } from "@/lib/gstin";

/** Dashboard shortcut: paste or type a GSTIN, land on /verify with the answer already loading. */
export function QuickVerify() {
  const router = useRouter();
  const [text, setText] = useState("");
  const go = (value: string) => {
    const g = extractGstins(value).valid[0] ?? normalizeGstin(value);
    if (g) router.push(`/verify?gstin=${encodeURIComponent(g)}`);
  };
  const submit = (e: FormEvent) => { e.preventDefault(); go(text); };
  return (
    <Card inset className="mb-4 p-3.5 sm:mb-6 sm:p-4">
      <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row sm:items-center" role="search" aria-label="Quick verify a GSTIN">
        <label htmlFor="quick-gstin" className="shrink-0 text-sm font-medium">Verify a GSTIN</label>
        <Input
          id="quick-gstin" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} placeholder="Paste or type a GSTIN" autoComplete="off" autoCapitalize="characters" spellCheck={false}
          className="font-mono uppercase tracking-wide sm:flex-1" maxLength={24}
          onPaste={(e) => { const x = extractGstins(e.clipboardData.getData("text")); if (x.valid.length) { e.preventDefault(); go(x.valid[0]); } }}
        />
        <Button type="submit" variant="primary" disabled={!text.trim()}><SearchCheck className="size-4" aria-hidden />Verify</Button>
      </form>
    </Card>
  );
}
