/**
 * In-Memory Firestore adapter.
 *
 * Emulates the subset of the Cloud Firestore API used by this service
 * (collections, documents, where/limit/orderBy queries) so that `npm test`
 * and local mock-mode runs work 100% offline without credentials.
 */

export type MockFieldValue = unknown;
export type MockDocumentData = Record<string, MockFieldValue>;

export type MockWhereFilterOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';

export interface MockSetOptions {
  merge?: boolean;
}

let autoIdCounter = 0;

function generateAutoId(): string {
  autoIdCounter += 1;
  const random = Math.random().toString(36).substring(2, 10);
  return `mock_${Date.now().toString(36)}_${random}${autoIdCounter.toString(36)}`;
}

function isTransform(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    ('operand' in value || Boolean((value as { constructor?: { name?: string } }).constructor?.name?.includes('Increment')))
  );
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (isTransform(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  const clone: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = deepClone(val);
  }
  return clone as T;
}

/** Firestore rejects `undefined` field values - mirror that by stripping them. */
export function stripUndefinedFields(data: MockDocumentData): MockDocumentData {
  const cleaned: MockDocumentData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isTransform(value)) {
      cleaned[key] = value;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      cleaned[key] = stripUndefinedFields(value as MockDocumentData);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function applyFieldTransforms(incoming: MockDocumentData, existing: MockDocumentData): MockDocumentData {
  const resolved: MockDocumentData = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (isTransform(value)) {
      const operand = Number((value as { operand: unknown }).operand);
      const prev = Number(existing[key] ?? 0);
      resolved[key] = (Number.isNaN(prev) ? 0 : prev) + (Number.isNaN(operand) ? 0 : operand);
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

// Numbers compare numerically; ISO 8601 UTC strings compare chronologically
// as plain strings, so range queries (`<`, `<=`) work on both kinds of fields.
function lessThan(actual: MockFieldValue, expected: MockFieldValue, inclusive: boolean): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return inclusive ? actual <= expected : actual < expected;
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return inclusive ? actual <= expected : actual < expected;
  }
  return false;
}

function greaterThan(actual: MockFieldValue, expected: MockFieldValue, inclusive: boolean): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return inclusive ? actual >= expected : actual > expected;
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    return inclusive ? actual >= expected : actual > expected;
  }
  return false;
}

function matchesOp(actual: MockFieldValue, op: MockWhereFilterOp, expected: MockFieldValue): boolean {
  switch (op) {
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
    case '<':
      return lessThan(actual, expected, false);
    case '<=':
      return lessThan(actual, expected, true);
    case '>':
      return greaterThan(actual, expected, false);
    case '>=':
      return greaterThan(actual, expected, true);
    case 'in':
      return Array.isArray(expected) && expected.includes(actual);
    case 'array-contains':
      return Array.isArray(actual) && actual.includes(expected);
    default:
      return false;
  }
}

function getField(data: MockDocumentData, fieldPath: string): MockFieldValue {
  return fieldPath.split('.').reduce<MockFieldValue>((acc, key) => {
    if (acc !== null && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as MockDocumentData)[key];
    }
    return undefined;
  }, data as MockFieldValue);
}

export class MockDocumentSnapshot {
  constructor(
    public readonly id: string,
    public readonly ref: MockDocumentReference,
    private readonly dataOrNull: MockDocumentData | null
  ) {}

  public get exists(): boolean {
    return this.dataOrNull !== null;
  }

  public data(): MockDocumentData | undefined {
    return this.dataOrNull ? deepClone(this.dataOrNull) : undefined;
  }

  /** Mirrors admin.firestore.DocumentSnapshot.get(fieldPath). */
  public get(fieldPath: string): MockFieldValue {
    return getField(this.dataOrNull ?? {}, fieldPath);
  }
}

export class MockQuerySnapshot {
  constructor(public readonly docs: MockDocumentSnapshot[]) {}

  public get empty(): boolean {
    return this.docs.length === 0;
  }

  public get size(): number {
    return this.docs.length;
  }
}

interface QueryConstraint {
  type: 'where';
  field: string;
  op: MockWhereFilterOp;
  value: MockFieldValue;
}

export class MockQuery {
  constructor(
    protected readonly store: Map<string, MockDocumentData>,
    private readonly constraints: QueryConstraint[] = [],
    private readonly limitCount: number | null = null
  ) {}

  public where(field: string, op: MockWhereFilterOp, value: MockFieldValue): MockQuery {
    return new MockQuery(this.store, [...this.constraints, { type: 'where', field, op, value }], this.limitCount);
  }

  public limit(count: number): MockQuery {
    return new MockQuery(this.store, this.constraints, count);
  }

