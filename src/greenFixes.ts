import * as vscode from 'vscode';
import { AnalysisSummary, EnergyFinding } from './types';

export class GreenCodeActionProvider implements vscode.CodeActionProvider {
  constructor(private readonly cache: Map<string, AnalysisSummary>) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const summary = this.cache.get(document.uri.toString());
    if (!summary) {
      return [];
    }

    const requestedCodes = new Set(context.diagnostics.map((diagnostic) => getRequestedDiagnosticCode(diagnostic)).filter(Boolean));
    const actions: vscode.CodeAction[] = [];

    if (context.diagnostics.some((diagnostic) => getRequestedDiagnosticCode(diagnostic) === 'carbon-zombie-polling')) {
      for (const diagnostic of context.diagnostics) {
        const code = getRequestedDiagnosticCode(diagnostic);
        const message = diagnostic.message.toLowerCase();
        if (code === 'carbon-zombie-polling' || message.includes('polling') || message.includes('backoff')) {
          const zombieAction = createPythonPollingSleepAction(document, diagnostic.range);
          if (zombieAction) {
            zombieAction.diagnostics = [diagnostic];
            actions.push(zombieAction);
          }
        }
      }
    }

    const findings = collapseOverlappingFindings(
      summary.findings.filter((finding) => {
        const selectionLine = range.start.line;
        const lineMatch = selectionLine >= finding.range.start.line && selectionLine <= finding.range.end.line;
        if (!lineMatch) {
          return false;
        }

        if (requestedCodes.size === 0) {
          return true;
        }

        return requestedCodes.has(getDiagnosticCode(finding));
      })
    );

    actions.push(...findings.flatMap((finding) => buildQuickFixes(document, finding, summary)));
    return dedupeActions(actions);
  }
}

