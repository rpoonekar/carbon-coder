import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeDocument } from './analyzer';
import { calculateCarbonFromSnapshot, calculateCloudCost, formatCarbon, joulesToKilowattHours } from './carbon';
import { MockElectricityMapsService } from './electricityMapsMock';
import { GreenCodeActionProvider } from './greenFixes';
import { AnalysisSummary, EnergyFinding } from './types';

const SUPPORTED_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python']);
const DASHBOARD_VIEW_ID = 'carbonCoder.impactDashboard';
const GRID_CONTEXT_FACTORS = {
  development: 0.8,
  production: 1,
  'green-cloud': 0.2
} as const;

type GridContext = keyof typeof GRID_CONTEXT_FACTORS;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration('carbonCoder');
  let nodeCount = config.get<number>('scaleMultiplier', 1000);
  let carbonBudget = config.get<number>('carbonBudget', 50);
  let gridContext: GridContext = 'production';

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const service = new MockElectricityMapsService();
  const cache = new Map<string, AnalysisSummary>();
  const refreshTimers = new Map<string, NodeJS.Timeout>();
  const ghostTextDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      fontStyle: 'normal',
      fontWeight: '200',
      margin: '0 0 0 1.2rem'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });

  const getBudgetExceeded = (): boolean => buildDashboardState(cache, nodeCount, carbonBudget, gridContext).overBudget;
  const codeLensProvider = new CarbonCodeLensProvider(cache, getBudgetExceeded);
  const dashboardProvider = new ImpactDashboardProvider(
    context.extensionUri,
    () => buildDashboardState(cache, nodeCount, carbonBudget, gridContext),
    async (value) => {
      nodeCount = value;
      rescaleCache(cache, nodeCount, gridContext);
      refreshUi();
    },
    async (value) => {
      carbonBudget = value;
      refreshUi();
    },
    async (value) => {
      gridContext = value;
      rescaleCache(cache, nodeCount, gridContext);
      refreshUi();
    },
    async () => {
      await vscode.env.clipboard.writeText(buildImpactReport(buildDashboardState(cache, nodeCount, carbonBudget, gridContext)));
      void dashboardProvider.postMessage({ type: 'reportCopied' });
    }
  );

  statusBar.name = 'Carbon Coder';
  statusBar.command = 'carbonCoder.openImpactDashboard';
  statusBar.show();

  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'javascript' },
    { scheme: 'file', language: 'javascriptreact' },
    { scheme: 'file', language: 'typescript' },
    { scheme: 'file', language: 'typescriptreact' },
    { scheme: 'file', language: 'python' }
  ];

  const refreshActiveStatusBar = (): void => {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      statusBar.hide();
      return;
    }

    const summary = cache.get(activeEditor.document.uri.toString());
    if (!summary) {
      statusBar.hide();
      return;
    }

    updateStatusBar(statusBar, summary, activeEditor.document.fileName, getBudgetExceeded());
    statusBar.show();
  };

  const refreshUi = (): void => {
    codeLensProvider.refresh();
    dashboardProvider.refresh();
    applyMetadataDecorations(cache, ghostTextDecoration);
    refreshActiveStatusBar();
  };

  const refreshDocument = async (document: vscode.TextDocument): Promise<void> => {
    if (!SUPPORTED_LANGUAGES.has(document.languageId)) {
      cache.delete(document.uri.toString());
      refreshUi();
      return;
    }

    const region = vscode.workspace.getConfiguration('carbonCoder').get<string>('region', 'US-CAL-CISO');
    const snapshot = await service.getCurrentCarbonIntensity(region);

    const summary = analyzeDocument(document, {
      region,
      scaleMultiplier: nodeCount,
      snapshot,
      now: new Date()
    });

    cache.set(document.uri.toString(), summary);
    rescaleCache(cache, nodeCount, gridContext);
    refreshUi();
  };

  const scheduleRefresh = (document: vscode.TextDocument): void => {
    if (!SUPPORTED_LANGUAGES.has(document.languageId)) {
      return;
    }

    const key = document.uri.toString();
    const existingTimer = refreshTimers.get(key);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      refreshTimers.delete(key);
      void refreshDocument(document);
    }, 220);

    refreshTimers.set(key, timer);
  };

  context.subscriptions.push(
    statusBar,
    ghostTextDecoration,
    vscode.commands.registerCommand('carbonCoder.refreshAnalysis', async () => {
      const activeDocument = vscode.window.activeTextEditor?.document;
      if (activeDocument) {
        await refreshDocument(activeDocument);
      }
    }),
    vscode.commands.registerCommand('carbonCoder.openImpactDashboard', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.carbonCoder');
    }),
    vscode.commands.registerCommand('carbonCoder.showOptimizations', async (uri: vscode.Uri, line: number) => {
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      const position = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      await vscode.commands.executeCommand('editor.action.quickFix');
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      void refreshDocument(document);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      void refreshDocument(document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      scheduleRefresh(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const timer = refreshTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        refreshTimers.delete(key);
      }
      cache.delete(document.uri.toString());
      refreshUi();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor) {
        statusBar.hide();
        return;
      }

      const summary = cache.get(editor.document.uri.toString());
      if (summary) {
        refreshActiveStatusBar();
        applyMetadataDecorations(cache, ghostTextDecoration);
      }
    }),
    vscode.window.registerWebviewViewProvider(DASHBOARD_VIEW_ID, dashboardProvider),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        const config = vscode.workspace.getConfiguration('carbonCoder');
        if (!config.get<boolean>('enableEducationalHovers', true)) {
          return undefined;
        }

        const summary = cache.get(document.uri.toString());
        const finding = summary?.findings.find((candidate) => candidate.range.contains(position));
        if (!finding || !summary) {
          return undefined;
        }

        return new vscode.Hover(renderHover(summary, finding), finding.range);
      }
    }),
    vscode.languages.registerCodeLensProvider(selector, codeLensProvider),
    vscode.languages.registerCodeActionsProvider(selector, new GreenCodeActionProvider(cache), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    })
  );

  void Promise.all(vscode.workspace.textDocuments.map((document) => refreshDocument(document)));
}