  public async get(): Promise<MockQuerySnapshot> {
    const entries = Array.from(this.store.entries());
    let snapshots = entries.map(
      ([id, data]) => new MockDocumentSnapshot(id, new MockDocumentReference(id, this.store), deepClone(data))
    );

    for (const constraint of this.constraints) {
      snapshots = snapshots.filter((snapshot) => {
        const actual = getField(snapshot.data() ?? {}, constraint.field);
        return matchesOp(actual, constraint.op, constraint.value);
      });
    }

    if (this.limitCount !== null) {
      snapshots = snapshots.slice(0, this.limitCount);
    }

    return new MockQuerySnapshot(snapshots);
  }
}

export class MockDocumentReference {
  constructor(
    public readonly id: string,
    private readonly store: Map<string, MockDocumentData>
  ) {}

  public async get(): Promise<MockDocumentSnapshot> {
    const data = this.store.get(this.id);
    return new MockDocumentSnapshot(this.id, this, data ? deepClone(data) : null);
  }

  public async set(data: MockDocumentData, options?: MockSetOptions): Promise<void> {
    const existing = this.store.get(this.id) ?? {};
    const transformed = applyFieldTransforms(data, existing);
    const cleaned = stripUndefinedFields(deepClone(transformed));
    if (options?.merge) {
      this.store.set(this.id, { ...existing, ...cleaned });
    } else {
      this.store.set(this.id, cleaned);
    }
  }

  public async update(data: MockDocumentData): Promise<void> {
    if (!this.store.has(this.id)) {
      const error = new Error(`No document to update: ${this.id}`) as Error & { code: string };
      error.code = 'not-found';
      throw error;
    }
    const existing = this.store.get(this.id) ?? {};
    const transformed = applyFieldTransforms(data, existing);
    const cleaned = stripUndefinedFields(deepClone(transformed));
    this.store.set(this.id, { ...existing, ...cleaned });
  }

  public async delete(): Promise<void> {
    this.store.delete(this.id);
  }
}

export class MockCollectionReference extends MockQuery {
  constructor(
    public readonly id: string,
    store: Map<string, MockDocumentData>
  ) {
    super(store);
  }

  public doc(docId?: string): MockDocumentReference {
    const id = docId ?? generateAutoId();
    return new MockDocumentReference(id, this.store);
  }

  public async add(data: MockDocumentData): Promise<MockDocumentReference> {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

/**
 * Buffered-Write transaction.
 *
 * Reads see the pre-transaction state; writes are buffered and applied
 * sequentially after the update function resolves. This mirrors Firestore's
 * isolation guarantee closely enough for the in-memory adapter (Node's
 * single-threaded event loop already serializes concurrent transactions).
 */
export class MockTransaction {
  private readonly operations: Array<() => Promise<void>> = [];

  public async get(ref: MockDocumentReference | MockQuery): Promise<MockDocumentSnapshot | MockQuerySnapshot> {
    if (this.operations.length > 0) {
      throw new Error('Firestore transactions require all reads to be executed before all writes');
    }
    return ref.get();
  }

  public update(ref: MockDocumentReference, data: MockDocumentData): MockTransaction {
    this.operations.push(() => ref.update(data));
    return this;
  }

  public set(ref: MockDocumentReference, data: MockDocumentData, options?: MockSetOptions): MockTransaction {
    this.operations.push(() => ref.set(data, options));
    return this;
  }

  public delete(ref: MockDocumentReference): MockTransaction {
    this.operations.push(() => ref.delete());
    return this;
  }

  public async commit(): Promise<void> {
    for (const operation of this.operations) {
      await operation();
    }
  }
}

export class MockFirestore {
  private readonly collections = new Map<string, Map<string, MockDocumentData>>();
  // Firestore runs transactions in isolation: serialize them so a later
  // transaction's reads always observe an earlier one's committed writes.
  private transactionChain: Promise<unknown> = Promise.resolve();

  public collection(name: string): MockCollectionReference {
    let store = this.collections.get(name);
    if (!store) {
      store = new Map<string, MockDocumentData>();
      this.collections.set(name, store);
    }
    return new MockCollectionReference(name, store);
  }

  public async runTransaction<T>(updateFunction: (tx: MockTransaction) => Promise<T>): Promise<T> {
    const run = this.transactionChain.then(async () => {
      const tx = new MockTransaction();
      const result = await updateFunction(tx);
      await tx.commit();
      return result;
    });
    // Keep the chain alive even when a transaction rejects
    this.transactionChain = run.catch(() => undefined);
    return run;
  }

  /** Wipes every collection - used by test setup via services' clearAll(). */
  public reset(): void {
    for (const store of this.collections.values()) {
      store.clear();
    }
  }
}

export const mockFirestore = new MockFirestore();
