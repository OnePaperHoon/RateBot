import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

/**
 * CLI 출력/입력 헬퍼.
 *
 * 의존성을 늘리지 않기 위해 Node 내장 readline 만 사용한다.
 * TTY 가 아니면 색상을 끄고, 프롬프트 대신 기본값을 사용한다.
 */

const useColor = stdout.isTTY === true && process.env.NO_COLOR === undefined;

const wrap = (code: string) => (text: string) => (useColor ? `[${code}m${text}[0m` : text);

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
};

export function print(message = ''): void {
  stdout.write(`${message}\n`);
}

export function heading(title: string): void {
  const line = '─'.repeat(Math.max(4, Math.min(64, title.length + 4)));
  print();
  print(color.cyan(line));
  print(color.cyan(color.bold(`  ${title}`)));
  print(color.cyan(line));
}

export function ok(message: string): void {
  print(`${color.green('✓')} ${message}`);
}

export function fail(message: string): void {
  print(`${color.red('✗')} ${message}`);
}

export function warn(message: string): void {
  print(`${color.yellow('!')} ${message}`);
}

export function info(message: string): void {
  print(`${color.blue('·')} ${message}`);
}

/** key: value 형태의 정렬된 표. */
export function table(rows: ReadonlyArray<readonly [string, string]>, indent = '  '): void {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of rows) {
    print(`${indent}${color.dim(key.padEnd(width))}  ${value}`);
  }
}

export interface Prompter {
  ask(question: string, defaultValue?: string): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  select(question: string, choices: readonly string[]): Promise<number>;
  close(): void;
}

export function createPrompter(): Prompter {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const interactive = stdin.isTTY === true;

  return {
    async ask(question, defaultValue = '') {
      if (!interactive) return defaultValue;
      const suffix = defaultValue === '' ? '' : color.dim(` [${defaultValue}]`);
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer === '' ? defaultValue : answer;
    },

    async confirm(question, defaultValue = false) {
      if (!interactive) return defaultValue;
      const hint = defaultValue ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} ${color.dim(`(${hint})`)} `))
        .trim()
        .toLowerCase();
      if (answer === '') return defaultValue;
      return answer === 'y' || answer === 'yes';
    },

    async select(question, choices) {
      if (!interactive) return -1;
      print();
      print(color.bold(question));
      choices.forEach((choice, index) => {
        print(`  ${color.cyan(String(index).padStart(2))}. ${choice}`);
      });
      const answer = (await rl.question('\n선택> ')).trim();
      const index = Number(answer);
      return Number.isInteger(index) && index >= 0 && index < choices.length ? index : -1;
    },

    close() {
      rl.close();
    },
  };
}

/** 값을 보여줄 때 비밀정보를 가린다. */
export function maskValue(key: string, value: string): string {
  if (value === '') return color.dim('(비어 있음)');
  const isSecret = /TOKEN|SECRET|KEY|PASSWORD/i.test(key);
  if (!isSecret) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}${'*'.repeat(8)} ${color.dim(`(${value.length}자)`)}`;
}
