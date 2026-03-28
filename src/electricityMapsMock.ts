import { CarbonIntensitySnapshot } from './types';

interface RegionProfile {
  gridLabel: string;
  baselineCarbonIntensityGPerKWh: number;
  lowCarbonWindow: string;
}

const REGION_PROFILES: Record<string, RegionProfile> = {
  'US-CAL-CISO': {
    gridLabel: 'California ISO',
    baselineCarbonIntensityGPerKWh: 182,
    lowCarbonWindow: '11:00-15:00 local solar hours'
  },
  'US-WA': {
    gridLabel: 'Washington Hydro Grid',
    baselineCarbonIntensityGPerKWh: 58,
    lowCarbonWindow: '00:00-06:00 hydro-heavy hours'
  },
  'US-TEX-ERCO': {
    gridLabel: 'ERCOT Texas',
    baselineCarbonIntensityGPerKWh: 301,
    lowCarbonWindow: '01:00-05:00 overnight wind hours'
  },
  'EU-NORDICS': {
    gridLabel: 'Nordic Mix',
    baselineCarbonIntensityGPerKWh: 42,
    lowCarbonWindow: '00:00-06:00 off-peak hours'
  },
  DEFAULT: {
    gridLabel: 'Global Mixed Grid',
    baselineCarbonIntensityGPerKWh: 290,
    lowCarbonWindow: '02:00-05:00 local off-peak hours'
  }
};

export class MockElectricityMapsService {
  public async getCurrentCarbonIntensity(region: string, at = new Date()): Promise<CarbonIntensitySnapshot> {
    const profile = this.resolveRegion(region);
    const hour = at.getHours();

    let adjustment = 0;
    if (hour >= 11 && hour <= 15) {
      adjustment = -28;
    } else if (hour >= 0 && hour <= 5) {
      adjustment = -18;
    } else if (hour >= 17 && hour <= 20) {
      adjustment = 34;
    }

    return {
      region,
      gridLabel: profile.gridLabel,
      carbonIntensityGPerKWh: Math.max(18, profile.baselineCarbonIntensityGPerKWh + adjustment),
      lowCarbonWindow: profile.lowCarbonWindow,
      fetchedAt: at
    };
  }

  public getKnownRegions(): string[] {
    return Object.keys(REGION_PROFILES).filter((key) => key !== 'DEFAULT');
  }

  private resolveRegion(region: string): RegionProfile {
    return REGION_PROFILES[region] ?? REGION_PROFILES.DEFAULT;
  }
}

export function getBaselineCarbonIntensity(region: string): number {
  return (REGION_PROFILES[region] ?? REGION_PROFILES.DEFAULT).baselineCarbonIntensityGPerKWh;
}

export function getLowCarbonWindow(region: string): string {
  return (REGION_PROFILES[region] ?? REGION_PROFILES.DEFAULT).lowCarbonWindow;
}