export function deactivate(): void {
  // No-op.
}

class CarbonCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly cache: Map<string, AnalysisSummary>,
    private readonly getBudgetExceeded: () => boolean
  ) {}

  public refresh(): void {
    this.emitter.fire();
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const summary = this.cache.get(document.uri.toString());
    if (!summary) {
      return [];
    }

    const urgent = this.getBudgetExceeded();
    return aggregateLines(summary.findings).map((finding) => {
      const icon = urgent ? '⚠️' : '🌿';
      const title = `${icon} Carbon Impact: ~${finding.estimatedCarbonGrams.toFixed(1)}g | Click to optimize.`;
      return new vscode.CodeLens(new vscode.Range(finding.range.start.line, 0, finding.range.start.line, 0), {
        title,
        command: 'carbonCoder.showOptimizations',
        arguments: [document.uri, finding.range.start.line]
      });
    });
  }
}

class ImpactDashboardProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => DashboardState,
    private readonly onSliderChange: (value: number) => Promise<void>,
    private readonly onBudgetChange: (value: number) => Promise<void>,
    private readonly onGridContextChange: (value: GridContext) => Promise<void>,
    private readonly onCopyImpactReport: () => Promise<void>
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')]
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }

      switch (message.type) {
        case 'onSliderChange':
          if (typeof message.value === 'number') {
            await this.onSliderChange(Math.max(1, Math.min(10000, Math.round(message.value))));
          }
          break;
        case 'onBudgetChange':
          if (typeof message.value === 'number') {
            await this.onBudgetChange(Math.max(0, message.value));
          }
          break;
        case 'onGridContextChange':
          if (typeof message.value === 'string' && isGridContext(message.value)) {
            await this.onGridContextChange(message.value);
          }
          break;
        case 'copyImpactReport':
          await this.onCopyImpactReport();
          break;
        default:
          break;
      }
    });

    this.refresh();
  }

  public refresh(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = getDashboardHtml(this.view.webview, this.extensionUri, this.getState());
  }

  public async postMessage(message: unknown): Promise<void> {
    if (!this.view) {
      return;
    }

    await this.view.webview.postMessage(message);
  }
}

type DashboardState = {
  gridContext: GridContext;
  greenFactor: number;
  scaleMultiplier: number;
  carbonBudget: number;
  analyzedFiles: number;
  baselineCarbon: number;
  baselineCost: number;
  totalCarbon: number;
  optimizedCarbon: number;
  totalCost: number;
  totalSavings: number;
  hotspotCount: number;
  isZeroState: boolean;
  overBudget: boolean;
  annualizedSavingsGrams: number;
  annualizedSavingsUsd: number;
  optimizedCost: number;
  tonsEquivalent: number;
  treesEquivalent: number;
  milesEquivalent: number;
  topFindings: Array<{ file: string; title: string; carbon: number }>;
};

function aggregateLines(findings: EnergyFinding[]): EnergyFinding[] {
  const byLine = new Map<number, EnergyFinding>();

  for (const finding of findings) {
    const existing = byLine.get(finding.range.start.line);
    if (!existing || finding.estimatedCarbonGrams > existing.estimatedCarbonGrams) {
      byLine.set(finding.range.start.line, finding);
    }
  }

  return [...byLine.values()].sort((left, right) => left.range.start.line - right.range.start.line);
}

