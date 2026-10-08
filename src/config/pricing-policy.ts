// Pricing policy that is NOT part of a plan: tax treatment. Both fields are deliberately UNDECIDED (null): nothing in the app may assume
// whether displayed prices include GST until the owner decides. While undecided, bills carry `tax.status = "undecided"` and no tax amounts.
export interface TaxPolicy {
  /** true = displayed prices already include GST; false = GST is added on top; null = undecided. */
  pricesIncludeGst: boolean | null;
  /** GST rate in percent (e.g. 18), or null while undecided. A rate of 0 is a valid, explicit decision. */
  gstRatePercent: number | null;
}

export const TAX_POLICY: TaxPolicy = { pricesIncludeGst: null, gstRatePercent: null };
