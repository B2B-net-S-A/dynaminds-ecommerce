export class Problem extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export function ensure(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new Problem(status, message);
}
