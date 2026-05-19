import { computeBoq } from "./boqCalc";

export const applyOperator = (base: number, mult: number, op: string) => {
  if (op === "%") return base * (mult / 100);
  if (op === "*") return base * mult;
  if (op === "/") return mult !== 0 ? base / mult : 0;
  return base + mult; // "+"
};

export type SrcCtx = {
  totalVal: number;
  rate: number;
  qty: number;
  overrideRate: number;
  overrideTotal: number;
  rowCalc: Record<string, number>;
  customVals: Record<string, string>;
};

export const resolveSource = (src: string, ctx: SrcCtx): number => {
  if (src === "Total Value (₹)") return ctx.totalVal;
  if (src === "Rate / Unit") return ctx.rate;
  if (src === "Qty") return ctx.qty;
  if (src === "Override Rate") return ctx.overrideRate;
  if (src === "Override Total") return ctx.overrideTotal;
  if (ctx.rowCalc[src] !== undefined) return ctx.rowCalc[src];
  return parseFloat(ctx.customVals[src] || "0") || 0;
};

export const getItemMetrics = (td: any) => {
  const step11 = Array.isArray(td.step11_items) ? td.step11_items : [];
  let itemTotal = 0, itemQty = 0;
  if (td.targetRequiredQty !== undefined && td.targetRequiredQty !== null) {
    if (td.materialLines) {
      const res = computeBoq(td.configBasis, td.materialLines, td.targetRequiredQty);
      const manualTotal = step11.filter((it: any) => it.manual).reduce((s: number, it: any) =>
        s + (Number(it.qty) || 0) * (Number(it.supply_rate || 0) + Number(it.install_rate || 0)), 0);
      itemTotal = res.grandTotal + manualTotal;
    } else {
      itemTotal = step11.reduce((s: number, it: any) =>
        s + (it.qty || 0) * ((it.supply_rate || 0) + (it.install_rate || 0)), 0);
    }
    itemQty = td.targetRequiredQty;
  } else {
    itemTotal = step11.reduce((s: number, it: any) =>
      s + (it.qty || 0) * ((it.supply_rate || 0) + (it.install_rate || 0)), 0);
    itemQty = step11[0]?.qty || 0;
  }
  let finalRate = itemQty > 0 ? itemTotal / itemQty : itemTotal;

  if (td.is_lump_sum) {
    itemQty = 1;
    finalRate = itemTotal;
  }

  if (td.use_standard_rate && td.materialLines) {
    try {
      const baseQty = Number(td.configBasis?.baseRequiredQty || 1);
      const resBase = computeBoq({ ...td.configBasis, wastagePctDefault: 0 }, td.materialLines.map((l: any) => ({ ...l, applyWastage: false })), baseQty);
      finalRate = resBase.grandTotal / baseQty;
      itemTotal = finalRate * itemQty;
    } catch { }
  } else if (td.use_fixed_rate) {
    finalRate = Number(td.fixed_rate || 0);
    itemTotal = finalRate * itemQty;
  }
  return { itemTotal, itemQty, itemRate: finalRate, step11 };
};

export const parseProductImage = (imageField: string | null | undefined): string | null => {
  if (!imageField) return null;
  try {
    if (imageField.startsWith('[')) {
      const arr = JSON.parse(imageField);
      return Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : null;
    }
    return imageField;
  } catch {
    return imageField;
  }
};