function rescaleCache(cache: Map<string, AnalysisSummary>, nodeCount: number, gridContext: GridContext): void {
  const greenFactor = GRID_CONTEXT_FACTORS[gridContext];
  for (const [key, summary] of cache.entries()) {
    const scaledBaselineJoules = summary.baselineEstimatedJoules * nodeCount;
    const baselineEstimatedEnergyKWh = joulesToKilowattHours(scaledBaselineJoules);
    const baselineEstimatedCarbonGrams = calculateCarbonFromSnapshot(summary.baselineEstimatedJoules, summary.snapshot) * nodeCount * greenFactor;
    const baselineEstimatedCostUsd = calculateCloudCost(scaledBaselineJoules);
    const scaledFindings = summary.findings.map((finding) => {
      const scaledJoules = finding.estimatedJoules * nodeCount;
      const scaledCarbon = calculateCarbonFromSnapshot(finding.estimatedJoules, summary.snapshot) * nodeCount * greenFactor;
      return {
        ...finding,
        estimatedEnergyKWh: joulesToKilowattHours(scaledJoules),
        estimatedCarbonGrams: scaledCarbon,
        estimatedCostUsd: calculateCloudCost(scaledJoules),
        message: finding.message.replace(
          /At [\d,]+ nodes, this is ~[\d.]+ gCO2e per execution\./,
          `At ${nodeCount.toLocaleString()} nodes in ${formatGridContext(gridContext)}, this is ~${scaledCarbon.toFixed(2)} gCO2e per execution.`
        )
      };
    });

    const totalEstimatedEnergyKWh = scaledFindings.reduce((total, finding) => total + finding.estimatedEnergyKWh, 0);
    const totalEstimatedCarbonGrams = scaledFindings.reduce((total, finding) => total + finding.estimatedCarbonGrams, 0);
    const totalEstimatedCostUsd = scaledFindings.reduce((total, finding) => total + finding.estimatedCostUsd, 0);
    const estimatedSavingsUsd = scaledFindings.reduce(
      (total, finding) => total + finding.estimatedCostUsd * (finding.reductionPotentialPct / 100),
      0
    );

    cache.set(key, {
      ...summary,
      baselineEstimatedEnergyKWh,
      baselineEstimatedCarbonGrams,
      baselineEstimatedCostUsd,
      findings: scaledFindings,
      scaleMultiplier: nodeCount,
      totalEstimatedEnergyKWh,
      totalEstimatedCarbonGrams,
      totalEstimatedCostUsd,
      estimatedSavingsUsd
    });
  }
}

function updateStatusBar(statusBar: vscode.StatusBarItem, summary: AnalysisSummary, fileName: string, urgent: boolean): void {
  const icon = urgent ? '$(warning)' : '$(pulse)';
  const currentPathCarbon = summary.baselineEstimatedCarbonGrams + summary.totalEstimatedCarbonGrams;
  const currentPathCost = summary.baselineEstimatedCostUsd + summary.totalEstimatedCostUsd;
  statusBar.text = `${icon} Carbon Score ${currentPathCarbon.toFixed(2)} gCO2e/run`;
  statusBar.tooltip = [
    `Carbon Coder`,
    ``,
    `File: ${path.basename(fileName)}`,
    `Context: ${summary.fileContext}`,
    `Grid: ${summary.snapshot.gridLabel} (${summary.snapshot.region})`,
    `Intensity: ${summary.snapshot.carbonIntensityGPerKWh} gCO2e/kWh`,
    `Scale modeled: ${summary.scaleMultiplier.toLocaleString()} nodes`,
    `Baseline footprint: ${summary.baselineEstimatedCarbonGrams.toFixed(2)} gCO2e/run`,
    `Estimated cloud cost: $${currentPathCost.toFixed(4)} per execution`,
    `Low-carbon window: ${summary.snapshot.lowCarbonWindow}`
  ].join('\n');
}

function renderHover(summary: AnalysisSummary, finding: EnergyFinding): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(`### ${finding.title}\n`);
  markdown.appendMarkdown(`${finding.explanation}\n\n`);
  markdown.appendMarkdown(`- Estimated impact: **${formatCarbon(finding.estimatedCarbonGrams)}** per execution\n`);
  markdown.appendMarkdown(`- Estimated energy: **${finding.estimatedEnergyKWh.toFixed(6)} kWh**\n`);
  markdown.appendMarkdown(`- Estimated cost: **$${finding.estimatedCostUsd.toFixed(4)}**\n`);
  markdown.appendMarkdown(`- Reduction potential: **${finding.reductionPotentialPct}%**\n`);
  markdown.appendMarkdown(`- Grid context: **${summary.snapshot.gridLabel}** at **${summary.snapshot.carbonIntensityGPerKWh} gCO2e/kWh**\n`);
  markdown.appendMarkdown(`- File context: **${summary.fileContext}**\n\n`);
  markdown.appendMarkdown(`Click the CodeLens above this hotspot to jump straight into optimization actions.`);
  markdown.isTrusted = false;
  return markdown;
}

