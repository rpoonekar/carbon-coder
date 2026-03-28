import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as espree from 'espree';
import { calculateCarbonFromSnapshot, calculateCloudCost, joulesToKilowattHours } from './carbon';
import { AnalysisContext, AnalysisSummary, EnergyFinding } from './types';

const HEAVY_IMPORTS: Record<
  string,
  { message: string; lighterAlternative?: string; baseJoules: number; reductionPotentialPct: number }
> = {
  lodash: {
    message: 'Pulling in all of lodash increases startup work and bundle transfer size.',
    lighterAlternative: 'lodash-es',
    baseJoules: 12,
    reductionPotentialPct: 18
  },
  moment: {
    message: 'Moment bundles a large date surface area when lighter date libraries or native APIs may be enough.',
    baseJoules: 14,
    reductionPotentialPct: 20
  },
  'aws-sdk': {
    message: 'The monolithic AWS SDK increases cold starts compared with modular v3 clients.',
    baseJoules: 18,
    reductionPotentialPct: 24
  },
  tensorflow: {
    message: 'Heavy ML imports amplify cold-start and memory pressure when loaded eagerly.',
    baseJoules: 28,
    reductionPotentialPct: 28
  },
  pandas: {
    message: 'Large data libraries in request paths can inflate CPU and memory costs.',
    baseJoules: 18,
    reductionPotentialPct: 20
  },
  numpy: {
    message: 'NumPy can add cold-start and memory overhead when native Python built-ins are enough.',
    baseJoules: 16,
    reductionPotentialPct: 24
  }
};

const NETWORK_CALL_PATTERN = /(fetch|axios\.(get|post|put|patch|delete)|requests\.(get|post|put|patch|delete)|httpClient\.(get|post|put|patch)|db\.(insert|save|update)|client\.query|session\.(get|post))/i;
const HEAVY_TASK_PATTERN = /(train|retrain|migrate|backfill|reindex|syncAll|fineTune|embedding|vectorize)/i;

type EstreeNode = {
  type: string;
  loc?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  range?: [number, number];
  [key: string]: unknown;
};

type LoopMetadata = {
  primaryItem?: string;
  primaryCollection?: string;
  secondaryItem?: string;
  secondaryCollection?: string;
};

export function analyzeDocument(document: vscode.TextDocument, context: AnalysisContext): AnalysisSummary {
  const findings: EnergyFinding[] = [];
  const dedupe = new Set<string>();
  const fileContext = detectFileContext(document.fileName);

  if (isJavaScriptFamily(document.languageId)) {
    analyzeJavaScriptLike(document, context, findings, dedupe);
  } else if (document.languageId === 'python') {
    analyzePythonLike(document, context, findings, dedupe);
  }

  const totalEstimatedJoules = findings.reduce((total, finding) => total + finding.estimatedJoules, 0);
  const totalEstimatedEnergyKWh = findings.reduce((total, finding) => total + finding.estimatedEnergyKWh, 0);
  const totalEstimatedCarbonGrams = findings.reduce((total, finding) => total + finding.estimatedCarbonGrams, 0);
  const totalEstimatedCostUsd = findings.reduce((total, finding) => total + finding.estimatedCostUsd, 0);
  const estimatedSavingsUsd = findings.reduce(
    (total, finding) => total + finding.estimatedCostUsd * (finding.reductionPotentialPct / 100),
    0
  );
  const baselineEstimatedJoules = estimateBaselineJoules(document);
  const scaledBaselineJoules = baselineEstimatedJoules * context.scaleMultiplier;
  const baselineEstimatedEnergyKWh = joulesToKilowattHours(scaledBaselineJoules);
  const baselineEstimatedCarbonGrams = calculateCarbonFromSnapshot(baselineEstimatedJoules, context.snapshot) * context.scaleMultiplier;
  const baselineEstimatedCostUsd = calculateCloudCost(scaledBaselineJoules);

  return {
    findings: findings.sort((left, right) => right.estimatedCarbonGrams - left.estimatedCarbonGrams),
    baselineEstimatedJoules,
    baselineEstimatedEnergyKWh,
    baselineEstimatedCarbonGrams,
    baselineEstimatedCostUsd,
    totalEstimatedJoules,
    totalEstimatedEnergyKWh,
    totalEstimatedCarbonGrams,
    totalEstimatedCostUsd,
    estimatedSavingsUsd,
    scaleMultiplier: context.scaleMultiplier,
    region: context.region,
    snapshot: context.snapshot,
    fileContext,
    filePath: document.fileName
  };
}

function estimateBaselineJoules(document: vscode.TextDocument): number {
  const lines = document.getText().split(/\r?\n/);
  let activeLines = 0;
  let importLines = 0;
  let loopLines = 0;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    activeLines += 1;
    if (/^(import|from)\b/.test(trimmed) || /^const\s+\w+\s*=\s*require\(/.test(trimmed)) {
      importLines += 1;
    }
    if (/^(for|while)\b/.test(trimmed)) {
      loopLines += 1;
    }
  }

  return Math.max(6, activeLines * 0.45 + importLines * 1.25 + loopLines * 0.9);
}

