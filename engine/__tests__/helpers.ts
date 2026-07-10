import type { EngineInput, SnapshotLine, SkuSettings, TemplateParams, VelocityWeights } from '../types.ts';

// Test template keeps the original numbers so existing fixture math stays stable:
// china_lead = 70, fba_rop = 38, po_rop = 114. fba_target/target = the order-up-to levels.
export const OCEAN: TemplateParams = {
  production_days: 30, transit_days: 30, customs_receiving_days: 10,
  fba_ship_checkin_days: 10, safety_days: 14,
  fba_target_cover_days: 38, target_cover_days: 114,
  review_period_fba_days: 14, review_period_po_days: 30,
};

export const AIR: TemplateParams = {
  production_days: 30, transit_days: 8, customs_receiving_days: 3,
  fba_ship_checkin_days: 10, safety_days: 7,
  fba_target_cover_days: 27, target_cover_days: 74,
  review_period_fba_days: 14, review_period_po_days: 30,
};
// china_lead = 41

export const WEIGHTS: VelocityWeights = { w7: 0.25, w30: 0.45, w60: 0.2, w90: 0.1 };

export const TODAY = '2026-07-09';

export function line(overrides: Partial<SnapshotLine> & { sku: string }): SnapshotLine {
  return {
    title: 'Test ring',
    available: 0, inbound_working: 0, inbound_shipped: 0, inbound_received: 0,
    reserved: 0, unfulfillable: 0,
    units_shipped_t7: 0, units_shipped_t30: 0, units_shipped_t60: 0, units_shipped_t90: 0,
    your_price: 20,
    ...overrides,
  };
}

export function settings(overrides: Partial<SkuSettings> = {}): SkuSettings {
  return { classification: 'replenishable', ...overrides };
}

export function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return {
    snapshotDate: TODAY,
    lines: [],
    skuSettings: {},
    warehouse: {},
    openPoLines: [],
    globalTemplate: OCEAN,
    globalTemplateName: 'Ocean – standard',
    airTemplate: AIR,
    weights: WEIGHTS,
    globalGrowthMultiplier: 1.0,
    orderSoonDays: 7,
    overstockFactor: 1.5,
    stockoutCorrection: true,
    stockoutDays: {},
    ...overrides,
  };
}