export function buildQuickFixes(
  document: vscode.TextDocument,
  finding: EnergyFinding,
  summary: AnalysisSummary
): vscode.CodeAction[] {
  const actions: vscode.CodeAction[] = [];
  const indent = document.lineAt(finding.range.start.line).text.match(/^\s*/)?.[0] ?? '';
  const comment = getCommentPrefix(document.languageId);
  const lowCarbonWindow = summary.snapshot.lowCarbonWindow;
  const scopeVariables = readScopeVariables(finding.metadata?.scopeVariables);
  const primaryCollection = readVariableName(finding.metadata?.primaryCollection, document.languageId, scopeVariables);
  const secondaryCollection = readVariableName(finding.metadata?.secondaryCollection, document.languageId, scopeVariables);
  const primaryItem = readVariableName(finding.metadata?.primaryItem, document.languageId, scopeVariables);
  const secondaryItem = readVariableName(finding.metadata?.secondaryItem, document.languageId, scopeVariables);

  switch (finding.code) {
    case 'nested-loop':
      if (document.languageId === 'python') {
        const preservedBatching = buildPythonChunkedBatchReplacement(document, finding.range, scopeVariables);
        if (preservedBatching) {
          actions.push(
            createReplaceRangeAction(
              'Green Refactor: Wrap preserved body in chunked batches',
              document,
              finding.range,
              preservedBatching
            )
          );
        } else {
          actions.push(createPythonBatchingExampleComment(document, finding.range.start.line, scopeVariables));
        }
      } else {
        actions.push(
          createReplaceRangeAction(
            'Green Refactor: Replace with map()/reduce() sketch',
            document,
            finding.range,
            [
              `${indent}const ${secondaryCollection}Lookup = new Map(${secondaryCollection}.map((${secondaryItem}) => [${secondaryItem}.id ?? ${secondaryItem}, ${secondaryItem}]));`,
              `${indent}const optimizedResults = ${primaryCollection}.map((${primaryItem}) => ({`,
              `${indent}  ${primaryItem},`,
              `${indent}  match: ${secondaryCollection}Lookup.get(${primaryItem}.id ?? ${primaryItem})`,
              `${indent}}));`
            ].join('\n')
          )
        );
      }

      actions.push(
        createInsertTemplateAction(
          'Green Refactor: Add lookup-based comparison note',
          document,
          finding.range.start,
          [
            `${indent}${comment} Carbon Coder: Build a lookup once, then replace the inner scan with O(1) access.`,
            `${indent}${comment} JS example: const lookup = new Map(${secondaryCollection}.map(${secondaryItem} => [${secondaryItem}.id, ${secondaryItem}]));`,
            `${indent}${comment} Python example: lookup = {${secondaryItem}: ${secondaryItem} for ${secondaryItem} in ${secondaryCollection}}`
          ].join('\n') + '\n'
        )
      );
      break;
    case 'network-in-loop':
      if (document.languageId === 'python' && String(finding.metadata?.callType ?? '') === 'requests.post') {
        const batchedReplacement = buildPythonChunkedBatchReplacement(document, finding.range, scopeVariables);
        if (batchedReplacement) {
          actions.push(
            createReplaceRangeAction(
              'Green Refactor: Wrap in chunked batches',
              document,
              finding.range,
              batchedReplacement
            )
          );
        } else {
          actions.push(createPythonBatchingExampleComment(document, finding.range.start.line, scopeVariables));
        }
        const asyncioReplacement = buildPythonAsyncioReplacement(document, finding.range, scopeVariables);
        if (asyncioReplacement) {
          actions.push(
            createReplaceRangeAction(
              'Green Refactor: Replace with asyncio + aiohttp',
              document,
              finding.range,
              asyncioReplacement
            )
          );
        }
      } else if (document.languageId.startsWith('javascript') || document.languageId.startsWith('typescript')) {
        actions.push(
          createReplaceRangeAction(
            'Green Refactor: Replace with Promise batch sketch',
            document,
            finding.range,
            `${indent}pendingRequests.push(fetch(buildUrl(${primaryItem}), requestOptions));`
          )
        );
      }
      break;
    case 'demand-shift':
      actions.push(
        createInsertTemplateAction(
          'Green Refactor: Annotate low-carbon scheduling window',
          document,
          finding.range.start,
          `${indent}${comment} Carbon Coder: Schedule this job during ${lowCarbonWindow} for a cleaner grid mix.\n`
        )
      );

      if (document.languageId === 'python') {
        const decoratorAction = createCarbonSchedulerAction(document, finding);
        if (decoratorAction) {
          actions.push(decoratorAction);
        }
      }
      break;
    case 'heavy-import':
    case 'simple-dataframe': {
      const importSource = String(finding.metadata?.importSource ?? '');
      const lighterAlternative = String(finding.metadata?.lighterAlternative ?? '');
      const replacementTarget = String(finding.metadata?.replacementTarget ?? '');
      const safeNativeReplacement = finding.metadata?.safeNativeReplacement === true;

      if (document.languageId === 'python' && importSource === 'numpy' && replacementTarget === 'native-max' && safeNativeReplacement) {
        const nativeMaxAction = createNativePythonMaxAction(document, finding);
        if (nativeMaxAction) {
          actions.push(nativeMaxAction);
        }
      }

      if (importSource && lighterAlternative) {
        const currentLine = document.lineAt(finding.range.start.line).text;
        const replacement = currentLine.replace(importSource, lighterAlternative);
        if (replacement !== currentLine) {
          actions.push(
            createReplaceLineAction(
              `Green Refactor: Swap ${importSource} for ${lighterAlternative}`,
              document,
              finding.range.start.line,
              replacement
            )
          );
        }
      }

      if (finding.code === 'simple-dataframe') {
        actions.push(
          createInsertTemplateAction(
            'Green Refactor: Suggest polars for simple tabular work',
            document,
            finding.range.start,
            `${indent}${comment} Carbon Coder: polars can be a lower-memory fit for simple DataFrame creation and scans.\n`
          )
        );
      }
      break;
    }
    case 'payload-reduction':
      actions.push(
        createInsertTemplateAction(
          'Green Refactor: Add payload compression note',
          document,
          finding.range.start,
          [
            `${indent}${comment} Carbon Coder: Compress outbound payloads and trim fields before sending.`,
            `${indent}${comment} Example header: Content-Encoding: gzip`
          ].join('\n') + '\n'
        )
      );
      break;
    case 'polling':
      if (document.languageId === 'python') {
        const pollingAction = createPythonPollingSleepAction(document, finding.range);
        if (pollingAction) {
          actions.push(pollingAction);
        }
      } else {
        actions.push(
          createInsertTemplateAction(
            'Green Refactor: Replace polling with backoff or events',
            document,
            finding.range.start,
            [
              `${indent}${comment} Carbon Coder: Replace tight polling with events, queues, webhooks, or exponential backoff.`,
              `${indent}${comment} Low-carbon window for batch work in ${summary.snapshot.gridLabel}: ${lowCarbonWindow}`
            ].join('\n') + '\n'
          )
        );
      }
      break;
    default:
      break;
  }

  return actions;
}