function analyzeJavaScriptLike(
  document: vscode.TextDocument,
  context: AnalysisContext,
  findings: EnergyFinding[],
  dedupe: Set<string>
): void {
  const text = document.getText();

  if (document.languageId === 'javascript' || document.languageId === 'javascriptreact') {
    try {
      const ast = espree.parse(text, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        loc: true,
        range: true,
        ecmaFeatures: {
          jsx: document.languageId === 'javascriptreact'
        }
      }) as unknown as EstreeNode;

      walkEstree(ast, [], (node, ancestors) => {
        const loopDepth = ancestors.filter(isEstreeLoop).length;

        if (isEstreeLoop(node)) {
          const hasAncestorLoop = ancestors.some(isEstreeLoop);
          const nestedDepth = getEstreeNestedLoopDepth(node);
          const loopMetadata = extractNestedEstreeLoopMetadata(node);
          const scopeVariables = extractEstreeScopeVariables(ancestors);
          if (nestedDepth >= 2 && !hasAncestorLoop) {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'nested-loop',
                fixKind: 'hash-map',
                title: nestedDepth >= 3 ? 'Triple nested loop hotspot' : 'Nested loop hotspot',
                severity: nestedDepth >= 3 ? 'high' : 'medium',
                estimatedJoules: estimateNestedLoopJoules(nestedDepth),
                reductionPotentialPct: nestedDepth >= 3 ? 52 : 40,
                explanation: `This loop stack trends toward O(n^${nestedDepth}) work and scales poorly across fleets.`,
                message: `Loop depth ${nestedDepth} drives repeated CPU work that compounds on cloud fleets.`,
                range: estreeRangeToVsCodeRange(document, node),
                metadata: {
                  loopDepth: nestedDepth,
                  ...loopMetadata,
                  scopeVariables
                }
              })
            );
          }

          const zombiePolling = isInfiniteEstreeLoop(node) && estreeLoopHasNetwork(node) && !estreeLoopHasDelay(node);
          if (isInfiniteEstreeLoop(node) && !estreeLoopHasDelay(node)) {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'polling',
                fixKind: 'replace-polling',
                title: zombiePolling ? 'Zombie polling loop detected' : 'Polling keeps compute awake',
                severity: 'high',
                estimatedJoules: 90,
                reductionPotentialPct: 55,
                explanation: zombiePolling
                  ? 'This infinite loop performs remote I/O without any delay, keeping compute and sockets awake continuously.'
                  : 'Infinite or aggressive loops keep CPU time active and prevent workloads from idling cleanly.',
                message: zombiePolling
                  ? 'Add bounded backoff or event-driven wakeups instead of hammering the network in a tight loop.'
                  : 'Replace busy polling with events, backoff, or queue-driven scheduling.',
                range: estreeRangeToVsCodeRange(document, node),
                metadata: {
                  pollingKind: zombiePolling ? 'zombie' : 'busy-loop',
                  diagnosticCode: zombiePolling ? 'carbon-zombie-polling' : 'carbon-polling'
                }
              })
            );
          }
        }

        if (node.type === 'ImportDeclaration') {
          const source = readEstreeImportSource(node);
          const importMeta = HEAVY_IMPORTS[source];
          if (importMeta) {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'heavy-import',
                fixKind: 'lighter-import',
                title: `Heavy import: ${source}`,
                severity: importMeta.baseJoules >= 20 ? 'medium' : 'low',
                estimatedJoules: importMeta.baseJoules,
                reductionPotentialPct: importMeta.reductionPotentialPct,
                explanation: importMeta.message,
                message: `Import only what is needed from ${source} to reduce cold-start energy and transfer size.`,
                range: estreeRangeToVsCodeRange(document, node),
                metadata: {
                  importSource: source,
                  lighterAlternative: importMeta.lighterAlternative ?? ''
                }
              })
            );
          }
        }

        if (node.type === 'VariableDeclarator' && isEstreeNode(node.init) && node.init.type === 'CallExpression') {
          const calleeName = getEstreeCalleeName(node.init.callee);
          if (calleeName === 'require' && Array.isArray(node.init.arguments) && isEstreeNode(node.init.arguments[0])) {
            const importSource = getLiteralString(node.init.arguments[0]);
            const importMeta = HEAVY_IMPORTS[importSource];
            if (importMeta) {
              addFinding(
                findings,
                dedupe,
                buildFinding(document, context, {
                  code: 'heavy-import',
                  fixKind: 'lighter-import',
                  title: `Heavy import: ${importSource}`,
                  severity: importMeta.baseJoules >= 20 ? 'medium' : 'low',
                  estimatedJoules: importMeta.baseJoules,
                  reductionPotentialPct: importMeta.reductionPotentialPct,
                  explanation: importMeta.message,
                  message: `Re-evaluate full-package require("${importSource}") on hot paths.`,
                  range: estreeRangeToVsCodeRange(document, node),
                  metadata: {
                    importSource,
                    lighterAlternative: importMeta.lighterAlternative ?? ''
                  }
                })
              );
            }
          }
        }

        if (node.type === 'CallExpression') {
          const calleeName = getEstreeCalleeName(node.callee);
          const loopMetadata = extractEstreeLoopMetadata(node, ancestors);
          const scopeVariables = extractEstreeScopeVariables(ancestors);

          if (calleeName === 'setInterval') {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'polling',
                fixKind: 'replace-polling',
                title: 'Interval-based polling detected',
                severity: 'medium',
                estimatedJoules: 74,
                reductionPotentialPct: 48,
                explanation: 'Short polling intervals keep services and network radios awake, especially on mobile and serverless workloads.',
                message: 'Move to event-driven updates, exponential backoff, or a low-carbon queue trigger.',
                range: estreeRangeToVsCodeRange(document, node)
              })
            );
          }

          if (NETWORK_CALL_PATTERN.test(calleeName) && loopDepth > 0 && !hasZombieEstreeLoop(ancestors)) {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'network-in-loop',
                fixKind: 'batch-network',
                title: 'Network I/O inside loop',
                severity: loopDepth >= 2 ? 'high' : 'medium',
                estimatedJoules: 52 * (loopDepth + 1),
                reductionPotentialPct: 36,
                explanation: 'Repeated requests amplify serialization, radio wakeups, TLS overhead, and backend fanout.',
                message: 'Batch or pipeline requests instead of issuing one remote call per iteration.',
                range: estreeRangeToVsCodeRange(document, node),
                metadata: {
                  loopDepth,
                  calleeName,
                  ...loopMetadata,
                  scopeVariables
                }
              })
            );
          }

          if (NETWORK_CALL_PATTERN.test(calleeName) && hasUncompressedPayload(node)) {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'payload-reduction',
                fixKind: 'compress-payload',
                title: 'Payload reduction opportunity',
                severity: 'low',
                estimatedJoules: 18,
                reductionPotentialPct: 22,
                explanation: 'Compressed or lower-precision payloads reduce network transfer energy and backend processing time.',
                message: 'Consider gzip, schema pruning, or lower precision for data sent over the wire.',
                range: estreeRangeToVsCodeRange(document, node)
              })
            );
          }

          if (HEAVY_TASK_PATTERN.test(calleeName) && isTopLevelEstreeCall(ancestors)) {
            addFinding(
              findings,
              dedupe,
              buildFinding(document, context, {
                code: 'demand-shift',
                fixKind: 'schedule-low-carbon',
                title: 'Demand-shifting candidate',
                severity: 'medium',
                estimatedJoules: 120,
                reductionPotentialPct: 60,
                explanation: `Heavy jobs should move into ${context.snapshot.lowCarbonWindow} when the grid is cleaner.`,
                message: 'Schedule this task instead of running it immediately on startup or deploy.',
                range: estreeRangeToVsCodeRange(document, node)
              })
            );
          }
        }
      });

      return;
    } catch {
      // Fall through to TypeScript AST for JS files if espree rejects syntax.
    }
  }

  analyzeWithTypeScriptAst(document, context, findings, dedupe);
}