function buildDashboardState(
  cache: Map<string, AnalysisSummary>,
  nodeCount: number,
  carbonBudget: number,
  gridContext: GridContext
): DashboardState {
  const greenFactor = GRID_CONTEXT_FACTORS[gridContext];
  const summaries = [...cache.values()];
  const baselineCarbon = summaries.reduce((total, summary) => total + summary.baselineEstimatedCarbonGrams, 0);
  const baselineCost = summaries.reduce((total, summary) => total + summary.baselineEstimatedCostUsd, 0);
  const hotspotCarbon = summaries.reduce((total, summary) => total + summary.totalEstimatedCarbonGrams, 0);
  const hotspotCost = summaries.reduce((total, summary) => total + summary.totalEstimatedCostUsd, 0);
  const hotspotSavings = summaries.reduce((total, summary) => total + summary.estimatedSavingsUsd, 0);
  const hotspotCount = summaries.reduce((total, summary) => total + summary.findings.length, 0);
  const isZeroState = hotspotCount === 0 && summaries.length > 0;
  const totalCarbon = baselineCarbon + hotspotCarbon;
  const totalCost = baselineCost + hotspotCost;
  const reducedHotspotCarbon = summaries.reduce(
    (total, summary) =>
      total +
      summary.findings.reduce(
        (inner, finding) => inner + finding.estimatedCarbonGrams * (finding.reductionPotentialPct / 100),
        0
      ),
    0
  );
  const optimizedCarbon = isZeroState ? totalCarbon : Math.max(baselineCarbon, totalCarbon - reducedHotspotCarbon);
  const totalSavings = isZeroState ? 0 : hotspotSavings;
  const optimizedCost = isZeroState ? totalCost : Math.max(baselineCost, totalCost - totalSavings);
  const annualizedSavingsGrams = Math.max(0, (totalCarbon - optimizedCarbon) * 8760);
  const annualizedSavingsUsd = Math.max(0, totalSavings * 8760);
  const topFindings = summaries
    .flatMap((summary) =>
      summary.findings.map((finding) => ({
        file: path.basename(summary.filePath),
        title: finding.title,
        carbon: finding.estimatedCarbonGrams
      }))
    )
    .sort((left, right) => right.carbon - left.carbon)
    .slice(0, 5);

  return {
    gridContext,
    greenFactor,
    scaleMultiplier: nodeCount,
    carbonBudget,
    analyzedFiles: summaries.length,
    baselineCarbon,
    baselineCost,
    totalCarbon,
    optimizedCarbon,
    totalCost,
    totalSavings,
    hotspotCount,
    isZeroState,
    overBudget: totalCarbon > carbonBudget,
    annualizedSavingsGrams,
    annualizedSavingsUsd,
    optimizedCost,
    tonsEquivalent: annualizedSavingsGrams / 1_000_000,
    treesEquivalent: annualizedSavingsGrams / 21_770,
    milesEquivalent: annualizedSavingsGrams / 404,
    topFindings
  };
}

function getDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri, state: DashboardState): string {
  const listItems =
    state.topFindings.length > 0
      ? state.topFindings
          .map((item) => `<li><strong>${escapeHtml(item.file)}</strong>: ${escapeHtml(item.title)} <span>${item.carbon.toFixed(2)} g</span></li>`)
          .join('')
      : state.analyzedFiles > 0
        ? '<li class="success-list-item">🌿 All clear! This file is highly optimized.</li>'
        : '<li>No analyzed hotspots yet. Open and save a supported file to populate the dashboard.</li>';
  const codiconUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
  );
  const infoContent = JSON.stringify(getInfoContentMap(state)).replace(/</g, '\\u003c');
  const budgetStatus = state.overBudget ? 'Budget exceeded' : 'Within budget';
  const budgetProgress = state.carbonBudget <= 0 ? 0 : Math.min(100, (state.totalCarbon / state.carbonBudget) * 100);
  const currentBarHeight = Math.max(16, state.totalCarbon === 0 ? 16 : 140);
  const optimizedBarHeight = Math.max(
    16,
    state.totalCarbon === 0 ? 16 : (state.optimizedCarbon / Math.max(state.totalCarbon, 1)) * 140
  );
  const savingsValue = state.isZeroState ? '$0.00' : `$${state.totalSavings.toFixed(4)}`;
  const benchmarkContent = state.isZeroState
    ? `
        <div class="success-state">
          <div class="success-badge">Maximum Efficiency Reached</div>
          <div class="subtle">No active hotspots remain in the analyzed files. Current and optimized paths are now aligned.</div>
          <div class="benchmark-chart benchmark-chart-zero">
            <div class="benchmark-column">
              <div class="benchmark-bar red" style="height:${currentBarHeight}px;"></div>
              <div class="benchmark-value">${state.totalCarbon.toFixed(1)} g</div>
              <div class="benchmark-label">Current Path</div>
            </div>
            <div class="benchmark-column">
              <div class="benchmark-bar green" style="height:${currentBarHeight}px;"></div>
              <div class="benchmark-value">${state.optimizedCarbon.toFixed(1)} g</div>
              <div class="benchmark-label">Optimized Path</div>
            </div>
          </div>
        </div>`
    : `
        <div class="benchmark-chart">
          <div class="benchmark-column">
            <div class="benchmark-bar red" style="height:${currentBarHeight}px;"></div>
            <div class="benchmark-value">${state.totalCarbon.toFixed(1)} g</div>
            <div class="benchmark-label">Current Path</div>
          </div>
          <div class="benchmark-column">
            <div class="benchmark-bar green" style="height:${optimizedBarHeight}px;"></div>
            <div class="benchmark-value">${state.optimizedCarbon.toFixed(1)} g</div>
            <div class="benchmark-label">Optimized Path</div>
          </div>
        </div>`;
  const headerStyle = state.overBudget
    ? 'background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-errorForeground) 16%, transparent), rgba(107,33,33,0.18)); border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 55%, transparent);'
    : 'background: linear-gradient(135deg, color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-charts-green)) 14%, transparent), color-mix(in srgb, var(--vscode-button-background) 12%, transparent)); border: 1px solid var(--vscode-panel-border);';

  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${codiconUri}" rel="stylesheet" />
    <style>
      body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
      .hero { padding: 16px; border-radius: 14px; ${headerStyle} transition: border-color 140ms ease-out, background 140ms ease-out; }
      .hero h2 { margin: 0 0 6px 0; font-size: 18px; }
      .grid { display: grid; grid-template-columns: 1fr; gap: 10px; margin-top: 14px; }
      .card { padding: 12px; border-radius: 12px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editorWidget-background); }
      .label { font-size: 11px; text-transform: uppercase; opacity: 0.68; letter-spacing: 0.08em; }
      .value { font-size: 24px; margin-top: 4px; font-weight: 600; }
      .subtle { opacity: 0.72; font-size: 12px; line-height: 1.45; }
      .status { margin-top: 10px; font-weight: 700; }
      .controls { display: grid; grid-template-columns: 1fr 130px; gap: 10px; align-items: end; }
      .stack { display: grid; gap: 10px; }
      .label-row { display: flex; align-items: center; gap: 6px; }
      .metric-label-row { display: inline-flex; align-items: center; gap: 6px; }
      .codicon { font-size: 14px; opacity: 0.68; }
      .info-button { cursor: pointer; }
      input[type=range] { width: 100%; margin-top: 10px; accent-color: var(--vscode-button-background); }
      ul { padding-left: 18px; margin: 0; }
      li { margin-bottom: 8px; }
      span { opacity: 0.82; }
      .success-list-item { list-style: none; margin-left: -18px; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); font-weight: 600; }
      .budget-bar { width: 100%; height: 10px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-progressBar-background) 55%, transparent); overflow: hidden; margin-top: 10px; border: 1px solid color-mix(in srgb, var(--vscode-progressBar-background) 70%, transparent); }
      .budget-fill { height: 100%; width: ${budgetProgress}%; background: ${state.overBudget ? 'var(--vscode-errorForeground)' : 'var(--vscode-testing-iconPassed, var(--vscode-button-background))'}; transition: width 120ms ease-out, background 120ms ease-out; }
      .benchmark-chart { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: end; height: 180px; margin-top: 14px; }
      .benchmark-chart-zero { margin-top: 18px; }
      .benchmark-column { display: flex; flex-direction: column; align-items: center; justify-content: end; gap: 8px; }
      .benchmark-bar { width: 56px; border-radius: 12px 12px 6px 6px; min-height: 16px; }
      .benchmark-bar.red { background: linear-gradient(180deg, color-mix(in srgb, var(--vscode-errorForeground) 88%, white), color-mix(in srgb, var(--vscode-errorForeground) 60%, black)); }
      .benchmark-bar.green { background: linear-gradient(180deg, color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 92%, white), color-mix(in srgb, var(--vscode-testing-iconPassed, #4caf50) 65%, black)); }
      .benchmark-label { font-size: 11px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.06em; }
      .benchmark-value { font-size: 13px; font-weight: 700; }
      .success-state { display: grid; gap: 8px; margin-top: 8px; }
      .success-badge { display: inline-flex; align-items: center; width: fit-content; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-charts-green)) 16%, transparent); }
      .metric-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 14px; }
      .metric { padding: 8px 0; }
      .metric .big { font-size: 22px; font-weight: 700; }
      .metric .small { font-size: 11px; opacity: 0.58; text-transform: uppercase; letter-spacing: 0.06em; }
      .hero-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; }
      .pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, transparent); font-size: 12px; }
      .copy-status { min-height: 16px; font-size: 11px; opacity: 0.68; }
      .popover { position: fixed; max-width: 280px; padding: 12px; border-radius: 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-editorHoverWidget-border)); background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); box-shadow: 0 10px 24px rgba(0,0,0,0.24); display: none; z-index: 100; }
      .popover.visible { display: block; }
      .popover-title { font-weight: 700; margin-bottom: 6px; }
      .popover-body { font-size: 12px; line-height: 1.45; opacity: 0.9; }
      .text-input, .select-input {
        width: 100%;
        box-sizing: border-box;
        min-height: 30px;
        padding: 6px 10px;
        border-radius: 6px;
        border: 1px solid var(--vscode-input-border, transparent);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        outline: none;
      }
      .text-input:focus, .select-input:focus {
        border-color: var(--vscode-focusBorder);
      }
      .action-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 30px;
        padding: 0 12px;
        border-radius: 6px;
        border: 1px solid var(--vscode-button-secondaryBorder, transparent);
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        cursor: pointer;
      }
      .action-button:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
      }
    </style>
  </head>
  <body>
    <div class="hero">
      <h2>Impact Dashboard</h2>
      <div class="subtle">Project-wide carbon and cloud-cost view for the currently analyzed workspace files.</div>
      <div class="status">${budgetStatus}</div>
      <div class="pill" style="margin-top:12px;">Grid context: ${formatGridContext(state.gridContext)} (${state.greenFactor.toFixed(2)}x carbon)</div>
      <div class="label-row" style="margin-top:12px;">
        <div class="label">Fleet Scale Multiplier</div>
        <span class="codicon codicon-info info-button" data-topic="fleet" title="Learn more"></span>
      </div>
      <div class="value">${state.scaleMultiplier.toLocaleString()} nodes</div>
      <div class="controls">
        <input id="scale" type="range" min="1" max="10000" step="1" value="${state.scaleMultiplier}" />
        <input id="scaleInput" class="text-input" type="number" min="1" max="10000" step="1" value="${state.scaleMultiplier}" />
      </div>
      <div class="label-row" style="margin-top:14px;">
        <div class="label">Grid Context</div>
        <span class="codicon codicon-info info-button" data-topic="context" title="Learn more"></span>
      </div>
      <select id="gridContext" class="select-input">
        <option value="development"${state.gridContext === 'development' ? ' selected' : ''}>Development</option>
        <option value="production"${state.gridContext === 'production' ? ' selected' : ''}>Production</option>
        <option value="green-cloud"${state.gridContext === 'green-cloud' ? ' selected' : ''}>Green Cloud</option>
      </select>
      <div class="label-row" style="margin-top:14px;">
        <div class="label">Carbon Budget</div>
        <span class="codicon codicon-info info-button" data-topic="budget" title="Learn more"></span>
      </div>
      <input id="budget" class="text-input" type="number" min="0" step="1" value="${state.carbonBudget}" />
      <div class="budget-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${state.carbonBudget}" aria-valuenow="${state.totalCarbon}">
        <div class="budget-fill"></div>
      </div>
      <div class="hero-actions">
        <button id="copyReport" class="action-button" type="button">Copy Impact Report</button>
        <div id="copyStatus" class="copy-status"></div>
      </div>
    </div>
    <div class="grid">
      <div class="card">
        <div class="label">Project-Wide Footprint</div>
        <div class="value">${state.totalCarbon.toFixed(2)} gCO2e</div>
        <div class="subtle">${state.hotspotCount} hotspot(s) across ${state.analyzedFiles} analyzed file(s) · baseline ${state.baselineCarbon.toFixed(2)} gCO2e</div>
      </div>
      <div class="card">
        <div class="label">Estimated Cloud Cost</div>
        <div class="value">$${state.totalCost.toFixed(4)}</div>
        <div class="subtle">Using a baseline of $0.12 per kWh</div>
      </div>
      <div class="card">
        <div class="label">Savings Opportunity</div>
        <div class="value">${savingsValue}</div>
        <div class="subtle">${state.isZeroState ? 'All active savings opportunities have been captured in the current file state.' : 'Approximate cost saved if suggested green refactors are adopted'}</div>
      </div>
      <div class="card">
        <div class="label-row">
          <div class="label">Savings Benchmark</div>
          <span class="codicon codicon-info info-button" data-topic="benchmark" title="Learn more"></span>
        </div>
        ${benchmarkContent}
        <div class="metric-row">
          <div class="metric">
            <div class="big">$${state.annualizedSavingsUsd.toFixed(0)}</div>
            <div class="metric-label-row">
              <div class="small">Annual Savings / Year</div>
              <span class="codicon codicon-info info-button" data-topic="annualSavings" title="Learn more"></span>
            </div>
          </div>
          <div class="metric">
            <div class="big">${state.tonsEquivalent.toFixed(2)}</div>
            <div class="metric-label-row">
              <div class="small">Tons CO2e</div>
              <span class="codicon codicon-info info-button" data-topic="tons" title="Learn more"></span>
            </div>
          </div>
          <div class="metric">
            <div class="big">${state.milesEquivalent.toFixed(0)}</div>
            <div class="metric-label-row">
              <div class="small">Miles Equivalent</div>
              <span class="codicon codicon-info info-button" data-topic="miles" title="Learn more"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="label">Top Carbon Hotspots</div>
        <ul>${listItems}</ul>
      </div>
    </div>
    <div id="popover" class="popover" role="dialog" aria-live="polite">
      <div id="popoverTitle" class="popover-title"></div>
      <div id="popoverBody" class="popover-body"></div>
    </div>
    <script>
      const vscode = acquireVsCodeApi();
      const INFO_CONTENT = ${infoContent};
      const slider = document.getElementById('scale');
      const scaleInput = document.getElementById('scaleInput');
      const budget = document.getElementById('budget');
      const gridContext = document.getElementById('gridContext');
      const copyReport = document.getElementById('copyReport');
      const copyStatus = document.getElementById('copyStatus');
      const hero = document.querySelector('.hero');
      const budgetFill = document.querySelector('.budget-fill');
      const popover = document.getElementById('popover');
      const popoverTitle = document.getElementById('popoverTitle');
      const popoverBody = document.getElementById('popoverBody');

      const debounce = (callback, delay) => {
        let timerId;
        return (value) => {
          clearTimeout(timerId);
          timerId = setTimeout(() => callback(value), delay);
        };
      };

      const clampNodes = (value) => Math.max(1, Math.min(10000, Math.round(Number(value) || 1)));
      const clampBudget = (value) => Math.max(0, Number(value) || 0);
      const debouncedSlider = debounce((value) => vscode.postMessage({ type: 'onSliderChange', value }), 200);
      const debouncedBudget = debounce((value) => vscode.postMessage({ type: 'onBudgetChange', value }), 200);

      const hidePopover = () => {
        popover.classList.remove('visible');
        popover.dataset.topic = '';
      };

      const showPopover = (button, topic) => {
        const content = INFO_CONTENT[topic];
        if (!content) {
          return;
        }

        const isSameTopic = popover.classList.contains('visible') && popover.dataset.topic === topic;
        if (isSameTopic) {
          hidePopover();
          return;
        }

        popoverTitle.textContent = content.title;
        popoverBody.textContent = content.body;
        popover.dataset.topic = topic;
        popover.classList.add('visible');

        const buttonRect = button.getBoundingClientRect();
        const popoverRect = popover.getBoundingClientRect();
        const top = Math.max(12, buttonRect.top - popoverRect.height - 12);
        const left = Math.min(
          window.innerWidth - popoverRect.width - 12,
          Math.max(12, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2)
        );

        popover.style.top = top + 'px';
        popover.style.left = left + 'px';
      };

      slider.addEventListener('input', () => {
        const value = clampNodes(slider.value);
        slider.value = String(value);
        scaleInput.value = String(value);
        debouncedSlider(value);
      });

      scaleInput.addEventListener('input', () => {
        const value = clampNodes(scaleInput.value);
        slider.value = String(value);
        scaleInput.value = String(value);
        debouncedSlider(value);
      });

      budget.addEventListener('input', () => {
        const value = clampBudget(budget.value);
        budget.value = String(value);
        updateBudgetVisuals();
        debouncedBudget(value);
      });

      gridContext.addEventListener('change', () => {
        vscode.postMessage({ type: 'onGridContextChange', value: gridContext.value });
      });

      copyReport.addEventListener('click', () => {
        copyStatus.textContent = 'Copying impact report...';
        vscode.postMessage({ type: 'copyImpactReport' });
      });

      document.querySelectorAll('.info-button').forEach((element) => {
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          showPopover(element, element.dataset.topic);
        });
      });

      document.addEventListener('click', (event) => {
        if (!popover.contains(event.target)) {
          hidePopover();
        }
      });

      window.addEventListener('resize', hidePopover);

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message?.type === 'reportCopied') {
          copyStatus.textContent = 'Impact report copied to clipboard.';
          window.setTimeout(() => {
            if (copyStatus.textContent === 'Impact report copied to clipboard.') {
              copyStatus.textContent = '';
            }
          }, 2200);
        }
      });

      function updateBudgetVisuals() {
        const current = ${state.totalCarbon};
        const budgetValue = clampBudget(budget.value);
        const progress = budgetValue === 0 ? 100 : Math.min(100, (current / budgetValue) * 100);
        const overBudget = budgetValue > 0 && current > budgetValue;

        budgetFill.style.width = progress + '%';
        budgetFill.style.background = overBudget
          ? 'var(--vscode-errorForeground)'
          : 'var(--vscode-testing-iconPassed, var(--vscode-button-background))';
        hero.style.background = overBudget
          ? 'linear-gradient(135deg, color-mix(in srgb, var(--vscode-errorForeground) 16%, transparent), rgba(107,33,33,0.18))'
          : 'linear-gradient(135deg, color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-charts-green)) 14%, transparent), color-mix(in srgb, var(--vscode-button-background) 12%, transparent))';
        hero.style.borderColor = overBudget
          ? 'color-mix(in srgb, var(--vscode-errorForeground) 55%, transparent)'
          : 'var(--vscode-panel-border)';
      }

      updateBudgetVisuals();
    </script>
  </body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isGridContext(value: string): value is GridContext {
  return value === 'development' || value === 'production' || value === 'green-cloud';
}

