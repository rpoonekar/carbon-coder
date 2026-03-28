import * as vscode from 'vscode';

export type FindingCode =
  | 'nested-loop'
  | 'network-in-loop'
  | 'heavy-import'
  | 'polling'
  | 'payload-reduction'
  | 'demand-shift'
  | 'simple-dataframe';

export type FixKind =
  | 'hash-map'
  | 'batch-network'
  | 'lighter-import'
  | 'replace-polling'
  | 'compress-payload'
  | 'schedule-low-carbon';

export type FindingSeverity = 'low' | 'medium' | 'high';
export type FileContextType = 'production' | 'test';

export interface CarbonIntensitySnapshot {
  region: string;
  gridLabel: string;
  carbonIntensityGPerKWh: number;
  lowCarbonWindow: string;
  fetchedAt: Date;
}

export interface AnalysisContext {
  region: string;
  scaleMultiplier: number;
  snapshot: CarbonIntensitySnapshot;
  now: Date;
}

export interface EnergyFinding {
  code: FindingCode;
  fixKind: FixKind;
  title: string;
  message: string;
  explanation: string;
  severity: FindingSeverity;
  range: vscode.Range;
  estimatedJoules: number;
  estimatedEnergyKWh: number;
  estimatedCarbonGrams: number;
  estimatedCostUsd: number;
  reductionPotentialPct: number;
  metadata?: Record<string, string | number | boolean | string[]>;
}

export interface AnalysisSummary {
  findings: EnergyFinding[];
  baselineEstimatedJoules: number;
  baselineEstimatedEnergyKWh: number;
  baselineEstimatedCarbonGrams: number;
  baselineEstimatedCostUsd: number;
  totalEstimatedJoules: number;
  totalEstimatedEnergyKWh: number;
  totalEstimatedCarbonGrams: number;
  totalEstimatedCostUsd: number;
  estimatedSavingsUsd: number;
  scaleMultiplier: number;
  region: string;
  snapshot: CarbonIntensitySnapshot;
  fileContext: FileContextType;
  filePath: string;
}