function analyzeWithTypeScriptAst(
  document: vscode.TextDocument,
  context: AnalysisContext,
  findings: EnergyFinding[],
  dedupe: Set<string>
): void {
  const text = document.getText();
  const scriptKind = getScriptKind(document.languageId);
  const sourceFile = ts.createSourceFile(document.fileName, text, ts.ScriptTarget.Latest, true, scriptKind);

  const visit = (node: ts.Node, loopDepth: number): void => {
    const currentLoopDepth = isTsLoop(node) ? loopDepth + 1 : loopDepth;
    const loopMetadata = extractTsLoopMetadata(node);
    const scopeVariables = extractTsScopeVariables(node);

    if (isTsLoop(node)) {
      const nestedDepth = getTsNestedLoopDepth(node);
      const hasParentLoop = !!findTsParentLoop(node.parent);
      if (nestedDepth >= 2 && !hasParentLoop) {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'nested-loop',
            fixKind: 'hash-map',
            title: nestedDepth >= 3 ? 'Triple nested loop hotspot' : 'Nested loop hotspot',
            severity: nestedDepth >= 3 ? 'high' : 'medium',
            estimatedJoules: estimateNestedLoopJoules(nestedDepth),
            reductionPotentialPct: nestedDepth >= 3 ? 52 : 40,
            explanation: `This loop stack trends toward O(n^${nestedDepth}) work and scales poorly across fleets.`,
            message: `Loop depth ${nestedDepth} drives repeated CPU work that compounds at scale.`,
            range: tsRangeToVsCodeRange(document, sourceFile, node),
            metadata: {
              loopDepth: nestedDepth,
              ...extractNestedTsLoopMetadata(node),
              scopeVariables
            }
          })
        );
      }

      const zombiePolling = isInfiniteTsLoop(node) && tsLoopHasNetwork(node) && !tsLoopHasDelay(node);
      if (isInfiniteTsLoop(node) && !tsLoopHasDelay(node)) {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'polling',
            fixKind: 'replace-polling',
            title: zombiePolling ? 'Zombie polling loop detected' : 'Polling keeps compute awake',
            severity: 'high',
            estimatedJoules: 90,
            reductionPotentialPct: 55,
            explanation: zombiePolling
              ? 'This infinite loop performs remote I/O without any delay, keeping compute and sockets awake continuously.'
              : 'Infinite or aggressive loops keep CPU time active and prevent workloads from idling cleanly.',
            message: zombiePolling
              ? 'Add bounded backoff or event-driven wakeups instead of hammering the network in a tight loop.'
              : 'Replace busy polling with events, backoff, or queue-driven scheduling.',
            range: tsRangeToVsCodeRange(document, sourceFile, node),
            metadata: {
              pollingKind: zombiePolling ? 'zombie' : 'busy-loop',
              diagnosticCode: zombiePolling ? 'carbon-zombie-polling' : 'carbon-polling'
            }
          })
        );
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const source = node.moduleSpecifier.text;
      const importMeta = HEAVY_IMPORTS[source];
      if (importMeta) {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'heavy-import',
            fixKind: 'lighter-import',
            title: `Heavy import: ${source}`,
            severity: importMeta.baseJoules >= 20 ? 'medium' : 'low',
            estimatedJoules: importMeta.baseJoules,
            reductionPotentialPct: importMeta.reductionPotentialPct,
            explanation: importMeta.message,
            message: `Import only what is needed from ${source} to reduce cold-start energy and transfer size.`,
            range: tsRangeToVsCodeRange(document, sourceFile, node),
            metadata: {
              importSource: source,
              lighterAlternative: importMeta.lighterAlternative ?? ''
            }
          })
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const calleeName = getTsCalleeName(node.expression);

      if (calleeName === 'setInterval') {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'polling',
            fixKind: 'replace-polling',
            title: 'Interval-based polling detected',
            severity: 'medium',
            estimatedJoules: 74,
            reductionPotentialPct: 48,
            explanation: 'Short polling intervals keep services and network radios awake, especially on mobile and serverless workloads.',
            message: 'Move to event-driven updates, exponential backoff, or a low-carbon queue trigger.',
            range: tsRangeToVsCodeRange(document, sourceFile, node)
          })
        );
      }

      if (NETWORK_CALL_PATTERN.test(calleeName) && loopDepth > 0 && !hasZombieTsLoop(node)) {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'network-in-loop',
            fixKind: 'batch-network',
            title: 'Network I/O inside loop',
            severity: loopDepth >= 2 ? 'high' : 'medium',
            estimatedJoules: 52 * (loopDepth + 1),
            reductionPotentialPct: 36,
            explanation: 'Repeated requests amplify serialization, radio wakeups, TLS overhead, and backend fanout.',
            message: 'Batch or pipeline requests instead of issuing one remote call per iteration.',
            range: tsRangeToVsCodeRange(document, sourceFile, node),
            metadata: {
              loopDepth,
              calleeName,
              ...loopMetadata,
              scopeVariables
            }
          })
        );
      }

      if (NETWORK_CALL_PATTERN.test(calleeName) && hasUncompressedPayloadTs(node)) {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'payload-reduction',
            fixKind: 'compress-payload',
            title: 'Payload reduction opportunity',
            severity: 'low',
            estimatedJoules: 18,
            reductionPotentialPct: 22,
            explanation: 'Compressed or lower-precision payloads reduce network transfer energy and backend processing time.',
            message: 'Consider gzip, schema pruning, or lower precision for data sent over the wire.',
            range: tsRangeToVsCodeRange(document, sourceFile, node)
          })
        );
      }

      if (HEAVY_TASK_PATTERN.test(calleeName) && isTopLevelTsCall(node)) {
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'demand-shift',
            fixKind: 'schedule-low-carbon',
            title: 'Demand-shifting candidate',
            severity: 'medium',
            estimatedJoules: 120,
            reductionPotentialPct: 60,
            explanation: `Heavy jobs should move into ${context.snapshot.lowCarbonWindow} when the grid is cleaner.`,
            message: 'Schedule this task instead of running it immediately on startup or deploy.',
            range: tsRangeToVsCodeRange(document, sourceFile, node)
          })
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, currentLoopDepth));
  };

  visit(sourceFile, 0);
}

