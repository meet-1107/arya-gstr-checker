// A client firm is the billing unit and may hold several GSTINs (one per state registration). `Client.gstin` stays the PRIMARY GSTIN
// (immutable, used wherever a single identity is needed); `Client.gstins` lists every GSTIN including the primary. Records created before
// multi-GSTIN support have no `gstins` field and are treated as holding just their primary.

export interface HasGstins { gstin: string; gstins?: string[] }

/** Every GSTIN of the client, primary first, de-duplicated. */
export function clientGstins(c: HasGstins): string[] {
  const all = c.gstins?.length ? c.gstins : [c.gstin];
  return all[0] === c.gstin ? [...new Set(all)] : [...new Set([c.gstin, ...all])];
}

export const clientHasGstin = (c: HasGstins, g: string) => clientGstins(c).includes(g);

/** PAN embedded in a GSTIN (characters 3-12). All GSTINs of one firm share it. */
export const panOf = (gstin: string) => gstin.slice(2, 12);

/** GST state codes (first two digits of a GSTIN) from the public GST state-code list. */
export const GST_STATE_NAMES: Readonly<Record<string, string>> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
  "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
  "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh",
  "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory", "99": "Centre Jurisdiction",
};

/** "Gujarat" for 24AAAAA…; undefined for an unknown code. */
export const stateNameOf = (gstin: string): string | undefined => GST_STATE_NAMES[gstin.slice(0, 2)];
