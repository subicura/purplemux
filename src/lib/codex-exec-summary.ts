const MAX_INPUT_SCAN_LENGTH = 65_536;
const MAX_COMMAND_COUNT = 8;
const MAX_COMMAND_LENGTH = 600;
const MAX_FALLBACK_LENGTH = 320;

interface IStringLiteralResult {
  value: string;
  end: number;
}

interface IExecCommandExtraction {
  commands: string[];
  commandCallCount: number;
  nestedToolNames: string[];
  inputTruncated: boolean;
}

export interface ICodexExecSummary {
  toolName: 'Bash' | 'exec';
  summary: string;
}

const isIdentifierStart = (char: string | undefined): boolean =>
  Boolean(char && /[A-Za-z_$]/.test(char));

const isIdentifierPart = (char: string | undefined): boolean =>
  Boolean(char && /[A-Za-z0-9_$]/.test(char));

const readIdentifier = (source: string, start: number, end: number): { value: string; end: number } => {
  let index = start;
  while (index < end && isIdentifierPart(source[index])) index++;
  return { value: source.slice(start, index), end: index };
};

const decodeEscape = (
  source: string,
  index: number,
  end: number,
): { value: string; end: number } => {
  const char = source[index];
  const simpleEscapes: Record<string, string> = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '0': '\0',
  };
  if (char in simpleEscapes) return { value: simpleEscapes[char], end: index + 1 };
  if (char === '\n') return { value: '', end: index + 1 };
  if (char === '\r' && source[index + 1] === '\n') return { value: '', end: index + 2 };

  if (char === 'x') {
    const hex = source.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: index + 3 };
    }
  }

  if (char === 'u') {
    if (source[index + 1] === '{') {
      const close = source.indexOf('}', index + 2);
      if (close !== -1 && close < end) {
        const hex = source.slice(index + 2, close);
        if (/^[0-9A-Fa-f]{1,6}$/.test(hex)) {
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint <= 0x10ffff) {
            return { value: String.fromCodePoint(codePoint), end: close + 1 };
          }
        }
      }
    } else {
      const hex = source.slice(index + 1, index + 5);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        return { value: String.fromCodePoint(Number.parseInt(hex, 16)), end: index + 5 };
      }
    }
  }

  return { value: char ?? '', end: Math.min(index + 1, end) };
};

const readStringLiteral = (
  source: string,
  start: number,
  end: number,
): IStringLiteralResult => {
  const quote = source[start];
  let index = start + 1;
  let value = '';
  while (index < end) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (char === '\\') {
      const escaped = decodeEscape(source, index + 1, end);
      value += escaped.value;
      index = escaped.end;
      continue;
    }
    value += char;
    index++;
  }
  return { value, end };
};

const skipTrivia = (source: string, start: number, end: number): number => {
  let index = start;
  while (index < end) {
    if (/\s/.test(source[index])) {
      index++;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 || newline >= end ? end : newline + 1;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 || close + 2 >= end ? end : close + 2;
      continue;
    }
    break;
  }
  return index;
};

const readObjectStringProperty = (
  source: string,
  objectStart: number,
  propertyName: string,
  end: number,
): string | undefined => {
  let index = objectStart;
  let depth = 0;
  while (index < end) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 || newline >= end ? end : newline + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 || close + 2 >= end ? end : close + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const literal = readStringLiteral(source, index, end);
      if (depth === 1 && literal.value === propertyName) {
        const colon = skipTrivia(source, literal.end, end);
        if (source[colon] === ':') {
          const valueStart = skipTrivia(source, colon + 1, end);
          if (source[valueStart] === '\'' || source[valueStart] === '"' || source[valueStart] === '`') {
            return readStringLiteral(source, valueStart, end).value;
          }
          return undefined;
        }
      }
      index = literal.end;
      continue;
    }
    if (char === '{') {
      depth++;
      index++;
      continue;
    }
    if (char === '}') {
      depth--;
      if (depth === 0) return undefined;
      index++;
      continue;
    }
    if (depth === 1 && isIdentifierStart(char)) {
      const identifier = readIdentifier(source, index, end);
      if (identifier.value === propertyName) {
        const colon = skipTrivia(source, identifier.end, end);
        if (source[colon] === ':') {
          const valueStart = skipTrivia(source, colon + 1, end);
          if (source[valueStart] === '\'' || source[valueStart] === '"' || source[valueStart] === '`') {
            return readStringLiteral(source, valueStart, end).value;
          }
          return undefined;
        }
      }
      index = identifier.end;
      continue;
    }
    index++;
  }
  return undefined;
};

const extractExecCommands = (input: string): IExecCommandExtraction => {
  const scanLength = Math.min(input.length, MAX_INPUT_SCAN_LENGTH);
  const source = input.slice(0, scanLength);
  const commands: string[] = [];
  const nestedToolNames: string[] = [];
  let commandCallCount = 0;
  let index = 0;

  while (index < scanLength) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      index = newline === -1 ? scanLength : newline + 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      index = close === -1 ? scanLength : close + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      index = readStringLiteral(source, index, scanLength).end;
      continue;
    }
    if (
      source.startsWith('tools.', index) &&
      !isIdentifierPart(source[index - 1])
    ) {
      const nameStart = index + 'tools.'.length;
      if (isIdentifierStart(source[nameStart])) {
        const identifier = readIdentifier(source, nameStart, scanLength);
        const toolName = identifier.value;
        if (!nestedToolNames.includes(toolName) && nestedToolNames.length < MAX_COMMAND_COUNT) {
          nestedToolNames.push(toolName);
        }
        if (toolName === 'exec_command') {
          commandCallCount++;
          const openParen = skipTrivia(source, identifier.end, scanLength);
          const objectStart = openParen < scanLength && source[openParen] === '('
            ? skipTrivia(source, openParen + 1, scanLength)
            : scanLength;
          if (source[objectStart] === '{') {
            const command = readObjectStringProperty(source, objectStart, 'cmd', scanLength);
            if (command?.trim() && commands.length < MAX_COMMAND_COUNT) commands.push(command);
          }
        }
        index = identifier.end;
        continue;
      }
    }
    index++;
  }

  return {
    commands,
    commandCallCount,
    nestedToolNames,
    inputTruncated: input.length > scanLength,
  };
};

const compact = (value: string, limit: number): string => {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
};

export const summarizeCodexExecInput = (input: string): ICodexExecSummary => {
  const extraction = extractExecCommands(input);
  if (extraction.commands.length > 0) {
    const lines = extraction.commands.map((command) => `$ ${compact(command, MAX_COMMAND_LENGTH)}`);
    const omittedCount = extraction.commandCallCount - extraction.commands.length;
    if (omittedCount > 0) lines.push(`… ${omittedCount} dynamic or omitted command${omittedCount === 1 ? '' : 's'}`);
    if (extraction.inputTruncated) lines.push('… exec input scan truncated');
    return { toolName: 'Bash', summary: lines.join('\n') };
  }

  const fallback = compact(input, MAX_FALLBACK_LENGTH);
  if (extraction.commandCallCount > 0) {
    return {
      toolName: 'Bash',
      summary: fallback ? `exec_command (dynamic)\n${fallback}` : 'exec_command (dynamic)',
    };
  }

  const nested = extraction.nestedToolNames.length > 0
    ? ` → ${extraction.nestedToolNames.join(', ')}`
    : '';
  return {
    toolName: 'exec',
    summary: `exec${nested}${!nested && fallback ? ` ${fallback}` : ''}`,
  };
};