function analyzePythonLike(
  document: vscode.TextDocument,
  context: AnalysisContext,
  findings: EnergyFinding[],
  dedupe: Set<string>
): void {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const loopStack: Array<{ indent: number; line: number; item?: string; collection?: string; isInfinite: boolean }> = [];
  const simplePandasOpportunity =
    /\bpd\.(DataFrame|Series|read_csv)\(/.test(text) &&
    !/\bpd\.(merge|groupby|pivot_table|rolling|resample)\(/.test(text);
  const numpyAlias = detectPythonNumpyAlias(lines);
  const simpleNumpyMaxOpportunity = numpyAlias ? isSafeNativeNumpyMaxUsage(text, numpyAlias) : false;

  lines.forEach((lineText, lineIndex) => {
    const trimmed = lineText.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const indent = lineText.length - lineText.trimStart().length;
    while (loopStack.length > 0 && indent <= loopStack[loopStack.length - 1].indent) {
      loopStack.pop();
    }

    if (/^(import|from)\s+(tensorflow|pandas|numpy)\b/.test(trimmed)) {
      const importSource = trimmed.replace(/^(import|from)\s+/, '').split(/\s+/)[0];
      const importMeta = HEAVY_IMPORTS[importSource];
      if (importMeta) {
        const isSimpleNumpyNative = importSource === 'numpy' && simpleNumpyMaxOpportunity;
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code:
              importSource === 'pandas' && simplePandasOpportunity
                ? 'simple-dataframe'
                : 'heavy-import',
            fixKind: 'lighter-import',
            title:
              importSource === 'pandas' && simplePandasOpportunity
                ? 'Simple pandas task detected'
                : isSimpleNumpyNative
                  ? 'Native max() can replace numpy import'
                  : `Heavy import: ${importSource}`,
            severity: importMeta.baseJoules >= 20 ? 'medium' : 'low',
            estimatedJoules: importMeta.baseJoules,
            reductionPotentialPct: importMeta.reductionPotentialPct,
            explanation:
              importSource === 'pandas' && simplePandasOpportunity
                ? 'This looks like a simple tabular task where polars may offer lower memory pressure and faster execution.'
                : isSimpleNumpyNative
                  ? 'This file only appears to use numpy for max(), which native Python can handle without the extra import and startup cost.'
                : importMeta.message,
            message:
              importSource === 'pandas' && simplePandasOpportunity
                ? 'Consider polars for simple DataFrame work to reduce memory and execution overhead.'
                : isSimpleNumpyNative
                  ? 'Remove numpy here and use the native max() built-in instead.'
                : `Avoid eager ${importSource} imports on hot paths or CLI startup.`,
            range: lineRange(document, lineIndex),
            metadata: {
              importSource,
              importAlias: isSimpleNumpyNative ? numpyAlias ?? '' : '',
              lighterAlternative: importSource === 'pandas' && simplePandasOpportunity ? 'polars' : '',
              safeNativeReplacement: isSimpleNumpyNative,
              replacementTarget: isSimpleNumpyNative ? 'native-max' : ''
            }
          })
        );
      }
    }

    if (/^(for|while)\b/.test(trimmed)) {
      const currentDepth = loopStack.length + 1;
      const currentLoop = parsePythonLoopSignature(trimmed);
      const isInfiniteLoop = /^while\s+(True|1)\b/.test(trimmed);
      const currentLoopRange = pythonBlockRange(document, lines, lineIndex);
      const currentLoopText = document.getText(currentLoopRange);
      const alreadyOptimizedLoop = containsPythonOptimizationMarkers(currentLoopText);
      const insideChunkHelper = isInsidePythonChunkHelper(lines, lineIndex);
      if (currentDepth >= 2) {
        const rootLoopLine = loopStack[0]?.line ?? lineIndex;
        const nestedDepth = getPythonNestedLoopDepth(lines, rootLoopLine);
        const rootLoop = parsePythonLoopSignature(lines[rootLoopLine].trim());
        const nestedLoop = findFirstNestedPythonLoop(lines, rootLoopLine);
        const scopeVariables = collectPythonScopeVariables(lines, rootLoopLine);
        const rootLoopRange = pythonBlockRange(document, lines, rootLoopLine);
        const rootLoopText = document.getText(rootLoopRange);
        if (!containsPythonOptimizationMarkers(rootLoopText)) {
          addFinding(
            findings,
            dedupe,
            buildFinding(document, context, {
              code: 'nested-loop',
              fixKind: 'hash-map',
              title: nestedDepth >= 3 ? 'Triple nested loop hotspot' : 'Nested loop hotspot',
              severity: nestedDepth >= 3 ? 'high' : 'medium',
              estimatedJoules: estimateNestedLoopJoules(nestedDepth),
              reductionPotentialPct: nestedDepth >= 3 ? 52 : 40,
              explanation: `This loop stack trends toward O(n^${nestedDepth}) work and scales poorly across fleets.`,
              message: `Loop depth ${nestedDepth} drives repeated CPU work that compounds on cloud fleets.`,
              range: rootLoopRange,
              metadata: {
                loopDepth: nestedDepth,
                ...(rootLoop?.item ? { primaryItem: rootLoop.item } : {}),
                ...(rootLoop?.collection ? { primaryCollection: rootLoop.collection } : {}),
                ...(nestedLoop?.item ? { secondaryItem: nestedLoop.item } : {}),
                ...(nestedLoop?.collection ? { secondaryCollection: nestedLoop.collection } : {}),
                scopeVariables
              }
            })
          );
        }
      }

      if (isInfiniteLoop && !insideChunkHelper && !pythonLoopHasDelay(lines, lineIndex) && !alreadyOptimizedLoop) {
        const zombiePolling = pythonLoopHasNetwork(lines, lineIndex);
        addFinding(
          findings,
          dedupe,
          buildFinding(document, context, {
            code: 'polling',
            fixKind: 'replace-polling',
            title: zombiePolling ? 'Zombie polling loop detected' : 'Polling keeps compute awake',
            severity: 'high',
            estimatedJoules: 90,
            reductionPotentialPct: 55,
            explanation: zombiePolling
              ? 'This infinite loop performs remote I/O without any delay, keeping CPUs, sockets, and radios awake continuously.'
              : 'Infinite loops and health polling keep CPUs warm and radio/network usage elevated.',
            message: zombiePolling
              ? 'Add bounded backoff or event-driven wakeups instead of hammering the network in a tight loop.'
              : 'Replace constant polling with events, backoff, or queue-based triggers.',
            range: lineRange(document, lineIndex),
            metadata: {
              pollingKind: zombiePolling ? 'zombie' : 'busy-loop',
              diagnosticCode: zombiePolling ? 'carbon-zombie-polling' : 'carbon-polling'
            }
          })
        );
      }

      loopStack.push({
        indent,
        line: lineIndex,
        item: currentLoop?.item,
        collection: currentLoop?.collection,
        isInfinite: isInfiniteLoop
      });
    }

    if (NETWORK_CALL_PATTERN.test(trimmed) && loopStack.length > 0) {
      const zombieLoop = [...loopStack]
        .reverse()
        .find((loop) => loop.isInfinite && !pythonLoopHasDelay(lines, loop.line) && pythonLoopHasNetwork(lines, loop.line));

      if (zombieLoop) {
        return;
      }

      const activeLoop = loopStack[loopStack.length - 1];
      const scopeVariables = collectPythonScopeVariables(lines, lineIndex);
      const outermostLoopLine = loopStack[0]?.line ?? lineIndex;
      const outermostLoopRange = pythonBlockRange(document, lines, outermostLoopLine);
      const outermostLoopText = document.getText(outermostLoopRange);
      if (containsPythonOptimizationMarkers(outermostLoopText)) {
        return;
      }
      addFinding(
        findings,
        dedupe,
        buildFinding(document, context, {
          code: 'network-in-loop',
          fixKind: 'batch-network',
          title: 'Network I/O inside loop',
          severity: loopStack.length >= 2 ? 'high' : 'medium',
          estimatedJoules: 52 * (loopStack.length + 1),
          reductionPotentialPct: 36,
          explanation: 'Repeated remote calls amplify serialization, TLS handshakes, and backend energy use.',
          message: 'Batch requests or send a vectorized payload instead of one call per item.',
          range: outermostLoopRange,
          metadata: {
            loopDepth: loopStack.length,
            callText: trimmed,
            callType: trimmed.includes('requests.post') ? 'requests.post' : 'network-call',
            ...(activeLoop?.item ? { primaryItem: activeLoop.item } : {}),
            ...(activeLoop?.collection ? { primaryCollection: activeLoop.collection } : {}),
            scopeVariables
          }
        })
      );
    }

    if (/requests\.(post|put|patch)\(/.test(trimmed) && /(json=|data=)/.test(trimmed) && !/gzip|compress|Content-Encoding/.test(trimmed)) {
      addFinding(
        findings,
        dedupe,
        buildFinding(document, context, {
          code: 'payload-reduction',
          fixKind: 'compress-payload',
          title: 'Payload reduction opportunity',
          severity: 'low',
          estimatedJoules: 18,
          reductionPotentialPct: 22,
          explanation: 'Compressed payloads reduce transfer energy and backend deserialization time.',
          message: 'Add compression headers or lower precision before sending large payloads.',
          range: lineRange(document, lineIndex)
        })
      );
    }

    if (/^\s*(train|retrain|migrate|backfill|reindex)\w*\(/.test(trimmed) && indent === 0) {
      const functionName = parseInvokedFunctionName(trimmed);
      const functionDefLine = functionName ? findPythonFunctionDefinitionLine(lines, functionName) : undefined;
      addFinding(
        findings,
        dedupe,
        buildFinding(document, context, {
          code: 'demand-shift',
          fixKind: 'schedule-low-carbon',
          title: 'Demand-shifting candidate',
          severity: 'medium',
          estimatedJoules: 120,
          reductionPotentialPct: 60,
          explanation: `Heavy jobs should move into ${context.snapshot.lowCarbonWindow} when the grid is cleaner.`,
          message: 'Schedule this heavy task in low-carbon hours instead of launching it immediately.',
          range: lineRange(document, lineIndex),
          metadata: {
            functionName: functionName ?? '',
            functionDefLine: functionDefLine ?? -1
          }
        })
      );
    }
  });
}

function buildFinding(
  document: vscode.TextDocument,
  context: AnalysisContext,
  finding: Omit<EnergyFinding, 'estimatedCarbonGrams' | 'estimatedEnergyKWh' | 'estimatedCostUsd'>
): EnergyFinding {
  const scaledJoules = finding.estimatedJoules * context.scaleMultiplier;
  const estimatedCarbonGrams = calculateCarbonFromSnapshot(finding.estimatedJoules, context.snapshot) * context.scaleMultiplier;
  const estimatedEnergyKWh = joulesToKilowattHours(scaledJoules);
  const estimatedCostUsd = calculateCloudCost(scaledJoules);
  const isTestFile = detectFileContext(document.fileName) === 'test';
  const severity = isTestFile ? downgradeSeverity(finding.severity) : finding.severity;
  const contextPrefix = isTestFile ? 'Test context: deprioritized. ' : '';

  return {
    ...finding,
    severity,
    estimatedEnergyKWh,
    estimatedCarbonGrams,
    estimatedCostUsd,
    message: `${contextPrefix}${finding.message} At ${context.scaleMultiplier.toLocaleString()} nodes, this is ~${estimatedCarbonGrams.toFixed(2)} gCO2e per execution.`
  };
}

function addFinding(findings: EnergyFinding[], dedupe: Set<string>, finding: EnergyFinding): void {
  const key = `${finding.code}:${finding.range.start.line}:${finding.range.start.character}`;
  if (dedupe.has(key)) {
    return;
  }

  dedupe.add(key);
  findings.push(finding);
}

function estimateNestedLoopJoules(depth: number): number {
  return 18 * depth * depth;
}

function detectFileContext(filePath: string): 'production' | 'test' {
  return /(^|[\\/])(__tests__|tests?|spec)([\\/]|$)|\.(test|spec)\./i.test(filePath) ? 'test' : 'production';
}

function downgradeSeverity(severity: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  switch (severity) {
    case 'high':
      return 'medium';
    case 'medium':
      return 'low';
    default:
      return 'low';
  }
}

function isJavaScriptFamily(languageId: string): boolean {
  return ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'].includes(languageId);
}

function getScriptKind(languageId: string): ts.ScriptKind {
  switch (languageId) {
    case 'javascript':
      return ts.ScriptKind.JS;
    case 'javascriptreact':
      return ts.ScriptKind.JSX;
    case 'typescriptreact':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function isTsLoop(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function isInfiniteTsLoop(node: ts.Node): boolean {
  if (ts.isWhileStatement(node) && node.expression.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }

  return ts.isForStatement(node) && !node.condition;
}

function getTsCalleeName(node: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(node)) {
    return node.text;
  }

  if (ts.isPropertyAccessExpression(node)) {
    return `${getTsCalleeName(node.expression as ts.LeftHandSideExpression)}.${node.name.text}`;
  }

  return node.getText();
}

function hasUncompressedPayloadTs(node: ts.CallExpression): boolean {
  return node.arguments.some((argument) => {
    if (ts.isObjectLiteralExpression(argument)) {
      const hasBody = argument.properties.some((property) => {
        return ts.isPropertyAssignment(property) && ['body', 'data', 'json'].includes(property.name.getText().replace(/['"]/g, ''));
      });
      const hasCompressionHeader = argument.getText().includes('Content-Encoding') || argument.getText().includes('gzip');
      return hasBody && !hasCompressionHeader;
    }

    return false;
  });
}

function isTopLevelTsCall(node: ts.CallExpression): boolean {
  const parent = node.parent;
  return !!parent && ts.isExpressionStatement(parent) && parent.parent && ts.isSourceFile(parent.parent);
}

function tsRangeToVsCodeRange(document: vscode.TextDocument, sourceFile: ts.SourceFile, node: ts.Node): vscode.Range {
  const start = document.positionAt(node.getStart(sourceFile));
  const end = document.positionAt(node.getEnd());
  return new vscode.Range(start, end);
}

function walkEstree(
  node: EstreeNode,
  ancestors: EstreeNode[],
  visitor: (node: EstreeNode, ancestors: EstreeNode[]) => void
): void {
  visitor(node, ancestors);

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isEstreeNode(entry)) {
          walkEstree(entry, [...ancestors, node], visitor);
        }
      }
    } else if (isEstreeNode(value)) {
      walkEstree(value, [...ancestors, node], visitor);
    }
  }
}

function isEstreeNode(value: unknown): value is EstreeNode {
  return !!value && typeof value === 'object' && 'type' in value;
}

function isEstreeLoop(node: EstreeNode): boolean {
  return ['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type);
}

function isInfiniteEstreeLoop(node: EstreeNode): boolean {
  if (node.type === 'ForStatement') {
    return !('test' in node) || !node.test;
  }

  if (node.type === 'WhileStatement') {
    return isEstreeNode(node.test) && node.test.type === 'Literal' && getLiteralString(node.test) === 'true';
  }

  return false;
}

function getEstreeCalleeName(node: unknown): string {
  if (!node || typeof node !== 'object' || !('type' in node)) {
    return '';
  }

  const typedNode = node as EstreeNode;
  if (typedNode.type === 'Identifier') {
    return String((typedNode as { name?: string }).name ?? '');
  }

  if (typedNode.type === 'MemberExpression') {
    const objectName = getEstreeCalleeName((typedNode as { object?: unknown }).object);
    const propertyName = getEstreeCalleeName((typedNode as { property?: unknown }).property);
    return objectName && propertyName ? `${objectName}.${propertyName}` : objectName || propertyName;
  }

  if (typedNode.type === 'Literal') {
    return getLiteralString(typedNode);
  }

  return '';
}

function getLiteralString(node: EstreeNode): string {
  return String((node as { value?: unknown }).value ?? '');
}

function readEstreeImportSource(node: EstreeNode): string {
  return isEstreeNode(node.source) ? getLiteralString(node.source) : '';
}

function hasUncompressedPayload(node: EstreeNode): boolean {
  const args = Array.isArray(node.arguments) ? node.arguments : [];
  return args.some((argument) => {
    if (!isEstreeNode(argument) || argument.type !== 'ObjectExpression') {
      return false;
    }

    const properties = Array.isArray(argument.properties) ? argument.properties : [];
    const hasBody = properties.some((property) => {
      if (!isEstreeNode(property) || property.type !== 'Property') {
        return false;
      }

      return isEstreeNode(property.key) && ['body', 'data', 'json'].includes(getEstreeCalleeName(property.key));
    });

    const serializedArgument = JSON.stringify(argument);
    const hasCompressionHeader = serializedArgument.includes('Content-Encoding') || serializedArgument.includes('gzip');
    return hasBody && !hasCompressionHeader;
  });
}

function isTopLevelEstreeCall(ancestors: EstreeNode[]): boolean {
  return (
    ancestors.some((ancestor) => ancestor.type === 'Program') &&
    ancestors.every(
      (ancestor) =>
        !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition'].includes(ancestor.type)
    )
  );
}

function estreeRangeToVsCodeRange(document: vscode.TextDocument, node: EstreeNode): vscode.Range {
  if (node.range) {
    return new vscode.Range(document.positionAt(node.range[0]), document.positionAt(node.range[1]));
  }

  if (node.loc) {
    return new vscode.Range(
      new vscode.Position(node.loc.start.line - 1, node.loc.start.column),
      new vscode.Position(node.loc.end.line - 1, node.loc.end.column)
    );
  }

  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
}

function lineRange(document: vscode.TextDocument, line: number): vscode.Range {
  const lineText = document.lineAt(line);
  return new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lineText.text.length));
}

function pythonBlockRange(document: vscode.TextDocument, lines: string[], startLine: number): vscode.Range {
  const startText = lines[startLine] ?? '';
  const startIndent = startText.length - startText.trimStart().length;
  let endLine = startLine;

  for (let index = startLine + 1; index < lines.length; index += 1) {
    const lineText = lines[index];
    const trimmed = lineText.trim();
    if (!trimmed) {
      endLine = index;
      continue;
    }

    const indent = lineText.length - lineText.trimStart().length;
    if (indent <= startIndent) {
      break;
    }

    endLine = index;
  }

  const endCharacter = document.lineAt(endLine).text.length;
  return new vscode.Range(new vscode.Position(startLine, 0), new vscode.Position(endLine, endCharacter));
}

function getPythonNestedLoopDepth(lines: string[], startLine: number): number {
  const { endLine } = pythonBlockLineBounds(lines, startLine);
  const rootIndent = getLineIndent(lines[startLine] ?? '');
  const loopIndents = [rootIndent];
  let maxDepth = 1;

  for (let index = startLine + 1; index <= endLine; index += 1) {
    const trimmed = lines[index]?.trim() ?? '';
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const indent = getLineIndent(lines[index] ?? '');
    while (loopIndents.length > 1 && indent <= loopIndents[loopIndents.length - 1]) {
      loopIndents.pop();
    }

    if (/^(for|while)\b/.test(trimmed)) {
      loopIndents.push(indent);
      maxDepth = Math.max(maxDepth, loopIndents.length);
    }
  }

  return maxDepth;
}

function findFirstNestedPythonLoop(
  lines: string[],
  startLine: number
): { item?: string; collection?: string } | undefined {
  const { endLine } = pythonBlockLineBounds(lines, startLine);
  const rootIndent = getLineIndent(lines[startLine] ?? '');

  for (let index = startLine + 1; index <= endLine; index += 1) {
    const trimmed = lines[index]?.trim() ?? '';
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (/^(for|while)\b/.test(trimmed) && getLineIndent(lines[index] ?? '') > rootIndent) {
      return parsePythonLoopSignature(trimmed);
    }
  }

  return undefined;
}

function pythonLoopHasDelay(lines: string[], startLine: number): boolean {
  const { endLine } = pythonBlockLineBounds(lines, startLine);
  for (let index = startLine + 1; index <= endLine; index += 1) {
    const trimmed = lines[index]?.trim() ?? '';
    if (/(time\.sleep|sleep\(|asyncio\.sleep|await\s+.*sleep|delay\()/i.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function pythonLoopHasNetwork(lines: string[], startLine: number): boolean {
  const { endLine } = pythonBlockLineBounds(lines, startLine);
  for (let index = startLine + 1; index <= endLine; index += 1) {
    if (NETWORK_CALL_PATTERN.test(lines[index] ?? '')) {
      return true;
    }
  }

  return false;
}

function pythonBlockLineBounds(lines: string[], startLine: number): { startLine: number; endLine: number } {
  const startText = lines[startLine] ?? '';
  const startIndent = getLineIndent(startText);
  let endLine = startLine;

  for (let index = startLine + 1; index < lines.length; index += 1) {
    const lineText = lines[index] ?? '';
    const trimmed = lineText.trim();
    if (!trimmed) {
      endLine = index;
      continue;
    }

    const indent = getLineIndent(lineText);
    if (indent <= startIndent) {
      break;
    }

    endLine = index;
  }

  return { startLine, endLine };
}

function getLineIndent(lineText: string): number {
  return lineText.length - lineText.trimStart().length;
}

function containsPythonOptimizationMarkers(blockText: string): boolean {
  return /\b(chunked_iterable|aiohttp|payload_batch)\b/.test(blockText);
}

function isInsidePythonChunkHelper(lines: string[], lineIndex: number): boolean {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (/^def\s+chunked_iterable\s*\(/.test(trimmed)) {
      return true;
    }

    if (/^(async\s+def|def|class)\b/.test(trimmed)) {
      return false;
    }
  }

  return false;
}

function parseInvokedFunctionName(lineText: string): string | undefined {
  const match = lineText.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\(/);
  return match?.[1];
}

function findPythonFunctionDefinitionLine(lines: string[], functionName: string): number | undefined {
  const pattern = new RegExp(`^\\s*def\\s+${functionName}\\s*\\(`);
  const lineIndex = lines.findIndex((line) => pattern.test(line));
  return lineIndex >= 0 ? lineIndex : undefined;
}

function detectPythonNumpyAlias(lines: string[]): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim();
    const importMatch = trimmed.match(/^import\s+numpy(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?/);
    if (importMatch) {
      return importMatch[1] ?? 'numpy';
    }
  }

  return undefined;
}

function isSafeNativeNumpyMaxUsage(text: string, alias: string): boolean {
  const hasMaxUsage = new RegExp(`\\b${alias}\\.max\\s*\\(`).test(text);
  const otherUsage = new RegExp(`\\b${alias}\\.(?!max\\s*\\()[a-zA-Z_][a-zA-Z0-9_]*`).test(text);
  return hasMaxUsage && !otherUsage;
}

function parsePythonLoopSignature(lineText: string): { item?: string; collection?: string } | undefined {
  const match = lineText.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+(.+):$/);
  if (!match) {
    return undefined;
  }

  return {
    item: match[1],
    collection: sanitizeCollectionExpression(match[2])
  };
}

function getTsNestedLoopDepth(node: ts.Node): number {
  let maxDepth = 1;
  const visit = (current: ts.Node, depth: number): void => {
    ts.forEachChild(current, (child) => {
      if (isTsLoop(child)) {
        const nextDepth = depth + 1;
        maxDepth = Math.max(maxDepth, nextDepth);
        visit(child, nextDepth);
        return;
      }

      visit(child, depth);
    });
  };

  visit(node, 1);
  return maxDepth;
}

function findFirstNestedTsLoop(node: ts.Node): ts.Node | undefined {
  let match: ts.Node | undefined;
  const visit = (current: ts.Node): void => {
    if (match) {
      return;
    }

    ts.forEachChild(current, (child) => {
      if (match) {
        return;
      }

      if (isTsLoop(child)) {
        match = child;
        return;
      }

      visit(child);
    });
  };

  visit(node);
  return match;
}

function tsLoopHasNetwork(node: ts.Node): boolean {
  let hasNetwork = false;
  const visit = (current: ts.Node): void => {
    if (hasNetwork) {
      return;
    }

    if (ts.isCallExpression(current) && NETWORK_CALL_PATTERN.test(getTsCalleeName(current.expression))) {
      hasNetwork = true;
      return;
    }

    ts.forEachChild(current, visit);
  };

  visit(node);
  return hasNetwork;
}

function tsLoopHasDelay(node: ts.Node): boolean {
  let hasDelay = false;
  const visit = (current: ts.Node): void => {
    if (hasDelay) {
      return;
    }

    if (ts.isCallExpression(current) && /(sleep|delay|setTimeout|wait)/i.test(getTsCalleeName(current.expression))) {
      hasDelay = true;
      return;
    }

    ts.forEachChild(current, visit);
  };

  visit(node);
  return hasDelay;
}

function hasZombieTsLoop(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (isTsLoop(current) && isInfiniteTsLoop(current) && tsLoopHasNetwork(current) && !tsLoopHasDelay(current)) {
      return true;
    }

    current = current.parent;
  }

  return false;
}

function extractTsLoopMetadata(node: ts.Node): LoopMetadata {
  if (!isTsLoop(node)) {
    return {};
  }

  const parentLoop = findTsParentLoop(node.parent);
  const current = getTsLoopInfo(node);
  const outer = parentLoop ? getTsLoopInfo(parentLoop) : undefined;

  return {
    primaryItem: outer?.item,
    primaryCollection: outer?.collection,
    secondaryItem: current?.item,
    secondaryCollection: current?.collection
  };
}

function extractNestedTsLoopMetadata(node: ts.Node): LoopMetadata {
  const current = getTsLoopInfo(node);
  const nested = findFirstNestedTsLoop(node);
  const secondary = nested ? getTsLoopInfo(nested) : undefined;

  return {
    primaryItem: current?.item,
    primaryCollection: current?.collection,
    secondaryItem: secondary?.item,
    secondaryCollection: secondary?.collection
  };
}

function findTsParentLoop(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current) {
    if (isTsLoop(current)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function getTsLoopInfo(node: ts.Node): { item?: string; collection?: string } | undefined {
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    const item = extractTsBindingName(node.initializer);
    const collection = sanitizeCollectionExpression(node.expression.getText());
    return { item, collection };
  }

  return undefined;
}

function extractTsBindingName(node: ts.ForInitializer | ts.Expression): string | undefined {
  if (ts.isVariableDeclarationList(node)) {
    const declaration = node.declarations[0];
    return declaration ? declaration.name.getText() : undefined;
  }

  return ts.isIdentifier(node) ? node.text : undefined;
}

function extractEstreeLoopMetadata(node: EstreeNode, ancestors: EstreeNode[]): LoopMetadata {
  const currentLoop = isEstreeLoop(node) ? node : [...ancestors].reverse().find(isEstreeLoop);
  const outerLoop = [...ancestors].reverse().find((ancestor) => isEstreeLoop(ancestor));
  const current = currentLoop ? getEstreeLoopInfo(currentLoop) : undefined;
  const outer = outerLoop ? getEstreeLoopInfo(outerLoop) : undefined;

  return {
    primaryItem: outer?.item,
    primaryCollection: outer?.collection,
    secondaryItem: current?.item,
    secondaryCollection: current?.collection
  };
}

function getEstreeNestedLoopDepth(node: EstreeNode): number {
  let maxDepth = 1;
  walkEstree(node, [], (current, ancestors) => {
    if (current === node || !isEstreeLoop(current)) {
      return;
    }

    const depth = ancestors.filter(isEstreeLoop).length + 1;
    maxDepth = Math.max(maxDepth, depth);
  });

  return maxDepth;
}

function findFirstNestedEstreeLoop(node: EstreeNode): EstreeNode | undefined {
  let match: EstreeNode | undefined;
  walkEstree(node, [], (current) => {
    if (!match && current !== node && isEstreeLoop(current)) {
      match = current;
    }
  });
  return match;
}

function extractNestedEstreeLoopMetadata(node: EstreeNode): LoopMetadata {
  const primary = getEstreeLoopInfo(node);
  const nested = findFirstNestedEstreeLoop(node);
  const secondary = nested ? getEstreeLoopInfo(nested) : undefined;

  return {
    primaryItem: primary?.item,
    primaryCollection: primary?.collection,
    secondaryItem: secondary?.item,
    secondaryCollection: secondary?.collection
  };
}

function estreeLoopHasNetwork(node: EstreeNode): boolean {
  let hasNetwork = false;
  walkEstree(node, [], (current) => {
    if (hasNetwork) {
      return;
    }

    if (current.type === 'CallExpression' && NETWORK_CALL_PATTERN.test(getEstreeCalleeName(current.callee))) {
      hasNetwork = true;
    }
  });

  return hasNetwork;
}

function estreeLoopHasDelay(node: EstreeNode): boolean {
  let hasDelay = false;
  walkEstree(node, [], (current) => {
    if (hasDelay) {
      return;
    }

    if (current.type === 'CallExpression' && /(sleep|delay|setTimeout|wait)/i.test(getEstreeCalleeName(current.callee))) {
      hasDelay = true;
    }
  });

  return hasDelay;
}

function hasZombieEstreeLoop(ancestors: EstreeNode[]): boolean {
  return [...ancestors].reverse().some(
    (ancestor) => isEstreeLoop(ancestor) && isInfiniteEstreeLoop(ancestor) && estreeLoopHasNetwork(ancestor) && !estreeLoopHasDelay(ancestor)
  );
}

function getEstreeLoopInfo(node: EstreeNode): { item?: string; collection?: string } | undefined {
  if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
    const left = isEstreeNode(node.left) ? node.left : undefined;
    const right = isEstreeNode(node.right) ? node.right : undefined;
    return {
      item: getEstreeLoopBindingName(left),
      collection: right ? sanitizeCollectionExpression(getEstreeCalleeName(right) || JSON.stringify(right)) : undefined
    };
  }

  return undefined;
}

function getEstreeLoopBindingName(node: EstreeNode | undefined): string | undefined {
  if (!node) {
    return undefined;
  }

  if (node.type === 'Identifier') {
    return String((node as { name?: string }).name ?? '');
  }

  if (node.type === 'VariableDeclaration') {
    const declarations = Array.isArray(node.declarations) ? node.declarations : [];
    const first = declarations[0];
    if (isEstreeNode(first) && isEstreeNode(first.id)) {
      return getEstreeLoopBindingName(first.id);
    }
  }

  return undefined;
}

function sanitizeCollectionExpression(value: string): string {
  const identifierMatch = value.match(/[a-zA-Z_][a-zA-Z0-9_]*/);
  return identifierMatch?.[0] ?? (value.replace(/[:\s]/g, '') || 'your_data_variable');
}

function extractTsScopeVariables(node: ts.Node): string[] {
  const scopeChain = findTsScopeChain(node);
  if (scopeChain.length === 0) {
    return [];
  }

  const variables = new Set<string>();
  for (const scopeRoot of scopeChain) {
    const visit = (current: ts.Node): void => {
      if (ts.isVariableDeclaration(current)) {
        collectBindingNames(current.name).forEach((name) => variables.add(name));
      } else if (ts.isParameter(current)) {
        collectBindingNames(current.name).forEach((name) => variables.add(name));
      } else if (ts.isFunctionDeclaration(current) && current.name) {
        variables.add(current.name.text);
      } else if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
        variables.add(current.name.text);
      }

      if (current !== scopeRoot && isNestedTsScope(current)) {
        return;
      }

      ts.forEachChild(current, visit);
    };

    visit(scopeRoot);
  }

  return [...variables];
}

function findTsScopeChain(node: ts.Node | undefined): ts.Node[] {
  const chain: ts.Node[] = [];
  let current = findNearestTsScopeBoundary(node);

  while (current && chain.length < 2) {
    chain.push(current);
    current = findNearestTsScopeBoundary(current.parent);
  }

  return chain;
}

function findNearestTsScopeBoundary(node: ts.Node | undefined): ts.Node | undefined {
  let current = node;
  while (current) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) {
      return current;
    }

    current = current.parent;
  }

  return undefined;
}