function getDiagnosticCode(finding: EnergyFinding): string {
  if (typeof finding.metadata?.diagnosticCode === 'string' && finding.metadata.diagnosticCode.trim()) {
    return finding.metadata.diagnosticCode;
  }

  if (finding.code === 'polling' && finding.metadata?.pollingKind === 'zombie') {
    return 'carbon-zombie-polling';
  }

  switch (finding.code) {
    case 'nested-loop':
      return 'carbon-nested-loop';
    case 'network-in-loop':
      return 'carbon-greedy-io';
    case 'heavy-import':
      return 'carbon-heavy-import';
    case 'payload-reduction':
      return 'carbon-payload-reduction';
    case 'demand-shift':
      return 'carbon-demand-shift';
    case 'simple-dataframe':
      return 'carbon-simple-dataframe';
    default:
      return 'carbon-polling';
  }
}

function getRequestedDiagnosticCode(diagnostic: vscode.Diagnostic): string {
  const rawCode =
    typeof diagnostic.code === 'object' && diagnostic.code !== null && 'value' in diagnostic.code
      ? diagnostic.code.value
      : diagnostic.code;
  return rawCode === undefined || rawCode === null ? '' : String(rawCode);
}

function createCarbonSchedulerAction(document: vscode.TextDocument, finding: EnergyFinding): vscode.CodeAction | undefined {
  const functionDefLine = Number(finding.metadata?.functionDefLine ?? -1);
  const functionName = String(finding.metadata?.functionName ?? '');
  if (functionDefLine < 0 || !functionName) {
    return undefined;
  }

  const action = new vscode.CodeAction(
    "Green Refactor: Wrap with @carbon_scheduler(window='low_intensity')",
    vscode.CodeActionKind.QuickFix
  );
  const edit = new vscode.WorkspaceEdit();

  if (!document.getText().includes('def carbon_scheduler(')) {
    const helperInsertLine = findTopLevelInsertionLine(document);
    const helperBlock =
      [
        'def carbon_scheduler(window="low_intensity"):',
        '    def decorator(fn):',
        '        return fn',
        '    return decorator',
        ''
      ].join('\n') + '\n';
    edit.insert(document.uri, new vscode.Position(helperInsertLine, 0), helperBlock);
  }

  const functionLine = document.lineAt(functionDefLine).text;
  if (!document.lineAt(functionDefLine - 1 < 0 ? 0 : functionDefLine - 1).text.includes('@carbon_scheduler')) {
    const indent = functionLine.match(/^\s*/)?.[0] ?? '';
    edit.insert(document.uri, new vscode.Position(functionDefLine, 0), `${indent}@carbon_scheduler(window="low_intensity")\n`);
  }

  action.edit = edit;
  return action;
}

function createInsertTemplateAction(
  title: string,
  document: vscode.TextDocument,
  position: vscode.Position,
  text: string
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(position.line, 0), text);
  action.edit = edit;
  return action;
}

function createReplaceLineAction(title: string, document: vscode.TextDocument, line: number, text: string): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  const lineText = document.lineAt(line);
  edit.replace(document.uri, new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, lineText.text.length)), text);
  action.edit = edit;
  return action;
}

function createReplaceRangeAction(
  title: string,
  document: vscode.TextDocument,
  range: vscode.Range,
  text: string
): vscode.CodeAction {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, text);
  action.edit = edit;
  return action;
}

function getCommentPrefix(languageId: string): string {
  return languageId === 'python' ? '#' : '//';
}

function findTopLevelInsertionLine(document: vscode.TextDocument): number {
  let insertionLine = 0;
  for (let index = 0; index < document.lineCount; index += 1) {
    const text = document.lineAt(index).text.trim();
    if (!text) {
      continue;
    }

    if (/^(import|from)\b/.test(text)) {
      insertionLine = index + 1;
      continue;
    }

    break;
  }

  return insertionLine;
}