function formatGridContext(gridContext: GridContext): string {
  switch (gridContext) {
    case 'development':
      return 'Development';
    case 'green-cloud':
      return 'Green Cloud';
    default:
      return 'Production';
  }
}

function buildImpactReport(state: DashboardState): string {
  const carbonSavings = Math.max(0, state.totalCarbon - state.optimizedCarbon);
  const costSavings = Math.max(0, state.totalCost - state.optimizedCost);
  return [
    '## Carbon Coder Impact Report',
    '',
    `Modeled grid context: **${formatGridContext(state.gridContext)}** (${state.greenFactor.toFixed(2)}x carbon factor)`,
    `Modeled fleet scale: **${state.scaleMultiplier.toLocaleString()} nodes**`,
    '',
    '| Metric | Current | Optimized | Savings |',
    '| --- | ---: | ---: | ---: |',
    `| Compute Cost | $${state.totalCost.toFixed(2)} | $${state.optimizedCost.toFixed(2)} | **$${costSavings.toFixed(2)}** |`,
    `| Carbon (gCO2e) | ${state.totalCarbon.toFixed(1)}g | ${state.optimizedCarbon.toFixed(1)}g | **${carbonSavings.toFixed(1)}g** |`,
    `| Annual Cost | $${(state.totalCost * 8760).toFixed(0)} | $${(state.optimizedCost * 8760).toFixed(0)} | **$${state.annualizedSavingsUsd.toFixed(0)}** |`,
    `| Annual Carbon | ${(state.totalCarbon * 8760 / 1_000_000).toFixed(2)} tons | ${(state.optimizedCarbon * 8760 / 1_000_000).toFixed(2)} tons | **${(state.annualizedSavingsGrams / 1_000_000).toFixed(2)} tons** |`,
    `| Miles Equivalent | - | - | **${state.milesEquivalent.toFixed(0)} miles avoided** |`,
    '',
    '_Generated by Carbon Coder for before-vs-after green refactoring review._'
  ].join('\n');
}