function isNestedTsScope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassLike(node);
}

function collectBindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }

  const names: string[] = [];
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      names.push(...collectBindingNames(element.name));
    }
  }

  return names;
}

function extractEstreeScopeVariables(ancestors: EstreeNode[]): string[] {
  const scopeChain = findEstreeScopeChain(ancestors);
  if (scopeChain.length === 0) {
    return [];
  }

  const variables = new Set<string>();
  for (const scopeRoot of scopeChain) {
    walkEstree(scopeRoot, [], (node, localAncestors) => {
      if (node !== scopeRoot && isNestedEstreeScope(node)) {
        return;
      }

      if (node.type === 'VariableDeclarator' && isEstreeNode(node.id)) {
        collectEstreeBindingNames(node.id).forEach((name) => variables.add(name));
      } else if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
        if (typeof (node as { id?: { name?: string } }).id?.name === 'string') {
          variables.add((node as { id?: { name?: string } }).id!.name!);
        }
        const params = Array.isArray(node.params) ? node.params : [];
        params.filter(isEstreeNode).flatMap((param) => collectEstreeBindingNames(param)).forEach((name) => variables.add(name));
      } else if (node.type === 'MethodDefinition' && isEstreeNode(node.key) && node.key.type === 'Identifier') {
        variables.add(String((node.key as { name?: string }).name ?? ''));
      }

      if (localAncestors.length > 0 && localAncestors[localAncestors.length - 1] !== scopeRoot && isNestedEstreeScope(node)) {
        return;
      }
    });
  }

  return [...variables];
}