function dedupeActions(actions: vscode.CodeAction[]): vscode.CodeAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.title)) {
      return false;
    }

    seen.add(action.title);
    return true;
  });
}

function collapseOverlappingFindings(findings: EnergyFinding[]): EnergyFinding[] {
  const priority: Record<EnergyFinding['code'], number> = {
    polling: 5,
    'nested-loop': 4,
    'network-in-loop': 3,
    'payload-reduction': 2,
    'heavy-import': 1,
    'simple-dataframe': 1,
    'demand-shift': 1
  };

  return findings
    .slice()
    .sort((left, right) => {
      const priorityDelta = (priority[right.code] ?? 0) - (priority[left.code] ?? 0);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }

      return getRangeSpan(right.range) - getRangeSpan(left.range);
    })
    .filter((finding, index, sorted) => {
      return !sorted.slice(0, index).some((candidate) => {
        if (candidate.code === finding.code) {
          return containsRange(candidate.range, finding.range) || rangesOverlap(candidate.range, finding.range);
        }

        if (candidate.code === 'polling' && finding.code === 'network-in-loop') {
          return rangesOverlap(candidate.range, finding.range);
        }

        return false;
      });
    });
}

function getRangeSpan(range: vscode.Range): number {
  return (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character);
}

function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
  return (
    outer.start.isBeforeOrEqual(inner.start) &&
    outer.end.isAfterOrEqual(inner.end) &&
    !(outer.start.isEqual(inner.start) && outer.end.isEqual(inner.end))
  );
}

function rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
  return left.intersection(right) !== undefined;
}

function readVariableName(
  value: string | number | boolean | string[] | undefined,
  languageId: string,
  scopeVariables: string[]
): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (scopeVariables.length > 0) {
    return scopeVariables[0];
  }

  return languageId === 'python' ? 'your_data_variable' : 'yourDataVariable';
}