function getInfoContentMap(state: DashboardState): Record<string, { title: string; body: string }> {
  return {
    budget: {
      title: 'Carbon Budget',
      body: 'Set a target ceiling for the current project view. When the modeled footprint crosses it, Carbon Coder raises the urgency of the dashboard and hotspot lenses.'
    },
    fleet: {
      title: 'Fleet Scale Multiplier',
      body: 'This turns a local inefficiency into fleet math. Sliding from one machine to thousands shows how a small per-run waste becomes a real cloud-carbon bill.'
    },
    context: {
      title: 'Grid Context',
      body: 'Grid context applies a carbon factor to the same workload. Development uses 0.80x, Production uses 1.00x, and Green Cloud uses 0.20x carbon intensity.'
    },
    benchmark: {
      title: 'Savings Benchmark',
      body: 'The red bar is the current path. The green bar estimates the same execution after applying the detected sustainable refactors and their reduction potential.'
    },
    annualSavings: {
      title: 'Annual Savings',
      body: 'Annual savings multiplies the per-execution cost delta by 8,760 modeled operating hours so teams can talk about infrastructure efficiency in budget language.'
    },
    tons: {
      title: 'Tons CO2e',
      body: 'This converts annualized grams of avoided carbon into metric tons so the impact reads clearly at fleet scale.'
    },
    miles: {
      title: 'Miles Equivalent',
      body: 'Miles equivalent converts avoided CO2e into an intuitive driving comparison using roughly 404 grams of CO2e per mile.'
    }
  };
}

