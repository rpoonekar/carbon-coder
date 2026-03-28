import { CarbonIntensitySnapshot } from './types';
import { getBaselineCarbonIntensity } from './electricityMapsMock';

const JOULES_PER_KWH = 3_600_000;
const DEFAULT_CLOUD_COST_PER_KWH = 0.12;

export function joulesToKilowattHours(joules: number): number {
  return joules / JOULES_PER_KWH;
}

export function calculateCarbon(joules: number, region: string): number {
  const intensity = getBaselineCarbonIntensity(region);
  return calculateCarbonFromIntensity(joules, intensity);
}

export function calculateCarbonFromSnapshot(joules: number, snapshot: CarbonIntensitySnapshot): number {
  return calculateCarbonFromIntensity(joules, snapshot.carbonIntensityGPerKWh);
}

export function calculateCarbonFromIntensity(joules: number, carbonIntensityGPerKWh: number): number {
  const energyKWh = joulesToKilowattHours(joules);
  return energyKWh * carbonIntensityGPerKWh;
}

export function calculateCloudCost(joules: number, usdPerKWh = DEFAULT_CLOUD_COST_PER_KWH): number {
  return joulesToKilowattHours(joules) * usdPerKWh;
}

export function formatCarbon(grams: number): string {
  if (grams >= 1000) {
    return `${(grams / 1000).toFixed(2)} kgCO2e`;
  }

  if (grams >= 1) {
    return `${grams.toFixed(2)} gCO2e`;
  }

  return `${grams.toFixed(3)} gCO2e`;
}