function createNativePythonMaxAction(document: vscode.TextDocument, finding: EnergyFinding): vscode.CodeAction | undefined {
  const alias = String(finding.metadata?.importAlias ?? '').trim();
  if (!alias) {
    return undefined;
  }

  const action = new vscode.CodeAction('Green Refactor: Replace numpy max() with native max()', vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  const importLine = document.lineAt(finding.range.start.line);
  edit.replace(document.uri, importLine.rangeIncludingLineBreak, '');

  const pattern = new RegExp(`\\b${escapeRegex(alias)}\\.max\\s*\\(`, 'g');
  for (const match of document.getText().matchAll(pattern)) {
    const start = document.positionAt(match.index ?? 0);
    const end = document.positionAt((match.index ?? 0) + match[0].length);
    edit.replace(document.uri, new vscode.Range(start, end), 'max(');
  }

  action.edit = edit;
  return action;
}

function resolvePythonPayloadVariable(document: vscode.TextDocument, line: number): string {
  for (let index = Math.max(0, line - 3); index <= line; index += 1) {
    const text = document.lineAt(index).text;
    const match = text.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*\{/);
    if (match) {
      return match[1];
    }
  }

  return 'payload';
}

function readScopeVariables(value: string | number | boolean | string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function buildPythonLoopReplacement(
  document: vscode.TextDocument,
  range: vscode.Range,
  context: {
    primaryCollection: string;
    secondaryCollection: string;
    primaryItem: string;
    secondaryItem: string;
    scopeVariables: string[];
  }
): string {
  const indent = document.lineAt(range.start.line).text.match(/^\s*/)?.[0] ?? '';

  return [
    `${indent}${context.secondaryCollection}_lookup = {${context.secondaryItem}: ${context.secondaryItem} for ${context.secondaryItem} in ${context.secondaryCollection}}`,
    `${indent}optimized_records = [{"${context.primaryItem}": ${context.secondaryCollection}_lookup.get(${context.primaryItem})} for ${context.primaryItem} in ${context.primaryCollection}]`
  ].join('\n');
}

function buildPythonChunkedBatchReplacement(
  document: vscode.TextDocument,
  range: vscode.Range,
  scopeVariables: string[]
): string | undefined {
  const indent = document.lineAt(range.start.line).text.match(/^\s*/)?.[0] ?? '';
  const blockText = document.getText(range);
  const hasItertools = document.getText().includes('import itertools');
  const hasChunkHelper = document.getText().includes('def chunked_iterable(');
  const extracted = extractPythonBatchRefactor(document, range, scopeVariables);
  if (!extracted) {
    return undefined;
  }

  return [
    ...(hasItertools ? [] : [`${indent}import itertools`]),
    ...(hasChunkHelper ? [] : buildPythonChunkHelper(indent)),
    `${indent}# Stream loop matches into bounded request batches`,
    ...extracted.generatorLines,
    `${indent}for batch in chunked_iterable(work_items, 100):`,
    `${indent}    payload_batch = []`,
    `${indent}    for ${extracted.unpackTarget} in batch:`,
    ...extracted.payloadBodyLines.map((line) => `${indent}        ${line}`),
    `${indent}        payload_batch.append(${extracted.payloadVariable})`,
    `${indent}    if payload_batch:`,
    `${indent}        requests.post(${extracted.postUrl}, json=payload_batch, headers={"Content-Encoding": "gzip"})`
  ].join('\n');
}

function buildPythonAsyncioReplacement(
  document: vscode.TextDocument,
  range: vscode.Range,
  scopeVariables: string[]
): string | undefined {
  const indent = document.lineAt(range.start.line).text.match(/^\s*/)?.[0] ?? '';
  const hasAsyncio = document.getText().includes('import asyncio');
  const hasAiohttp = document.getText().includes('import aiohttp');
  const hasItertools = document.getText().includes('import itertools');
  const hasChunkHelper = document.getText().includes('def chunked_iterable(');
  const extracted = extractPythonBatchRefactor(document, range, scopeVariables);
  if (!extracted) {
    return undefined;
  }
  const importPrelude = [
    ...(hasAsyncio ? [] : [`${indent}import asyncio`]),
    ...(hasItertools ? [] : [`${indent}import itertools`]),
    ...(hasAiohttp ? [] : [`${indent}import aiohttp`])
  ];

  return [
    ...importPrelude,
    ...(hasChunkHelper ? [] : buildPythonChunkHelper(indent)),
    `${indent}# Stream loop matches into bounded async request batches`,
    ...extracted.generatorLines,
    `${indent}async def post_payload_batch(session, payload_batch):`,
    `${indent}    async with session.post(${extracted.postUrl}, json=payload_batch, headers={"Content-Encoding": "gzip"}) as response:`,
    `${indent}        await response.read()`,
    `${indent}async def send_payload_batches():`,
    `${indent}    async with aiohttp.ClientSession() as session:`,
    `${indent}        for batch in chunked_iterable(work_items, 100):`,
    `${indent}            payload_batch = []`,
    `${indent}            for ${extracted.unpackTarget} in batch:`,
    ...extracted.payloadBodyLines.map((line) => `${indent}                ${line}`),
    `${indent}                payload_batch.append(${extracted.payloadVariable})`,
    `${indent}            if payload_batch:`,
    `${indent}                await post_payload_batch(session, payload_batch)`,
    `${indent}asyncio.run(send_payload_batches())`
  ].join('\n');
}

function extractPythonPayloadLiteral(blockText: string, payloadVariable: string): string {
  const payloadStart = blockText.indexOf(`${payloadVariable} = {`);
  if (payloadStart < 0) {
    return '{}';
  }

  const braceStart = blockText.indexOf('{', payloadStart);
  if (braceStart < 0) {
    return '{}';
  }

  let depth = 0;
  for (let index = braceStart; index < blockText.length; index += 1) {
    const char = blockText[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return blockText.slice(braceStart, index + 1);
      }
    }
  }

  return '{}';
}

function extractPythonBatchRefactor(
  document: vscode.TextDocument,
  range: vscode.Range,
  scopeVariables: string[]
):
  | {
      generatorLines: string[];
      unpackTarget: string;
      payloadBodyLines: string[];
      payloadVariable: string;
      postUrl: string;
    }
  | undefined {
  const indent = document.lineAt(range.start.line).text.match(/^\s*/)?.[0] ?? '';
  const blockText = document.getText(range);
  const parsed = parsePythonLoopStructure(blockText);
  if (!parsed) {
    return undefined;
  }

  const requestLine = parsed.bodyLines.find((line) => /requests\.(post|put|patch)\(/.test(line.trim()));
  if (!requestLine) {
    return undefined;
  }

  const requestIndex = parsed.bodyLines.indexOf(requestLine);
  const payloadBodyLines = parsed.bodyLines
    .slice(0, requestIndex)
    .filter((line) => line.trim().length > 0);
  const trailingLines = parsed.bodyLines.slice(requestIndex + 1).filter((line) => line.trim().length > 0);
  if (payloadBodyLines.length === 0 || trailingLines.length > 0) {
    return undefined;
  }

  if (payloadBodyLines.some((line) => /^\s*for\s+/.test(line.trim()))) {
    return undefined;
  }

  const payloadVariableMatch = requestLine.match(/\b(?:json|data)\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (!payloadVariableMatch) {
    return undefined;
  }

  const loopVariables = parsed.loopHeaders.map((loop) => loop.item).filter((item): item is string => Boolean(item));
  if (loopVariables.length === 0) {
    return undefined;
  }

  const postUrl = extractPythonRequestUrl(requestLine.trim());
  const generatorLines = buildPythonGeneratorLines(
    indent,
    loopVariables,
    parsed.loopHeaders,
    parsed.conditions,
    scopeVariables
  );

  return {
    generatorLines,
    unpackTarget: loopVariables.length === 1 ? loopVariables[0] : loopVariables.join(', '),
    payloadBodyLines: dedentLines(payloadBodyLines),
    payloadVariable: payloadVariableMatch[1],
    postUrl
  };
}

function buildPythonChunkHelper(indent: string): string[] {
  return [
    `${indent}def chunked_iterable(iterable, size):`,
    `${indent}    iterator = iter(iterable)`,
    `${indent}    while True:`,
    `${indent}        chunk = tuple(itertools.islice(iterator, size))`,
    `${indent}        if not chunk:`,
    `${indent}            break`,
    `${indent}        yield chunk`
  ];
}

function buildPythonGeneratorLines(
  indent: string,
  loopVariables: string[],
  loops: Array<{ item: string; collection: string }>,
  conditions: string[],
  scopeVariables: string[]
): string[] {
  const loopLines =
    loops.length > 0
      ? loops
      : scopeVariables.length > 0
        ? [{ item: 'item', collection: scopeVariables[0] }]
        : [{ item: 'item', collection: 'your_data_variable' }];
  const tupleExpression =
    loopVariables.length === 1 ? loopVariables[0] : `(${loopVariables.join(', ')})`;

  return [
    `${indent}work_items = (`,
    `${indent}    ${tupleExpression}`,
    ...loopLines.map((loop) => `${indent}    for ${loop.item} in ${loop.collection}`),
    ...conditions.map((condition) => `${indent}    if ${condition}`),
    `${indent})`
  ];
}

function dedentLines(lines: string[]): string[] {
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (nonEmptyLines.length === 0) {
    return [];
  }

  const minIndent = nonEmptyLines.reduce((smallest, line) => {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    return Math.min(smallest, indent);
  }, Number.POSITIVE_INFINITY);

  return lines.map((line) => line.slice(Math.min(minIndent, line.length)));
}

function createPythonPollingSleepAction(
  document: vscode.TextDocument,
  range: vscode.Range
): vscode.CodeAction | undefined {
  const resolvedRange = resolvePythonWhileBlockRange(document, range.start.line);
  if (!resolvedRange) {
    return undefined;
  }

  const loopLineText = document.lineAt(resolvedRange.start.line).text;
  if (!/^while\s+(True|1)\b/.test(loopLineText.trim())) {
    return undefined;
  }

  const loopIndent = loopLineText.match(/^\s*/)?.[0] ?? '';
  const bodyIndent = `${loopIndent}    `;
  const isAsync = isInsideAsyncPythonFunction(document, range.start.line);
  const action = new vscode.CodeAction('Green Refactor: Add exponential backoff', vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  const sleepStatement = isAsync ? `${bodyIndent}await asyncio.sleep(2)\n` : `${bodyIndent}time.sleep(2)\n`;
  const insertPosition = new vscode.Position(
    resolvedRange.end.line,
    document.lineAt(resolvedRange.end.line).text.length
  );

  if (isAsync) {
    if (!document.getText().includes('import asyncio')) {
      edit.insert(document.uri, new vscode.Position(findTopLevelInsertionLine(document), 0), 'import asyncio\n');
    }
  } else if (!document.getText().includes('import time')) {
    edit.insert(document.uri, new vscode.Position(findTopLevelInsertionLine(document), 0), 'import time\n');
  }

  edit.insert(document.uri, insertPosition, `\n${sleepStatement}`);
  action.edit = edit;
  return action;
}

function createPythonBatchingExampleComment(
  document: vscode.TextDocument,
  line: number,
  scopeVariables: string[]
): vscode.CodeAction {
  const indent = document.lineAt(line).text.match(/^\s*/)?.[0] ?? '';
  const collection = scopeVariables[0] ?? 'your_data_variable';
  return createInsertTemplateAction(
    'Green Refactor: Batching Example Comment',
    document,
    new vscode.Position(line, 0),
    [
      `${indent}# Carbon Coder batching example:`,
      `${indent}# for batch in chunked_iterable(${collection}, 100):`,
      `${indent}#     send_batch(batch)`
    ].join('\n') + '\n'
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInsideAsyncPythonFunction(document: vscode.TextDocument, line: number): boolean {
  for (let index = line; index >= 0; index -= 1) {
    const text = document.lineAt(index).text.trim();
    if (/^async\s+def\b/.test(text)) {
      return true;
    }

    if (/^(def|class)\b/.test(text)) {
      return false;
    }
  }

  return false;
}

function resolvePythonWhileBlockRange(document: vscode.TextDocument, line: number): vscode.Range | undefined {
  for (let cursor = line; cursor >= 0; cursor -= 1) {
    const candidate = document.lineAt(cursor).text;
    if (/^\s*while\s+(True|1)\b/.test(candidate.trim())) {
      const startIndent = candidate.length - candidate.trimStart().length;
      let endLine = cursor;

      for (let index = cursor + 1; index < document.lineCount; index += 1) {
        const text = document.lineAt(index).text;
        if (!text.trim()) {
          endLine = index;
          continue;
        }

        const indent = text.length - text.trimStart().length;
        if (indent <= startIndent) {
          break;
        }

        endLine = index;
      }

      return new vscode.Range(
        new vscode.Position(cursor, 0),
        new vscode.Position(endLine, document.lineAt(endLine).text.length)
      );
    }

    if (/^(async\s+def|def|class)\b/.test(candidate.trim())) {
      break;
    }
  }

  return undefined;
}

function extractPythonRequestUrl(blockText: string): string {
  const match = blockText.match(/requests\.(post|put|patch)\(\s*(['"][^'"]+['"])/);
  return match?.[2] ?? '"https://your-api-endpoint/batch"';
}

function extractPythonLoopStack(blockText: string): Array<{ item: string; collection: string }> {
  return blockText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*:/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({
      item: match[1],
      collection: match[2]
    }));
}

function parsePythonLoopStructure(
  blockText: string
):
  | {
      loopHeaders: Array<{ item: string; collection: string }>;
      conditions: string[];
      bodyLines: string[];
    }
  | undefined {
  const rawLines = blockText.split(/\r?\n/);
  const lines = rawLines.filter((line, index) => !(index === rawLines.length - 1 && line.trim() === ''));
  if (lines.length === 0) {
    return undefined;
  }

  const baseIndent = lines[0].match(/^\s*/)?.[0].length ?? 0;
  const loopHeaders: Array<{ item: string; collection: string }> = [];
  const conditions: string[] = [];
  let bodyStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    if (index === 0) {
      const firstLoop = trimmed.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+(.+):$/);
      if (!firstLoop) {
        return undefined;
      }

      loopHeaders.push({ item: firstLoop[1], collection: sanitizeLoopCollection(firstLoop[2]) });
      continue;
    }

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= baseIndent) {
      break;
    }

    const loopMatch = trimmed.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+(.+):$/);
    if (loopMatch) {
      loopHeaders.push({ item: loopMatch[1], collection: sanitizeLoopCollection(loopMatch[2]) });
      continue;
    }

    const ifMatch = trimmed.match(/^if\s+(.+):$/);
    if (ifMatch) {
      conditions.push(ifMatch[1]);
      continue;
    }

    bodyStart = index;
    break;
  }

  if (bodyStart < 0) {
    return undefined;
  }

  return {
    loopHeaders,
    conditions,
    bodyLines: lines.slice(bodyStart)
  };
}

function sanitizeLoopCollection(value: string): string {
  return value.trim().replace(/:$/, '');
}