function applyMetadataDecorations(
  cache: Map<string, AnalysisSummary>,
  decorationType: vscode.TextEditorDecorationType
): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const summary = cache.get(editor.document.uri.toString());
    if (!summary) {
      editor.setDecorations(decorationType, []);
      continue;
    }

    const decorations = aggregateLines(summary.findings).map((finding) => {
      const line = editor.document.lineAt(finding.range.start.line);
      return {
        range: new vscode.Range(
          finding.range.start.line,
          line.range.end.character,
          finding.range.start.line,
          line.range.end.character
        ),
        renderOptions: {
          after: {
            contentText: `  ⚡ ${Math.round(finding.estimatedEnergyKWh * 3_600_000)} Joules | 🌍 ${finding.estimatedCarbonGrams.toFixed(1)}g CO2e`
          }
        },
        hoverMessage: renderHover(summary, finding)
      };
    });

    editor.setDecorations(decorationType, decorations);
  }
}

function legacyApplyGhostTextDecorations(
  cache: Map<string, AnalysisSummary>,
  decorationType: vscode.TextEditorDecorationType
): void {
  for (const editor of vscode.window.visibleTextEditors) {
    const summary = cache.get(editor.document.uri.toString());
    if (!summary) {
      editor.setDecorations(decorationType, []);
      continue;
    }

    const decorations = aggregateLines(summary.findings).map((finding) => ({
      range: new vscode.Range(finding.range.start.line, editor.document.lineAt(finding.range.start.line).range.end.character, finding.range.start.line, editor.document.lineAt(finding.range.start.line).range.end.character),
      renderOptions: {
        after: {
          contentText: `  ⚡ ${Math.round(finding.estimatedJoules)} Joules | 🌍 ${finding.estimatedCarbonGrams.toFixed(1)}g CO2e`
        }
      },
      hoverMessage: renderHover(summary, finding)
    }));

    editor.setDecorations(decorationType, decorations);
  }
}

function legacyBuildInfoContent(topic: string): { title: string; body: string } {
  switch (topic) {
    case 'budget':
      return {
        title: 'Carbon Budget',
        body: 'A project budget is the maximum gCO2e target for the current analysis view. Exceeding it makes Carbon Coder escalate the visual urgency so teams can trim hotspots earlier.'
      };
    case 'fleet':
      return {
        title: 'Fleet Scale Multiplier',
        body: 'This scales the per-execution impact from a local run to a fleet. It helps translate tiny inefficiencies into cloud-scale operational carbon.'
      };
    case 'benchmark':
      return {
        title: 'Savings Benchmark',
        body: 'Current Path reflects the modeled hotspot cost today. Optimized Path estimates the post-refactor carbon after applying the reduction potential of the detected green fixes.'
      };
    default:
      return {
        title: 'Metric Info',
        body: 'Carbon Coder converts estimated energy use into carbon and cloud cost so you can compare the current path with a cleaner alternative.'
      };
  }
}