function findEstreeScopeChain(ancestors: EstreeNode[]): EstreeNode[] {
  const boundaries = [...ancestors]
    .reverse()
    .filter((ancestor) =>
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'MethodDefinition', 'ClassDeclaration'].includes(ancestor.type)
    );

  return boundaries.slice(0, 2);
}

function isNestedEstreeScope(node: EstreeNode): boolean {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'MethodDefinition'].includes(node.type);
}

function collectEstreeBindingNames(node: EstreeNode): string[] {
  if (node.type === 'Identifier') {
    return [String((node as { name?: string }).name ?? '')];
  }

  if (node.type === 'ObjectPattern' && Array.isArray(node.properties)) {
    return node.properties.filter(isEstreeNode).flatMap((property) => {
      if (property.type === 'Property' && isEstreeNode(property.value)) {
        return collectEstreeBindingNames(property.value);
      }
      return [];
    });
  }

  if (node.type === 'ArrayPattern' && Array.isArray(node.elements)) {
    return node.elements.filter(isEstreeNode).flatMap((element) => collectEstreeBindingNames(element));
  }

  return [];
}

function collectPythonScopeVariables(lines: string[], lineIndex: number): string[] {
  const scopeRanges = findPythonScopeRanges(lines, lineIndex);
  const variables = new Set<string>();

  for (const scope of scopeRanges) {
    for (let index = scope.start; index <= Math.min(scope.end, lineIndex); index += 1) {
      const trimmed = lines[index].trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const assignment = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
      if (assignment) {
        variables.add(assignment[1]);
      }

      const forMatch = trimmed.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)/);
      if (forMatch) {
        variables.add(forMatch[1]);
        variables.add(forMatch[2]);
      }
    }
  }

  return [...variables];
}

function findPythonScopeRanges(lines: string[], lineIndex: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let currentLine = lineIndex;

  while (currentLine >= 0 && ranges.length < 2) {
    const boundary = findPythonScopeBoundary(lines, currentLine);
    if (!boundary) {
      break;
    }

    ranges.push(boundary);
    currentLine = boundary.start - 1;
  }

  return ranges;
}

function findPythonScopeBoundary(lines: string[], lineIndex: number): { start: number; end: number } | undefined {
  for (let index = lineIndex; index >= 0; index -= 1) {
    const trimmed = lines[index].trim();
    if (!/^(async\s+def|def|class)\b/.test(trimmed)) {
      continue;
    }

    const indent = getLineIndent(lines[index]);
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      const candidateTrimmed = candidate.trim();
      if (!candidateTrimmed) {
        end = cursor;
        continue;
      }

      if (getLineIndent(candidate) <= indent) {
        break;
      }

      end = cursor;
    }

    return { start: index, end };
  }

  return undefined;
}
